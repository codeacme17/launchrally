import {
  ACTIVE_VERIFICATION_RESULT_SCHEMA,
  EXECUTION_RECEIPT_SCHEMA,
  TASK_EFFECT_BOUNDARIES,
  TASK_GRAPH_SCHEMA,
  assertValidArchitecturePackage,
  assertValidArchitectureRecord,
  assertValidCapabilityGraph,
  assertValidExecutorDescriptor,
  assertValidReportPackage,
  assertValidTaskGraph,
  computeTaskGraphReadyFrontier,
} from "@launchrally/contracts";

import { sha256 } from "./local-history.js";
import { evaluateReportCurrentness } from "./report-currentness.js";

const CAPABILITY_REQUIRED_CHECKS = Object.freeze({
  runtime_execution: Object.freeze([
    "web.baseline.package-manifest",
    "web.baseline.lockfile",
    "web.baseline.build-command",
  ]),
  application_data: Object.freeze(["web.baseline.data-state"]),
  operational_observability: Object.freeze(["web.baseline.observability"]),
  analytics_privacy: Object.freeze([
    "web.baseline.data-state",
    "web.public.transport-security",
  ]),
  dns_tls: Object.freeze([
    "web.public.availability",
    "web.public.transport-security",
  ]),
  ci_cd: Object.freeze([
    "web.baseline.package-manifest",
    "web.baseline.lockfile",
    "web.baseline.build-command",
  ]),
  secrets_configuration: Object.freeze(["web.baseline.runtime-inputs"]),
  managed_web_delivery: Object.freeze([
    "web.baseline.package-manifest",
    "web.baseline.lockfile",
    "web.baseline.build-command",
    "web.public.availability",
    "web.public.transport-security",
    "web.public.core-journeys",
  ]),
});

function reference(id, schemaVersion, value) {
  return { id, schema_version: schemaVersion, digest: sha256(value) };
}

function referencesEqual(left, right) {
  return left?.id === right?.id
    && left?.schema_version === right?.schema_version
    && left?.digest === right?.digest;
}

function identifierPart(value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "_").replaceAll(/^_+|_+$/gu, "");
}

function taskId(source, sourceId) {
  const readable = identifierPart(sourceId).slice(0, 72) || "work";
  return `task_${source}_${readable}_${sha256(sourceId).slice(7, 15)}`;
}

function reportReference(report) {
  return reference(`report_${sha256(report).slice(7, 27)}`, report.schema_version, report);
}

function baseTask({
  source,
  sourceId,
  taskType,
  environment,
  effectClass,
  expectedTarget,
  evidenceTargets,
  recoveryNotes,
  minimumExecutorCapability,
}) {
  const effects = TASK_EFFECT_BOUNDARIES[effectClass];
  return {
    task_id: taskId(source, sourceId),
    task_type: taskType,
    source,
    source_id: sourceId,
    environment,
    prerequisites: [],
    effect_class: effectClass,
    expected_target: expectedTarget,
    allowed_effects: [...effects.allowed_effects],
    prohibited_effects: [...effects.prohibited_effects],
    recovery_notes: recoveryNotes,
    minimum_executor_capability: minimumExecutorCapability,
    structured_result_schema: effectClass === "read_only"
      ? ACTIVE_VERIFICATION_RESULT_SCHEMA
      : EXECUTION_RECEIPT_SCHEMA,
    evidence_targets: evidenceTargets.length > 0 ? [...new Set(evidenceTargets)].sort() : [expectedTarget],
    follow_up_verify: {
      operation: "verify",
      scope: expectedTarget,
      fresh_evidence_required: true,
    },
    cancellation_behavior: effectClass === "read_only"
      ? "preserve_completed_prerequisites"
      : "stop_before_next_effect",
    status: "not_started",
  };
}

function findingTasks(report) {
  const checks = new Map(report.results.checks.map((check) => [check.check_id, check]));
  return report.results.action_queue.map((action) => {
    const check = checks.get(action.check_id);
    return baseTask({
      source: "finding",
      sourceId: action.check_id,
      taskType: "remediate_confirmed_finding",
      environment: report.scope.release_intent.intended_environment,
      effectClass: "local_source",
      expectedTarget: action.check_id,
      evidenceTargets: check.evidence.map(({ target }) => target),
      recoveryNotes: [
        "Preserve the last known source state when cancellation occurs before the next effect.",
        "Run fresh Verify before treating the Finding as resolved.",
      ],
      minimumExecutorCapability: "local_source_remediation_v1",
    });
  });
}

function gapTasks(report) {
  return report.results.verification_gaps.map((gap) => baseTask({
    source: "verification_gap",
    sourceId: gap.check_id,
    taskType: "investigate_verification_gap",
    environment: report.scope.release_intent.intended_environment,
    effectClass: "read_only",
    expectedTarget: gap.check_id,
    evidenceTargets: [gap.check_id],
    recoveryNotes: [
      "Keep the Verification Gap unresolved when permission or Evidence remains unavailable.",
      "Do not convert missing Evidence into a confirmed remediation.",
    ],
    minimumExecutorCapability: "evidence_investigation_v1",
  }));
}

function decisionEffect(decision) {
  if (["investigate", "undecided", "defer"].includes(decision.status)) {
    return { source: "architecture_decision", effectClass: "read_only" };
  }
  if (["adopt", "replace"].includes(decision.status)) {
    return {
      source: "implementation_work",
      effectClass: decision.implementation_path === "managed"
        ? "provider_configuration"
        : "local_source",
    };
  }
  return null;
}

function architectureEvidenceTargets(report, capabilityId) {
  const requiredChecks = CAPABILITY_REQUIRED_CHECKS[capabilityId] ?? [];
  const targets = report.results.checks
    .filter(({ check_id: id }) => requiredChecks.includes(id))
    .flatMap(({ evidence }) => evidence.map(({ target }) => target));
  return targets.length > 0 ? targets : [capabilityId];
}

function architectureTasks(report, architectureRecord) {
  return architectureRecord.confirmed_decisions.flatMap((decision) => {
    const effect = decisionEffect(decision);
    if (!effect) return [];
    const expectedTarget = decision.capability_id ?? decision.decision_id;
    return [baseTask({
      source: effect.source,
      sourceId: decision.decision_id,
      taskType: effect.source === "architecture_decision"
        ? "resolve_architecture_decision"
        : "implement_architecture_decision",
      environment: architectureRecord.environment,
      effectClass: effect.effectClass,
      expectedTarget,
      evidenceTargets: architectureEvidenceTargets(report, expectedTarget),
      recoveryNotes: effect.effectClass === "read_only"
        ? ["Preserve Unknowns and do not select an implementation without explicit confirmation."]
        : [
          "Stop before the next effect when cancellation is requested.",
          "A result claim does not verify the implementation; run fresh Verify.",
        ],
      minimumExecutorCapability: effect.effectClass === "provider_configuration"
        ? "provider_configuration_v1"
        : effect.effectClass === "local_source"
          ? "local_source_remediation_v1"
          : "architecture_investigation_v1",
    })];
  });
}

function addCapabilityDependencies(tasks, capabilityGraph) {
  const taskByTarget = new Map(tasks
    .filter(({ source }) => ["architecture_decision", "implementation_work"].includes(source))
    .map((task) => [task.expected_target, task]));
  for (const edge of capabilityGraph.edges.filter(({ kind }) => kind === "requires")) {
    const prerequisite = taskByTarget.get(edge.from);
    const dependent = taskByTarget.get(edge.to);
    if (prerequisite && dependent && prerequisite.task_id !== dependent.task_id) {
      dependent.prerequisites.push(prerequisite.task_id);
      dependent.prerequisites.sort();
    }
  }
  const findingPrerequisites = tasks
    .filter(({ source }) => source === "finding")
    .map(({ task_id: id }) => id);
  for (const task of tasks.filter(({ source }) => source === "implementation_work")) {
    task.prerequisites = [...new Set([
      ...task.prerequisites,
      ...findingPrerequisites,
    ])].sort();
  }
}

function recomputeStatuses(tasks, stale) {
  for (const task of tasks) {
    if (["not_started", "blocked"].includes(task.status)) task.status = "not_started";
  }
  const ready = new Set(computeTaskGraphReadyFrontier(tasks));
  for (const task of tasks) {
    if (task.status === "not_started" && !ready.has(task.task_id)) task.status = "blocked";
  }
  return stale ? [] : computeTaskGraphReadyFrontier(tasks);
}

function currentnessReasons(report, architectureBundle, reportIsCurrent) {
  const reasons = [];
  if (!reportIsCurrent) reasons.push("source_report_non_current");
  if (architectureBundle.package.currentness.state !== "current") {
    reasons.push(...architectureBundle.package.currentness.reasons.map((reason) =>
      `architecture_package:${reason}`));
  }
  if (!referencesEqual(
    architectureBundle.architecture_record.bindings.source_report,
    reportReference(report),
  )) reasons.push("source_report_changed");
  return [...new Set(reasons)].sort();
}

function validateArchitecture(report, bundle) {
  assertValidArchitecturePackage(bundle?.package);
  assertValidArchitectureRecord(bundle?.architecture_record);
  assertValidCapabilityGraph(bundle?.capability_graph);
  const environment = report.scope.release_intent.intended_environment;
  if (
    bundle.package.environment !== environment
    || bundle.architecture_record.environment !== environment
    || bundle.capability_graph.environment !== environment
  ) {
    const error = new Error("Task Graph inputs cannot cross environments.");
    error.code = "task_graph_environment_mismatch";
    throw error;
  }
  if (
    !referencesEqual(bundle.package.records.architecture_record, reference(
      bundle.architecture_record.record_id,
      bundle.architecture_record.schema_version,
      bundle.architecture_record,
    ))
    || !referencesEqual(bundle.package.records.capability_graph, reference(
      bundle.capability_graph.graph_id,
      bundle.capability_graph.schema_version,
      bundle.capability_graph,
    ))
  ) {
    const error = new Error("Task Graph Architecture Package records are inconsistent.");
    error.code = "task_graph_architecture_binding_mismatch";
    throw error;
  }
}

function verificationEvidenceFor(task, report, evidenceIndex) {
  const requiredChecks = CAPABILITY_REQUIRED_CHECKS[task.expected_target] ?? [];
  const checks = report.results.checks.filter(({
    check_id: checkId,
    status,
  }) => status === "passed"
    && (["finding", "verification_gap"].includes(task.source)
      ? checkId === task.source_id
      : requiredChecks.includes(checkId)));
  if (
    checks.length === 0
    || (!["finding", "verification_gap"].includes(task.source)
      && (checks.length !== requiredChecks.length
        || requiredChecks.some((id) => !checks.some(({ check_id: checkId }) => checkId === id))))
  ) return [];
  const evidenceByDigest = new Map(evidenceIndex.entries.map((entry) => [entry.digest, entry]));
  return checks
    .flatMap(({ evidence }) => evidence)
    .flatMap((referenceValue) => {
      const entry = evidenceByDigest.get(referenceValue.digest);
      return entry?.current === true
        && entry.target === referenceValue.target
        && entry.collected_at === referenceValue.collected_at
        && (["finding", "verification_gap"].includes(task.source)
          || task.evidence_targets.includes(entry.target))
        ? [{
          digest: entry.digest,
          target: entry.target,
          collected_at: entry.collected_at,
          current: true,
        }]
        : [];
    });
}

function verificationEvidenceMatches(task, report, evidenceIndex) {
  const expected = verificationEvidenceFor(task, report, evidenceIndex);
  return expected.length > 0
    && JSON.stringify(expected) === JSON.stringify(task.verification_evidence);
}

function taskSemanticsMatch(previous, current) {
  const omitted = new Set(["status", "verification_evidence"]);
  const semantics = (task) => Object.fromEntries(Object.entries(task)
    .filter(([key]) => !omitted.has(key)));
  return JSON.stringify(semantics(previous)) === JSON.stringify(semantics(current));
}

function applyPreviousState(
  tasks,
  previousGraph,
  updates,
  report,
  evidenceIndex,
  architectureRecord,
) {
  if (!previousGraph) {
    if ((updates ?? []).length > 0) {
      const error = new Error("Task updates require a previous Task Graph.");
      error.code = "task_graph_previous_required";
      throw error;
    }
    return;
  }
  assertValidTaskGraph(previousGraph);
  const currentReportReference = reportReference(report);
  const boundReportReference = architectureRecord.bindings.source_report;
  const architectureReference = reference(
    architectureRecord.record_id,
    architectureRecord.schema_version,
    architectureRecord,
  );
  const architectureIsUnchanged = referencesEqual(
    previousGraph.architecture_record,
    architectureReference,
  );
  if (
    previousGraph.environment !== architectureRecord.environment
    || (architectureIsUnchanged
      && !referencesEqual(previousGraph.source_report, currentReportReference)
      && !referencesEqual(previousGraph.source_report, boundReportReference))
    || previousGraph.tasks.some((task) =>
      task.status === "verified"
      && (architectureIsUnchanged
        || ["finding", "verification_gap"].includes(task.source))
      && !verificationEvidenceMatches(task, report, evidenceIndex))
  ) {
    const error = new Error("The previous Task Graph is not trusted by the current inputs.");
    error.code = "task_graph_previous_untrusted";
    throw error;
  }
  const previousById = new Map(previousGraph.tasks.map((task) => [task.task_id, task]));
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  for (const previous of previousGraph.tasks) {
    if (taskById.has(previous.task_id)) continue;
    if (!["finding", "verification_gap"].includes(previous.source)) continue;
    const verificationEvidence = verificationEvidenceFor(previous, report, evidenceIndex);
    if (verificationEvidence.length === 0) {
      const error = new Error("The previous Task Graph does not describe the same work.");
      error.code = "task_graph_work_changed";
      throw error;
    }
    const pending = structuredClone(previous);
    pending.status = "verification_pending";
    delete pending.verification_evidence;
    pending.evidence_targets = [...new Set([
      ...pending.evidence_targets,
      ...verificationEvidence.map(({ target }) => target),
    ])].sort();
    tasks.push(pending);
    taskById.set(pending.task_id, pending);
    if (pending.source === "finding") {
      for (const implementation of tasks.filter(({ source }) => source === "implementation_work")) {
        implementation.prerequisites = [...new Set([
          ...implementation.prerequisites,
          pending.task_id,
        ])].sort();
      }
    }
  }
  for (const [id, task] of taskById) {
    const previous = previousById.get(id);
    if (!previous) continue;
    if (
      !taskSemanticsMatch(previous, task)
      || (!architectureIsUnchanged
        && ["architecture_decision", "implementation_work"].includes(task.source))
    ) continue;
    if (task.status === "verified" && task.verification_evidence) continue;
    task.status = previous.status;
    if (previous.verification_evidence) {
      task.verification_evidence = structuredClone(previous.verification_evidence);
    }
  }
  const seen = new Set();
  for (const update of updates ?? []) {
    const task = taskById.get(update?.task_id);
    const reportEvidence = task
      ? verificationEvidenceFor(task, report, evidenceIndex)
      : [];
    const verificationEvidenceIsCurrent = update?.status !== "verified"
      || task !== undefined
      && Array.isArray(update.verification_evidence)
      && JSON.stringify(update.verification_evidence) === JSON.stringify(reportEvidence);
    if (
      !task
      || seen.has(update.task_id)
      || ![
        "not_started",
        "blocked",
        "running",
        "reported_succeeded",
        "reported_failed",
        "cancelled",
        "verification_pending",
        "verified",
      ].includes(update.status)
      || (update.status === "verified"
        && !verificationEvidenceIsCurrent)
      || (update.status !== "verified"
        && update.verification_evidence !== undefined)
      || !verificationEvidenceIsCurrent
    ) {
      const error = new Error("A Task Graph status update is invalid.");
      error.code = "invalid_task_graph_update";
      throw error;
    }
    seen.add(update.task_id);
    task.status = update.status;
    delete task.verification_evidence;
    if (update.status === "verified") {
      task.verification_evidence = structuredClone(reportEvidence);
    }
  }
}

export function generateTaskGraph(reportPackage, architectureBundle, options = {}) {
  assertValidReportPackage(reportPackage);
  const report = reportPackage.report;
  validateArchitecture(report, architectureBundle);
  const reportCurrentness = evaluateReportCurrentness(reportPackage, {
    cwd: options.cwd ?? process.cwd(),
    ...(options.now ? { now: options.now } : {}),
  });
  const reasons = currentnessReasons(
    report,
    architectureBundle,
    reportCurrentness.current,
  );
  const tasks = [
    ...findingTasks(report),
    ...gapTasks(report),
    ...architectureTasks(report, architectureBundle.architecture_record),
  ];
  if (tasks.length === 0) {
    const error = new Error("No Task Graph work is available.");
    error.code = "task_graph_empty";
    throw error;
  }
  addCapabilityDependencies(tasks, architectureBundle.capability_graph);
  applyPreviousState(
    tasks,
    options.previous_graph,
    options.task_updates,
    report,
    reportPackage.evidence_index,
    architectureBundle.architecture_record,
  );
  const revision = options.previous_graph ? options.previous_graph.revision + 1 : 1;
  const stale = reasons.length > 0;
  const readyFrontier = recomputeStatuses(tasks, stale);
  const graphContent = {
    revision,
    environment: report.scope.release_intent.intended_environment,
    source_report: reportReference(report),
    architecture_record: reference(
      architectureBundle.architecture_record.record_id,
      architectureBundle.architecture_record.schema_version,
      architectureBundle.architecture_record,
    ),
    currentness: {
      state: stale ? "stale" : "current",
      reasons,
    },
    tasks,
    ready_frontier: readyFrontier,
  };
  const graph = {
    schema_version: TASK_GRAPH_SCHEMA,
    graph_id: `task_graph_${sha256(graphContent).slice(7, 27)}`,
    ...graphContent,
  };
  assertValidTaskGraph(graph);
  return graph;
}

function executorMatches(task, descriptor) {
  const executorAllowed = new Set(descriptor.allowed_effects);
  const executorProhibited = new Set(descriptor.prohibited_effects);
  return descriptor.supported_task_types.includes(task.task_type)
    && descriptor.environments.includes(task.environment)
    && descriptor.result_schema === task.structured_result_schema
    && task.allowed_effects.every((effect) => executorAllowed.has(effect))
    && descriptor.allowed_effects.every((effect) => task.allowed_effects.includes(effect))
    && task.allowed_effects.every((effect) => !executorProhibited.has(effect))
    && task.prohibited_effects.every((effect) => executorProhibited.has(effect));
}

export function mapTaskGraphExecutors(graph, descriptors = []) {
  assertValidTaskGraph(graph);
  descriptors.forEach(assertValidExecutorDescriptor);
  return {
    graph_id: graph.graph_id,
    tasks: graph.tasks.map((task) => ({
      task_id: task.task_id,
      managed_executor_ids: descriptors.filter((descriptor) =>
        executorMatches(task, descriptor))
        .map(({ descriptor_id: id }) => id)
        .sort(),
      manual_path: {
        available: true,
        kind: "manual_or_custom",
        required_capability: task.minimum_executor_capability,
      },
    })),
  };
}
