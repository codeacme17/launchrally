import { constants } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import {
  ARCHITECT_INTERACTION_SCHEMA,
  PRODUCT_INTENT_PROFILE_SCHEMA,
  assertValidArchitectInteraction,
  assertValidProductIntentProfile,
} from "@launchrally/contracts";

import { rethrowIfAborted, throwIfAborted } from "./cancellation.js";
import { scanRepository } from "./local-safe-scan.js";

export const PRODUCT_INTENT_ANALYZER_VERSION = "product-intent-analyzer/v1";

const PERMISSION_ID = "local_semantic_analysis";
const ANALYZER_ID = "launchrally-product-intent-analyzer";
const MAX_MATERIAL_BYTES = 128 * 1024;
const SUPPORTED_MATERIAL_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);
const INTENDED_ENVIRONMENTS = Object.freeze(["development", "preview", "production", "staging"]);
const DECLARABLE_BEHAVIORS = Object.freeze([
  "teams_collaborate_in_realtime",
]);
const HARD_CONSTRAINTS = Object.freeze([
  "data_residency_eu",
  "data_residency_us",
  "local_first_required",
  "no_external_network",
  "self_hosting_required",
]);
const PREFERENCES = Object.freeze([
  "managed_operations",
  "minimal_dependencies",
  "open_source_preferred",
  "provider_portability",
]);
const BEHAVIOR_RULES = Object.freeze([
  {
    behavior_id: "customers_purchase_subscription",
    patterns: ["subscribe", "subscription", "billing", "stripe_"],
    obligations: ["billing_entitlement_lifecycle"],
  },
  {
    behavior_id: "customers_receive_transactional_email",
    patterns: ["email receipt", "transactional email", "resend_"],
    obligations: ["communication_delivery_visibility"],
  },
  {
    behavior_id: "customers_sign_in",
    patterns: ["sign in", "login", "authenticate", "clerk_"],
    obligations: ["identity_session_lifecycle"],
  },
  {
    behavior_id: "customers_upload_objects",
    patterns: ["upload file", "upload files", "object storage"],
    obligations: ["object_access_and_retention"],
  },
  {
    behavior_id: "background_jobs_execute",
    patterns: ["background job", "queue", "asynchronous processing"],
    obligations: ["background_retry_and_failure_visibility"],
  },
  {
    behavior_id: "product_analytics_collected",
    patterns: ["product analytics", "posthog_"],
    obligations: ["analytics_privacy_and_consent"],
  },
]);

function encodeState(state) {
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  const digest = createHash("sha256").update(payload).digest("base64url");
  return `${payload}.${digest}`;
}

function decodeState(token) {
  if (typeof token !== "string") return null;
  const [payload, suppliedDigest, extra] = token.split(".");
  if (!payload || !suppliedDigest || extra !== undefined) return null;
  const expected = createHash("sha256").update(payload).digest();
  let actual;
  try {
    actual = Buffer.from(suppliedDigest, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return state?.schema_version === ARCHITECT_INTERACTION_SCHEMA ? state : null;
  } catch {
    return null;
  }
}

function normalizeSelectedMaterials(materials) {
  if (materials === undefined) return [];
  if (!Array.isArray(materials)) return null;
  const normalized = [];
  for (const material of materials) {
    if (typeof material !== "string" || material.trim() === "") return null;
    const candidate = material.trim().replaceAll("\\", "/");
    if (path.posix.isAbsolute(candidate) || candidate.split("/").includes("..")) return null;
    normalized.push(candidate);
  }
  return [...new Set(normalized)].sort();
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function materialSourceClass(relativePath) {
  const name = path.basename(relativePath).toLowerCase();
  if (/^(?:prd|product-requirements)(?:\.|-)/u.test(name)) return "prd";
  if (/^readme(?:\.|$)/u.test(name)) return "readme";
  if (name.includes("brief")) return "product_brief";
  if (name.includes("plan")) return "product_plan";
  return "selected_document";
}

async function readSelectedMaterial(root, relativePath, signal) {
  throwIfAborted(signal);
  const absolutePath = path.resolve(root, relativePath);
  if (!isInside(root, absolutePath)) return { state: "unsupported", reason: "outside_root" };
  if (!SUPPORTED_MATERIAL_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
    return { state: "unsupported", reason: "unsupported_source_class" };
  }
  let handle;
  try {
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { state: "unsupported", reason: "unsafe_file_type" };
    }
    if (stat.size > MAX_MATERIAL_BYTES) return { state: "unsupported", reason: "too_large" };
    const canonicalPath = await realpath(absolutePath);
    if (!isInside(root, canonicalPath)) return { state: "unsupported", reason: "outside_root" };
    handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.dev !== stat.dev || openedStat.ino !== stat.ino) {
      return { state: "unsupported", reason: "changed_during_read" };
    }
    const bytes = await handle.readFile();
    throwIfAborted(signal);
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      state: "supported",
      content,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      source_class: materialSourceClass(relativePath),
    };
  } catch (error) {
    rethrowIfAborted(error, signal);
    return { state: "unsupported", reason: "unreadable" };
  } finally {
    await handle?.close();
  }
}

function behaviorCandidates(sources) {
  return BEHAVIOR_RULES.flatMap((rule) => {
    const matchingSources = sources.filter(({ normalized_text: text }) =>
      rule.patterns.some((pattern) => text.includes(pattern)));
    return matchingSources.length === 0 ? [] : [{
      behavior_id: rule.behavior_id,
      status: "candidate",
      source_ids: matchingSources.map(({ source_id: sourceId }) => sourceId).sort(),
    }];
  }).sort((left, right) => left.behavior_id.localeCompare(right.behavior_id));
}

function sourceNegates(source, patterns) {
  return patterns.some((pattern) => [
    `no ${pattern}`,
    `not ${pattern}`,
    `without ${pattern}`,
    `must not ${pattern}`,
  ].some((negative) => source.normalized_text.includes(negative)));
}

function intentConflicts(sources) {
  return BEHAVIOR_RULES.flatMap((rule) => {
    const positive = sources.filter(({ normalized_text: text }) =>
      rule.patterns.some((pattern) => text.includes(pattern))
      && !sourceNegates({ normalized_text: text }, rule.patterns));
    const negative = sources.filter((source) => sourceNegates(source, rule.patterns));
    if (positive.length === 0 || negative.length === 0) return [];
    return [{
      conflict_id: `conflict_${rule.behavior_id}`,
      source_ids: [...new Set([...positive, ...negative]
        .map(({ source_id: sourceId }) => sourceId))].sort(),
      summary: `Sources conflict about ${rule.behavior_id}.`,
      status: "unresolved",
    }];
  });
}

function obligationCandidates(behaviors) {
  return behaviors.flatMap(({ behavior_id: behaviorId }) => {
    const rule = BEHAVIOR_RULES.find((candidate) => candidate.behavior_id === behaviorId);
    return rule.obligations.map((obligationId) => ({
      obligation_id: obligationId,
      source_behavior_ids: [behaviorId],
      state: "candidate",
      derivation_chain: [behaviorId, obligationId],
    }));
  }).sort((left, right) => left.obligation_id.localeCompare(right.obligation_id));
}

async function prepareCandidates(root, selectedMaterials, permissionDecision, signal) {
  const scan = await scanRepository(root, { signal });
  const environmentNames = scan.facts
    .filter(({ kind }) => kind === "environment_variables")
    .flatMap(({ names }) => names)
    .sort();
  const sources = environmentNames.length === 0 ? [] : [{
    source_id: "source_local_safe_scan",
    normalized_text: environmentNames.join(" ").toLowerCase(),
  }];
  const provenance = [];
  const supportedSources = [];
  const excludedSources = [];

  supportedSources.push("local_safe_scan");
  provenance.push({
    source_id: "source_local_safe_scan",
    source_class: "normalized_repository_facts",
    path: ".",
    digest: `sha256:${createHash("sha256").update(JSON.stringify(environmentNames)).digest("hex")}`,
    permission: "local_safe_scan",
  });

  if (permissionDecision === "approved") {
    for (const [index, relativePath] of selectedMaterials.entries()) {
      const material = await readSelectedMaterial(root, relativePath, signal);
      if (material.state !== "supported") {
        excludedSources.push(relativePath);
        continue;
      }
      const sourceId = `source_selected_${index + 1}`;
      sources.push({ source_id: sourceId, normalized_text: material.content.toLowerCase() });
      supportedSources.push(relativePath);
      provenance.push({
        source_id: sourceId,
        source_class: material.source_class,
        path: relativePath,
        digest: material.digest,
        permission: "local_semantic_analysis",
      });
    }
  } else if (permissionDecision === "denied") {
    excludedSources.push(...selectedMaterials);
  }

  const behaviors = behaviorCandidates(sources);
  return {
    candidates: {
      behaviors,
      obligations: obligationCandidates(behaviors),
    },
    provenance,
    conflicts: intentConflicts(sources),
    coverage: {
      state: permissionDecision === "denied"
        ? "denied"
        : selectedMaterials.length > 0 && excludedSources.length === 0
          ? "complete"
          : "partial",
      supported_sources: [...new Set(supportedSources)].sort(),
      excluded_sources: [...new Set(excludedSources)].sort(),
      negative_findings_allowed: false,
    },
  };
}

function permission(targetScope) {
  return {
    permission_id: PERMISSION_ID,
    boundary: "selected_local_content",
    target_scope: targetScope,
    analyzer: {
      id: ANALYZER_ID,
      version: PRODUCT_INTENT_ANALYZER_VERSION,
    },
    normalized_facts: [
      "behavior_candidates",
      "obligation_candidates",
      "intent_conflicts",
      "source_provenance",
      "coverage",
    ],
    exclusions: [
      "raw_source",
      "unrestricted_model_summary",
      "secret_values",
      "business_payloads",
      "real_user_data",
    ],
    retention: "normalized_facts_only",
    coverage_limitations: [
      "Only explicitly selected supported text materials are analyzed.",
      "Unsupported or unreadable material remains uncovered and cannot prove absence.",
    ],
    decision: "pending",
  };
}

function interactionResult(status, resumeToken, request, extra = {}) {
  const result = {
    contract: ARCHITECT_INTERACTION_SCHEMA,
    status,
    operation: "architect",
    state: "intent_discovery",
    request,
    resume_token: resumeToken,
    ...extra,
  };
  if (status !== "execution_error") {
    const choices = request?.choices
      ?? (status === "needs_permission"
        ? ["approved", "denied"]
        : status === "needs_input"
          ? ["submit"]
          : ["none"]);
    result.interaction = {
      schema_version: ARCHITECT_INTERACTION_SCHEMA,
      interaction_id: "interaction_product_intent_discovery",
      operation: "architect",
      status,
      state: status === "completed" ? "completed" : "intent_discovery",
      resume_token: resumeToken,
      source_refs: [],
      request: {
        kind: request?.kind ?? (status === "needs_permission"
          ? "local_semantic_analysis"
          : status === "needs_input"
            ? "product_intent_answers"
            : "none"),
        choices,
      },
      preview: {
        effect_classes: [status === "needs_permission" ? "local_source" : "read_only"],
        user_visible_effects: [status === "needs_permission"
          ? "Read only the explicitly selected local product materials after approval."
          : "Persist no repository or Provider changes."],
      },
    };
    assertValidArchitectInteraction(result.interaction);
  }
  return result;
}

function inputRequest(candidates, conflicts) {
  const behaviorIds = candidates.behaviors
    .map(({ behavior_id: behaviorId }) => behaviorId);
  const conflictIds = conflicts.map(({ conflict_id: conflictId }) => conflictId);
  return {
    fields: [
      {
        field_id: "intended_environment",
        type: "identifier",
        required: true,
        suggested_values: INTENDED_ENVIRONMENTS,
        affects: ["applicability", "release_gating"],
      },
      {
        field_id: "confirmed_behaviors",
        type: "identifier_array",
        required: true,
        suggested_values: [...new Set([...behaviorIds, ...DECLARABLE_BEHAVIORS])].sort(),
        affects: ["applicability", "architecture", "assurance"],
      },
      {
        field_id: "hard_constraints",
        type: "identifier_array",
        required: true,
        suggested_values: HARD_CONSTRAINTS,
        affects: ["authority", "safety", "release_gating"],
      },
      {
        field_id: "preferences",
        type: "identifier_array",
        required: true,
        suggested_values: PREFERENCES,
        affects: ["architecture"],
      },
      ...(conflictIds.length === 0 ? [] : [{
        field_id: "acknowledged_conflicts",
        type: "identifier_array",
        required: true,
        suggested_values: conflictIds,
        affects: ["architecture", "assurance", "safety"],
      }]),
    ],
  };
}

function normalizeStringSet(value, allowedValues) {
  if (!Array.isArray(value) || value.some((entry) =>
    typeof entry !== "string" || entry.trim() === "")) return null;
  const normalized = [...new Set(value.map((entry) => entry.trim()))].sort();
  const allowed = new Set(allowedValues);
  if (normalized.some((entry) => !allowed.has(entry))) return null;
  return normalized;
}

function normalizeAnswers(answers, candidates, conflicts) {
  const environment = typeof answers?.intended_environment === "string"
    ? answers.intended_environment.trim()
    : "";
  const allowedBehaviors = [
    ...candidates.behaviors.map(({ behavior_id: behaviorId }) => behaviorId),
    ...DECLARABLE_BEHAVIORS,
  ];
  const behaviors = normalizeStringSet(answers?.confirmed_behaviors, allowedBehaviors);
  const hardConstraints = normalizeStringSet(answers?.hard_constraints, HARD_CONSTRAINTS);
  const preferences = normalizeStringSet(answers?.preferences, PREFERENCES);
  const acknowledgedConflicts = conflicts.length === 0
    ? []
    : normalizeStringSet(
      answers?.acknowledged_conflicts,
      conflicts.map(({ conflict_id: conflictId }) => conflictId),
    );
  const expectedConflicts = conflicts.map(({ conflict_id: conflictId }) => conflictId).sort();
  if (
    !INTENDED_ENVIRONMENTS.includes(environment)
    || !behaviors
    || behaviors.length === 0
    || !hardConstraints
    || !preferences
    || !acknowledgedConflicts
    || JSON.stringify(acknowledgedConflicts) !== JSON.stringify(expectedConflicts)
  ) return null;
  return {
    intended_environment: environment,
    confirmed_behaviors: behaviors,
    hard_constraints: hardConstraints,
    preferences,
    acknowledged_conflicts: acknowledgedConflicts,
  };
}

function profileFromState(state, confirmation) {
  const identity = createHash("sha256").update(JSON.stringify({
    root: state.root,
    answers: state.answers,
    provenance: state.provenance,
  })).digest("hex").slice(0, 20);
  const observed = state.candidates.behaviors
    .filter(({ source_ids: sourceIds }) => sourceIds.includes("source_local_safe_scan"))
    .map(({ behavior_id: behaviorId }) => ({
      fact_id: `fact_${behaviorId}`,
      summary: `Observed repository signals support the ${behaviorId} candidate.`,
      confidence: "observed",
    }));
  const confirmed = new Set(state.answers.confirmed_behaviors);
  const unknowns = state.candidates.behaviors
    .filter(({ behavior_id: behaviorId }) => !confirmed.has(behaviorId))
    .map(({ behavior_id: behaviorId }) => behaviorId);
  if (state.coverage.state !== "complete") unknowns.push("semantic_coverage_incomplete");
  unknowns.push(...state.conflicts.map(({ conflict_id: conflictId }) => conflictId));
  return {
    schema_version: PRODUCT_INTENT_PROFILE_SCHEMA,
    profile_id: `intent_${identity}`,
    revision: 1,
    environment: state.answers.intended_environment,
    created_at: state.created_at,
    desired_intent: {
      confirmation,
      behaviors: state.answers.confirmed_behaviors,
      hard_constraints: state.answers.hard_constraints,
      preferences: state.answers.preferences,
    },
    observed_implementation: observed,
    provenance: state.provenance,
    coverage: state.coverage,
    conflicts: state.conflicts,
    unknowns: [...new Set(unknowns)].sort(),
    retention: {
      raw_source_retained: false,
      provider_output_retained: false,
      sensitive_data_retained: false,
    },
  };
}

export async function runProductIntentDiscovery(cwd, options = {}, { signal } = {}) {
  throwIfAborted(signal);
  const suppliedMaterials = normalizeSelectedMaterials(options.selected_materials);
  if (suppliedMaterials === null) {
    return interactionResult("execution_error", null, null, {
      error: "invalid_selected_materials",
    });
  }
  const selectedRoot = path.resolve(cwd);
  const rootStat = await lstat(selectedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return interactionResult("execution_error", null, null, {
      error: "invalid_repository_root",
    });
  }
  const root = await realpath(selectedRoot);
  throwIfAborted(signal);

  if (!options.resume_token) {
    const selectedMaterials = suppliedMaterials;
    const state = {
      schema_version: ARCHITECT_INTERACTION_SCHEMA,
      root,
      selected_materials: selectedMaterials,
      permission_decision: selectedMaterials.length > 0 ? "pending" : "not_required",
    };
    if (selectedMaterials.length > 0) {
      return interactionResult(
        "needs_permission",
        encodeState(state),
        { permissions: [permission(selectedMaterials)] },
      );
    }
    const prepared = await prepareCandidates(root, [], "not_required", signal);
    const nextState = {
      ...state,
      ...prepared,
      created_at: new Date().toISOString(),
      stage: "input",
    };
    return interactionResult(
      "needs_input",
      encodeState(nextState),
      inputRequest(prepared.candidates, prepared.conflicts),
      prepared,
    );
  }

  const state = decodeState(options.resume_token);
  if (!state || state.root !== root) {
    return interactionResult("execution_error", null, null, {
      error: "invalid_resume_token",
    });
  }
  if (state.permission_decision === "pending") {
    if (!["approved", "denied"].includes(options.permission_decision)) {
      return interactionResult("needs_permission", options.resume_token, {
        permissions: [permission(state.selected_materials)],
      });
    }
    const prepared = await prepareCandidates(
      root,
      state.selected_materials,
      options.permission_decision,
      signal,
    );
    const nextState = {
      ...state,
      ...prepared,
      permission_decision: options.permission_decision,
      created_at: new Date().toISOString(),
      stage: "input",
    };
    return interactionResult(
      "needs_input",
      encodeState(nextState),
      inputRequest(prepared.candidates, prepared.conflicts),
      prepared,
    );
  }

  if (state.stage === "input") {
    const answers = normalizeAnswers(options.answers, state.candidates, state.conflicts);
    if (!answers) {
      return interactionResult(
        "needs_input",
        options.resume_token,
        {
          ...inputRequest(state.candidates, state.conflicts),
          validation_errors: [{ code: "invalid_product_intent_answers" }],
        },
        { candidates: state.candidates, coverage: state.coverage },
      );
    }
    const nextState = { ...state, answers, stage: "confirmation" };
    const preview = profileFromState(nextState, "unconfirmed");
    assertValidProductIntentProfile(preview);
    return interactionResult(
      "needs_confirmation",
      encodeState(nextState),
      { kind: "product_intent_confirmation", choices: ["confirm", "revise", "cancel"] },
      { preview },
    );
  }

  if (state.stage === "confirmation") {
    if (options.confirmation === "revise") {
      const nextState = { ...state, stage: "input" };
      return interactionResult(
        "needs_input",
        encodeState(nextState),
        inputRequest(state.candidates, state.conflicts),
        { candidates: state.candidates, coverage: state.coverage },
      );
    }
    if (options.confirmation === "cancel") {
      return interactionResult("cancelled", null, null, {
        outcome: "cancelled",
        profile_changed: false,
      });
    }
    if (options.confirmation !== "confirm") {
      return interactionResult(
        "needs_confirmation",
        options.resume_token,
        { kind: "product_intent_confirmation", choices: ["confirm", "revise", "cancel"] },
        { preview: profileFromState(state, "unconfirmed") },
      );
    }
    const profile = profileFromState(state, "confirmed");
    assertValidProductIntentProfile(profile);
    return interactionResult("completed", null, null, {
      outcome: "product_intent_confirmed",
      profile,
    });
  }

  return interactionResult("execution_error", null, null, { error: "unsupported_intent_state" });
}
