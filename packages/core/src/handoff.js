import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  EXECUTOR_DESCRIPTOR_SCHEMA,
  HANDOFF_INTERACTION_SCHEMA,
  HANDOFF_PACKAGE_SCHEMA,
  TASK_GRAPH_SCHEMA,
  assertValidExecutorDescriptor,
  assertValidExecutionReceipt,
  assertValidHandoffInteraction,
  assertValidHandoffPackage,
  assertValidTaskGraph,
} from "@launchrally/contracts";

import { sha256 } from "./local-history.js";
import { mapTaskGraphExecutors } from "./task-graph.js";

const require = createRequire(import.meta.url);
const executorInstallationAuthorities = require("../executor-installation/v1/authority.json");
const INSTALLATION_AUTHORITY_BY_ID = new Map(executorInstallationAuthorities.map((authority) => [
  authority.authority_id,
  Object.freeze(authority),
]));
const CORE_EXECUTOR_DESCRIPTOR_DIGESTS = new Map();
const STATE_TOKEN = /^lrhandoff_([A-Za-z0-9]{6}|[A-Za-z0-9]{12})_([A-Za-z0-9_-]{43})$/u;

const SAFETY = Object.freeze({
  installation_executed: false,
  login_initiated: false,
  credentials_requested: false,
  external_task_executed: false,
  authority_granted: false,
});

function reference(id, schemaVersion, value) {
  return { id, schema_version: schemaVersion, digest: sha256(value) };
}

function referencesEqual(left, right) {
  return left?.id === right?.id
    && left?.schema_version === right?.schema_version
    && left?.digest === right?.digest;
}

function authorityDescription(task) {
  return `An external Executor could perform ${task.allowed_effects.join(", ")} on ${task.expected_target} only after explicit confirmation.`;
}

function visibleEffect(task) {
  return `The external Executor may perform ${task.allowed_effects.join(", ")} on ${task.expected_target}.`;
}

function now(dependencies) {
  return typeof dependencies.now === "function"
    ? dependencies.now()
    : dependencies.now ?? new Date().toISOString();
}

function trustIsCurrent(trust, assessmentTime) {
  const assessedAt = Date.parse(assessmentTime);
  return Number.isFinite(assessedAt)
    && Date.parse(trust.reviewed_at) <= assessedAt
    && assessedAt <= Date.parse(trust.expires_at);
}

function recoveryFor(state, includeInstructions = false, assessmentTime = state.assessment_time) {
  const candidate = state.candidates.find(({ recommended }) => recommended)
    ?? state.candidates[0];
  const descriptor = state.executor_descriptors.find(({ descriptor_id: id }) =>
    id === candidate?.executor_id);
  const observations = new Map(state.tool_observations.map((observation) => [
    observation.tool_id,
    observation,
  ]));
  const tool = descriptor?.tools.find((requiredTool) => {
    const observation = observations.get(requiredTool.tool_id);
    return observation?.state !== "available"
      || observation.executable !== requiredTool.executable
      || observation.detected_version !== requiredTool.exact_version;
  }) ?? descriptor?.tools[0];
  const authority = INSTALLATION_AUTHORITY_BY_ID.get(tool?.installation_authority_id);
  const assessmentDate = assessmentTime?.slice(0, 10);
  if (
    !tool
    || !authority
    || authority.tool_id !== tool.tool_id
    || authority.executable !== tool.executable
    || authority.exact_version !== tool.exact_version
    || authority.reviewed_at > assessmentDate
    || assessmentDate > authority.expires_at
  ) return null;
  return {
    reason: candidate.unavailable_reason,
    executor_id: descriptor.descriptor_id,
    tool: structuredClone(tool),
    official_manual: structuredClone(authority.official_source),
    installation_instructions: includeInstructions
      && candidate.unavailable_reason !== "unsupported_platform"
      ? authority.installation_routes
        .filter(({ platforms }) => platforms.includes(state.platform))
        .map(({ route_id: routeId, command }) => ({
          route_id: routeId,
          command: structuredClone(command),
        }))
      : [],
  };
}

function statePathForToken(token) {
  if (typeof token !== "string") return null;
  const match = token.match(STATE_TOKEN);
  return match
    ? path.join(os.tmpdir(), `launchrally-handoff-${match[1]}`, `${match[2]}.json`)
    : null;
}

async function storeState(state) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-handoff-"));
  const directoryToken = path.basename(directory).slice("launchrally-handoff-".length);
  const fileToken = randomBytes(32).toString("base64url");
  await writeFile(path.join(directory, `${fileToken}.json`), `${JSON.stringify(state)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return `lrhandoff_${directoryToken}_${fileToken}`;
}

async function loadState(token) {
  const statePath = statePathForToken(token);
  if (!statePath) return null;
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    return state?.state_version === "executor-handoff/v1" ? state : null;
  } catch {
    return null;
  }
}

async function saveState(state, token) {
  const statePath = statePathForToken(token);
  if (!statePath) return false;
  await writeFile(statePath, `${JSON.stringify(state)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return true;
}

function result(status, state, resumeToken, sourceRefs, request, preview, extra = {}) {
  const interaction = {
    schema_version: HANDOFF_INTERACTION_SCHEMA,
    interaction_id: "interaction_executor_handoff",
    operation: "handoff",
    status,
    state,
    resume_token: resumeToken,
    source_refs: sourceRefs,
    request,
    preview,
  };
  assertValidHandoffInteraction(interaction);
  return {
    contract: HANDOFF_INTERACTION_SCHEMA,
    status,
    operation: "handoff",
    state,
    resume_token: resumeToken,
    request,
    preview,
    interaction,
    safety: structuredClone(SAFETY),
    ...extra,
  };
}

function candidatesFor(source, platform) {
  const graph = source.task_graph;
  const descriptors = source.executor_descriptors;
  const mapping = mapTaskGraphExecutors(graph, descriptors);
  const reviewed = new Set((source.reviewed_executors ?? []).map((review) =>
    `${review.descriptor_id}:${review.descriptor_version}:${review.digest}`));
  const descriptorById = new Map(descriptors.map((descriptor) => [
    descriptor.descriptor_id,
    descriptor,
  ]));
  const observations = new Map((source.tool_observations ?? []).map((observation) => [
    observation.tool_id,
    observation,
  ]));
  const ready = new Set(graph.ready_frontier);
  const groups = new Map();
  for (const taskMapping of mapping.tasks.filter(({ task_id: id }) => ready.has(id))) {
    const task = graph.tasks.find(({ task_id: id }) => id === taskMapping.task_id);
    for (const executorId of taskMapping.managed_executor_ids) {
      const descriptor = descriptorById.get(executorId);
      if (
        !descriptor.contract_versions.includes(HANDOFF_PACKAGE_SCHEMA)
        || !descriptor.contract_versions.includes(descriptor.result_schema)
      ) continue;
      const trustCurrent = trustIsCurrent(descriptor.trust, source.assessment_time);
      const trustAccepted = descriptor.trust.tier === "core_catalog"
        ? trustCurrent
          && CORE_EXECUTOR_DESCRIPTOR_DIGESTS.get(descriptor.descriptor_id)
            === descriptor.trust.digest
        : descriptor.trust.tier === "reviewed_extension"
          && trustCurrent
          && reviewed.has(
            `${descriptor.descriptor_id}:${descriptor.descriptor_version}:${descriptor.trust.digest}`,
          );
      if (!trustAccepted) continue;
      const toolsAvailable = descriptor.tools.every((tool) => {
        const observation = observations.get(tool.tool_id);
        return observation?.state === "available"
          && observation.executable === tool.executable
          && observation.detected_version === tool.exact_version;
      });
      const platformAvailable = descriptor.platforms.includes(platform);
      const unavailableReason = !platformAvailable
        ? "unsupported_platform"
        : descriptor.tools.some((tool) =>
          observations.get(tool.tool_id)?.state === "unsupported_version"
          || (
            observations.get(tool.tool_id)?.state === "available"
            && observations.get(tool.tool_id)?.detected_version !== tool.exact_version
          ))
          ? "unsupported_version"
          : toolsAvailable ? null : "missing_tool";
      const key = JSON.stringify([
        executorId,
        task.environment,
        task.effect_class,
        task.expected_target,
        task.allowed_effects,
        task.prohibited_effects,
      ]);
      const group = groups.get(key) ?? {
        executor_id: executorId,
        task_ids: [],
        environment: task.environment,
        effect_class: task.effect_class,
        target: task.expected_target,
        available: platformAvailable && toolsAvailable,
        unavailable_reason: unavailableReason,
        recommended: false,
        authority_width: descriptor.supported_task_types.length
          + descriptor.platforms.length
          + descriptor.environments.length
          + descriptor.tools.length
          + descriptor.auth_assumptions.length,
      };
      group.task_ids.push(task.task_id);
      groups.set(key, group);
    }
  }
  const candidates = [...groups.values()].map((candidate) => {
    candidate.task_ids.sort();
    return {
      batch_id: candidate.task_ids.length === 1
        ? `batch_${candidate.executor_id}_${candidate.task_ids[0]}`
        : `batch_${candidate.executor_id}_${sha256(candidate.task_ids).slice(7, 19)}`,
      ...candidate,
    };
  });
  candidates.sort((left, right) => left.batch_id.localeCompare(right.batch_id));
  const authorityGroups = new Map();
  for (const candidate of candidates.filter(({ available }) => available)) {
    const key = JSON.stringify([
      candidate.task_ids,
      candidate.environment,
      candidate.effect_class,
      candidate.target,
    ]);
    const current = authorityGroups.get(key);
    if (
      !current
      || candidate.authority_width < current.authority_width
      || (candidate.authority_width === current.authority_width
        && candidate.batch_id.localeCompare(current.batch_id) < 0)
    ) authorityGroups.set(key, candidate);
  }
  for (const candidate of authorityGroups.values()) candidate.recommended = true;
  return candidates.map(({ authority_width: authorityWidth, ...candidate }) => {
    if (candidate.unavailable_reason === null) delete candidate.unavailable_reason;
    return candidate;
  });
}

function missingExecutorChoices(state, assessmentTime = state.assessment_time) {
  return recoveryFor(state, false, assessmentTime)
    ? ["show_install_instructions", "open_official_manual", "defer", "cancel"]
    : ["manual_or_custom", "defer", "cancel"];
}

function sourceReferences(state) {
  return [
    reference(state.task_graph.graph_id, TASK_GRAPH_SCHEMA, state.task_graph),
    ...state.executor_descriptors.map((descriptor) =>
      reference(descriptor.descriptor_id, EXECUTOR_DESCRIPTOR_SCHEMA, descriptor)),
  ];
}

function authorityBatch(state, candidate) {
  const tasks = state.task_graph.tasks.filter(({ task_id: id }) =>
    candidate.task_ids.includes(id));
  return {
    effect_classes: [...new Set(tasks.map(({ effect_class: effect }) => effect))],
    target: candidate.target,
    allowed_effects: [...new Set(tasks.flatMap(({ allowed_effects: effects }) => effects))].sort(),
    prohibited_effects: [...new Set(
      tasks.flatMap(({ prohibited_effects: effects }) => effects),
    )].sort(),
    user_visible_effects: tasks.map(visibleEffect),
  };
}

function receiptIsBoundToPackage(receipt, handoffPackage) {
  const expectedHandoff = reference(
    handoffPackage.handoff_id,
    HANDOFF_PACKAGE_SCHEMA,
    handoffPackage,
  );
  const expectedTasks = [...handoffPackage.task_ids].sort();
  const receiptTasks = receipt.task_results.map(({ task_id: id }) => id).sort();
  return referencesEqual(receipt.handoff, expectedHandoff)
    && referencesEqual(receipt.executor, handoffPackage.executor)
    && new Set(receiptTasks).size === receiptTasks.length
    && JSON.stringify(receiptTasks) === JSON.stringify(expectedTasks)
    && Date.parse(receipt.reported_at) >= Date.parse(handoffPackage.approval.confirmed_at);
}

function taskUpdatesForReceipt(receipt) {
  return receipt.task_results.map(({ task_id: taskId, state: receiptState }) => ({
    task_id: taskId,
    status: receiptState === "partial" ? "reported_failed" : receiptState,
  }));
}

function storedStateIsValid(state) {
  try {
    assertValidTaskGraph(state.task_graph);
    state.executor_descriptors.forEach(assertValidExecutorDescriptor);
    if (
      !observationsAreValid(state.tool_observations)
      || !reviewsAreValid(state.reviewed_executors)
      || typeof state.platform !== "string"
      || !Number.isFinite(Date.parse(state.assessment_time))
      || !["executor_discovery", "missing_executor", "authority_preview", "receipt_review", "verification_pending"]
        .includes(state.stage)
    ) return false;
    const expectedReferences = sourceReferences(state);
    const expectedCandidates = candidatesFor(state, state.platform);
    if (
      JSON.stringify(state.source_refs) !== JSON.stringify(expectedReferences)
      || JSON.stringify(state.candidates) !== JSON.stringify(expectedCandidates)
    ) return false;
    if (["executor_discovery", "missing_executor"].includes(state.stage)) return true;
    const candidate = state.candidates.find(({ batch_id: id, available }) =>
      id === state.selected_batch_id && available);
    const descriptor = state.executor_descriptors.find(({ descriptor_id: id }) =>
      id === candidate?.executor_id);
    if (!candidate || !descriptor) return false;
    assertValidHandoffPackage(state.handoff_package);
    const packageIsBound = state.handoff_package.environment === candidate.environment
      && JSON.stringify(state.handoff_package.task_ids) === JSON.stringify(candidate.task_ids)
      && referencesEqual(
        state.handoff_package.task_graph,
        reference(state.task_graph.graph_id, TASK_GRAPH_SCHEMA, state.task_graph),
      )
      && referencesEqual(
        state.handoff_package.executor,
        reference(descriptor.descriptor_id, EXECUTOR_DESCRIPTOR_SCHEMA, descriptor),
      )
      && JSON.stringify(state.handoff_package.authority_batch)
        === JSON.stringify(authorityBatch(state, candidate));
    if (!packageIsBound) return false;
    const {
      schema_version: schemaVersion,
      handoff_id: handoffId,
      ...identityContent
    } = state.handoff_package;
    identityContent.approval = {
      state: "required",
      confirmation: null,
      confirmed_at: null,
    };
    if (
      schemaVersion !== HANDOFF_PACKAGE_SCHEMA
      || handoffId !== `handoff_${sha256(identityContent).slice(7, 27)}`
    ) return false;
    if (state.stage === "authority_preview") {
      return state.handoff_package.approval.state === "required";
    }
    if (state.handoff_package.approval.state !== "approved") return false;
    if (state.stage === "receipt_review") return true;
    assertValidExecutionReceipt(state.execution_receipt);
    return receiptIsBoundToPackage(state.execution_receipt, state.handoff_package)
      && JSON.stringify(state.task_updates)
        === JSON.stringify(taskUpdatesForReceipt(state.execution_receipt));
  } catch {
    return false;
  }
}

function observationsAreValid(observations) {
  if (!Array.isArray(observations)) return false;
  const seen = new Set();
  return observations.every((observation) => {
    const keys = Object.keys(observation ?? {}).sort();
    const valid = JSON.stringify(keys) === JSON.stringify([
      "detected_version",
      "executable",
      "state",
      "tool_id",
    ])
      && typeof observation.tool_id === "string"
      && /^[a-z][a-z0-9_]{2,127}$/u.test(observation.tool_id)
      && typeof observation.executable === "string"
      && /^[A-Za-z0-9._-]+$/u.test(observation.executable)
      && ["available", "missing", "unsupported_version"].includes(observation.state)
      && (observation.detected_version === null
        || /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u
          .test(observation.detected_version));
    if (!valid || seen.has(observation.tool_id)) return false;
    seen.add(observation.tool_id);
    return true;
  });
}

function reviewsAreValid(reviews) {
  if (!Array.isArray(reviews)) return false;
  const seen = new Set();
  return reviews.every((review) => {
    const keys = Object.keys(review ?? {}).sort();
    const key = `${review?.descriptor_id}:${review?.descriptor_version}:${review?.digest}`;
    const valid = JSON.stringify(keys) === JSON.stringify([
      "descriptor_id",
      "descriptor_version",
      "digest",
    ])
      && /^[a-z][a-z0-9_]{2,127}$/u.test(review.descriptor_id)
      && /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u
        .test(review.descriptor_version)
      && /^sha256:[a-f0-9]{64}$/u.test(review.digest);
    if (!valid || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function staleResult(state, token) {
  return result(
    "stale_input",
    state.stage === "receipt_review" ? "receipt_review" : "executor_discovery",
    token,
    state.source_refs,
    { kind: "refresh_handoff_inputs", choices: ["refresh", "cancel"] },
    state.preview ?? {
      effect_classes: ["read_only"],
      user_visible_effects: ["Refresh the Task Graph and reviewed Executor Descriptors."],
    },
    { error: "handoff_inputs_stale" },
  );
}

export async function runHandoff(source = {}, options = {}, dependencies = {}) {
  const store = dependencies.store_state ?? storeState;
  const load = dependencies.load_state ?? loadState;
  const save = dependencies.save_state ?? saveState;
  if (options.resume_token) {
    const state = await load(options.resume_token);
    if (!state) {
      return {
        contract: HANDOFF_INTERACTION_SCHEMA,
        status: "execution_error",
        operation: "handoff",
        error: "invalid_resume_token",
      };
    }
    if (!storedStateIsValid(state)) {
      return {
        contract: HANDOFF_INTERACTION_SCHEMA,
        status: "execution_error",
        operation: "handoff",
        error: "invalid_handoff_resume_state",
      };
    }
    const resumeTime = now(dependencies);
    if (
      state.task_graph.currentness.state !== "current"
      || state.executor_descriptors.some(({ trust }) =>
        resumeTime < trust.reviewed_at || resumeTime > trust.expires_at)
    ) return staleResult(state, options.resume_token);
    if (state.stage === "missing_executor") {
      const recovery = recoveryFor(state, false, resumeTime);
      if (options.choice === "show_install_instructions" && recovery) {
        return result(
          "needs_input",
          "executor_discovery",
          options.resume_token,
          state.source_refs,
          {
            kind: "missing_executor_recovery",
            choices: ["open_official_manual", "defer", "cancel"],
          },
          state.preview,
          { candidates: state.candidates, recovery: recoveryFor(state, true, resumeTime) },
        );
      }
      if (["defer", "cancel"].includes(options.choice)) {
        return result(
          options.choice === "defer" ? "completed" : "cancelled",
          "completed",
          null,
          state.source_refs,
          { kind: "none", choices: ["none"] },
          state.preview,
          { outcome: options.choice === "defer" ? "deferred" : "cancelled" },
        );
      }
      if (options.choice === "manual_or_custom" && !recovery) {
        return result(
          "completed",
          "completed",
          null,
          state.source_refs,
          { kind: "none", choices: ["none"] },
          state.preview,
          {
            outcome: "manual_or_custom_selected",
            manual_path: {
              authority_granted: false,
              external_execution_started: false,
            },
          },
        );
      }
      return result(
        "needs_input",
        "executor_discovery",
        options.resume_token,
        state.source_refs,
        {
          kind: "missing_executor_recovery",
          choices: missingExecutorChoices(state, resumeTime),
        },
        state.preview,
        { candidates: state.candidates, recovery },
      );
    }
    if (state.stage === "verification_pending") {
      const choice = options.choice;
      const common = {
        handoff_package: structuredClone(state.handoff_package),
        execution_receipt: structuredClone(state.execution_receipt),
        task_updates: structuredClone(state.task_updates),
        safety: { ...SAFETY, authority_granted: true },
      };
      if (choice === "verify") {
        const tasks = state.task_graph.tasks.filter(({ task_id: id }) =>
          state.handoff_package.task_ids.includes(id));
        return result(
          "completed",
          "completed",
          null,
          [reference(
            state.handoff_package.handoff_id,
            HANDOFF_PACKAGE_SCHEMA,
            state.handoff_package,
          )],
          { kind: "none", choices: ["none"] },
          {
            effect_classes: ["read_only"],
            user_visible_effects: ["Run fresh independent Verify for the handed-off targets."],
          },
          {
            ...common,
            next: {
              operation: "verify",
              scope: "targeted",
              task_requests: tasks.map((task) => ({
                task_id: task.task_id,
                scope: task.follow_up_verify.scope,
                evidence_targets: [...task.evidence_targets],
              })),
              fresh_evidence_required: true,
            },
          },
        );
      }
      if (choice === "cancel") {
        return result(
          "cancelled",
          "verification_pending",
          null,
          state.source_refs,
          { kind: "none", choices: ["none"] },
          state.preview ?? {
            effect_classes: ["read_only"],
            user_visible_effects: ["Fresh verification remains incomplete."],
          },
          common,
        );
      }
      return result(
        "resumable",
        "verification_pending",
        options.resume_token,
        state.source_refs,
        { kind: "fresh_verification", choices: ["verify", "defer", "cancel"] },
        {
          effect_classes: ["read_only"],
          user_visible_effects: ["Fresh verification remains pending."],
        },
        common,
      );
    }
    if (state.stage === "authority_preview") {
      const handoffPackage = structuredClone(state.handoff_package);
      const preview = {
        effect_classes: [...handoffPackage.authority_batch.effect_classes],
        user_visible_effects: [...handoffPackage.authority_batch.user_visible_effects],
      };
      if (!["confirm", "deny", "cancel"].includes(options.confirmation)) {
        return result(
          "needs_confirmation",
          "authority_preview",
          options.resume_token,
          state.source_refs,
          {
            kind: "authority_confirmation",
            choices: ["confirm", "deny", "cancel"],
          },
          preview,
          { handoff_package: handoffPackage },
        );
      }
      if (options.confirmation !== "confirm") {
        handoffPackage.approval.state = options.confirmation === "deny" ? "denied" : "cancelled";
        assertValidHandoffPackage(handoffPackage);
        return result(
          options.confirmation === "deny" ? "denied" : "cancelled",
          "authority_preview",
          null,
          state.source_refs,
          { kind: "none", choices: ["none"] },
          preview,
          { handoff_package: handoffPackage },
        );
      }
      handoffPackage.approval = {
        state: "approved",
        confirmation: "explicit_user_confirmation",
        confirmed_at: now(dependencies),
      };
      assertValidHandoffPackage(handoffPackage);
      const next = {
        ...state,
        stage: "receipt_review",
        handoff_package: structuredClone(handoffPackage),
      };
      await save(next, options.resume_token);
      return result(
        "resumable",
        "receipt_review",
        options.resume_token,
        state.source_refs,
        {
          kind: "execution_receipt",
          choices: ["submit", "defer", "cancel"],
        },
        preview,
        {
          handoff_package: handoffPackage,
          safety: { ...SAFETY, authority_granted: true },
        },
      );
    }
    if (state.stage === "receipt_review") {
      if (options.choice === "defer") {
        return result(
          "resumable",
          "receipt_review",
          options.resume_token,
          state.source_refs,
          { kind: "execution_receipt", choices: ["submit", "defer", "cancel"] },
          {
            effect_classes: [...state.handoff_package.authority_batch.effect_classes],
            user_visible_effects: ["The approved package remains external and unexecuted by LaunchRally."],
          },
          {
            outcome: "receipt_deferred",
            handoff_package: structuredClone(state.handoff_package),
            safety: { ...SAFETY, authority_granted: true },
          },
        );
      }
      if (options.choice === "cancel") {
        return result(
          "cancelled",
          "receipt_review",
          null,
          state.source_refs,
          { kind: "none", choices: ["none"] },
          {
            effect_classes: [...state.handoff_package.authority_batch.effect_classes],
            user_visible_effects: ["External coordination was cancelled before receipt acceptance."],
          },
          {
            outcome: "external_coordination_cancelled",
            handoff_package: structuredClone(state.handoff_package),
            safety: { ...SAFETY, authority_granted: true },
          },
        );
      }
      const receipt = options.receipt;
      try {
        assertValidExecutionReceipt(receipt);
      } catch {
        return {
          contract: HANDOFF_INTERACTION_SCHEMA,
          status: "execution_error",
          operation: "handoff",
          error: "invalid_execution_receipt",
        };
      }
      const handoffPackage = state.handoff_package;
      const expectedHandoff = reference(
        handoffPackage.handoff_id,
        HANDOFF_PACKAGE_SCHEMA,
        handoffPackage,
      );
      if (!receiptIsBoundToPackage(receipt, handoffPackage)) {
        return {
          contract: HANDOFF_INTERACTION_SCHEMA,
          status: "execution_error",
          operation: "handoff",
          error: "execution_receipt_binding_mismatch",
        };
      }
      const taskUpdates = taskUpdatesForReceipt(receipt);
      const next = {
        ...state,
        stage: "verification_pending",
        execution_receipt: structuredClone(receipt),
        task_updates: structuredClone(taskUpdates),
      };
      await save(next, options.resume_token);
      return result(
        "partial_completion",
        "receipt_review",
        options.resume_token,
        [expectedHandoff],
        {
          kind: "fresh_verification",
          choices: ["verify", "defer", "cancel"],
        },
        {
          effect_classes: ["read_only"],
          user_visible_effects: [
            "Request fresh independent verification; the Execution Receipt remains a claim.",
          ],
        },
        {
          handoff_package: structuredClone(handoffPackage),
          execution_receipt: structuredClone(receipt),
          task_updates: taskUpdates,
          safety: { ...SAFETY, authority_granted: true },
        },
      );
    }
    if (state.stage !== "executor_discovery") {
      return {
        contract: HANDOFF_INTERACTION_SCHEMA,
        status: "execution_error",
        operation: "handoff",
        error: "invalid_handoff_state",
      };
    }
    const candidate = state.candidates.find(({ batch_id: id, available }) =>
      id === options.selection && available);
    if (!candidate) {
      return {
        contract: HANDOFF_INTERACTION_SCHEMA,
        status: "execution_error",
        operation: "handoff",
        error: "invalid_executor_selection",
      };
    }
    const descriptor = state.executor_descriptors.find(({ descriptor_id: id }) =>
      id === candidate.executor_id);
    const packageContent = {
      revision: 1,
      created_at: now(dependencies),
      environment: candidate.environment,
      task_graph: reference(
        state.task_graph.graph_id,
        TASK_GRAPH_SCHEMA,
        state.task_graph,
      ),
      task_ids: [...candidate.task_ids],
      executor: reference(
        descriptor.descriptor_id,
        EXECUTOR_DESCRIPTOR_SCHEMA,
        descriptor,
      ),
      authority_batch: authorityBatch(state, candidate),
      approval: {
        state: "required",
        confirmation: null,
        confirmed_at: null,
      },
      retention: {
        raw_provider_output_retained: false,
        receipt_payload_retained: false,
        sensitive_data_retained: false,
      },
    };
    const handoffPackage = {
      schema_version: HANDOFF_PACKAGE_SCHEMA,
      handoff_id: `handoff_${sha256(packageContent).slice(7, 27)}`,
      ...packageContent,
    };
    assertValidHandoffPackage(handoffPackage);
    const next = {
      ...state,
      stage: "authority_preview",
      selected_batch_id: candidate.batch_id,
      handoff_package: structuredClone(handoffPackage),
    };
    await save(next, options.resume_token);
    return result(
      "needs_confirmation",
      "authority_preview",
      options.resume_token,
      state.source_refs,
      {
        kind: "authority_confirmation",
        choices: ["confirm", "deny", "cancel"],
      },
      {
        effect_classes: [...handoffPackage.authority_batch.effect_classes],
        user_visible_effects: [...handoffPackage.authority_batch.user_visible_effects],
      },
      { handoff_package: handoffPackage },
    );
  }
  try {
    assertValidTaskGraph(source.task_graph);
  } catch {
    return {
      contract: HANDOFF_INTERACTION_SCHEMA,
      status: "execution_error",
      operation: "handoff",
      error: "invalid_task_graph",
    };
  }
  if (source.task_graph.currentness.state !== "current") {
    return {
      contract: HANDOFF_INTERACTION_SCHEMA,
      status: "stale_input",
      operation: "handoff",
      state: "executor_discovery",
      error: "task_graph_stale",
    };
  }
  const assessmentTime = now(dependencies);
  if (typeof assessmentTime !== "string" || !Number.isFinite(Date.parse(assessmentTime))) {
    return {
      contract: HANDOFF_INTERACTION_SCHEMA,
      status: "execution_error",
      operation: "handoff",
      error: "invalid_handoff_assessment_time",
    };
  }
  try {
    for (const descriptor of source.executor_descriptors ?? []) {
      assertValidExecutorDescriptor(descriptor);
    }
  } catch {
    return {
      contract: HANDOFF_INTERACTION_SCHEMA,
      status: "execution_error",
      operation: "handoff",
      error: "invalid_executor_descriptor",
    };
  }
  if (
    !observationsAreValid(source.tool_observations)
    || !reviewsAreValid(source.reviewed_executors)
  ) {
    return {
      contract: HANDOFF_INTERACTION_SCHEMA,
      status: "execution_error",
      operation: "handoff",
      error: "invalid_executor_discovery_input",
    };
  }
  const candidates = candidatesFor(
    { ...source, assessment_time: assessmentTime },
    dependencies.platform ?? `${process.platform}-${process.arch}`,
  );
  const available = candidates.filter((candidate) => candidate.available);
  const state = {
    state_version: "executor-handoff/v1",
    stage: "executor_discovery",
    task_graph: structuredClone(source.task_graph),
    executor_descriptors: structuredClone(source.executor_descriptors),
    reviewed_executors: structuredClone(source.reviewed_executors),
    tool_observations: structuredClone(source.tool_observations),
    assessment_time: assessmentTime,
    platform: dependencies.platform ?? `${process.platform}-${process.arch}`,
    candidates: structuredClone(candidates),
    source_refs: [],
  };
  state.source_refs = sourceReferences(state);
  const sourceRefs = state.source_refs;
  const token = await store(state);
  const previewTasks = source.task_graph.tasks.filter(({ task_id: id }) =>
    source.task_graph.ready_frontier.includes(id));
  const preview = {
    effect_classes: [...new Set(previewTasks.map(({ effect_class: effect }) => effect))],
    user_visible_effects: [...new Set(previewTasks.map(authorityDescription))],
  };
  if (available.length === 0) {
    const missingState = { ...state, stage: "missing_executor", preview };
    await save(missingState, token);
    return result(
      "needs_input",
      "executor_discovery",
      token,
      sourceRefs,
      {
        kind: "missing_executor_recovery",
        choices: missingExecutorChoices(missingState),
      },
      preview,
      {
        candidates,
        recovery: recoveryFor(missingState),
        manual_path: {
          available: true,
          authority_granted: false,
          required_capabilities: [...new Set(
            previewTasks.map(({ minimum_executor_capability: capability }) => capability),
          )].sort(),
        },
      },
    );
  }
  return result(
    "needs_input",
    "executor_discovery",
    token,
    sourceRefs,
    {
      kind: "executor_selection",
      choices: available.map(({ batch_id: id }) => id),
    },
    preview,
    { candidates },
  );
}
