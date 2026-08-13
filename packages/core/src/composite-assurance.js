import {
  ARCHITECTURE_STATUS_SCHEMA,
  COMPOSITE_ASSURANCE_SCHEMA,
  COMPOSITE_ASSURANCE_STATES,
  CAPABILITY_MINIMUM_ASSURANCE,
  assertValidArchitectureRecord,
  assertValidArchitectureStatus,
  assertValidCapabilityGraph,
  assertValidCompositeAssurance,
  assertValidIntegrationContract,
  assertValidReportPackage,
  capabilityAssuranceMeetsMinimum,
  deriveCapabilityAssuranceState,
  deriveArchitectureStatusId,
  deriveArchitectureStatusSummary,
  deriveCompositeLaunchAssessment,
} from "@launchrally/contracts";
import { sha256 } from "./local-history.js";
import { createRecordReference, createReportReference } from "./record-reference.js";

const CHECK_LAYERS = Object.freeze([
  "requirement",
  "local_implementation",
  "provider_configuration",
  "integration_consistency",
  "deployment",
  "operational_delivery",
  "downstream_outcome",
]);

const ASSURANCE_POLICY_VERSION = "composite-assurance-policy/v1";

function invalidInput(message) {
  const error = new Error(message);
  error.code = "invalid_composite_assurance_input";
  throw error;
}

function evidenceQualifies(evidence, environment) {
  return typeof evidence?.digest === "string"
    && typeof evidence.source === "string"
    && evidence.source.length > 0
    && typeof evidence.target === "string"
    && evidence.target.length > 0
    && evidence.environment === environment
    && evidence.current === true;
}

function normalizedCheck(check, environment, capabilityIds) {
  if (
    !check
    || typeof check.check_id !== "string"
    || !Number.isInteger(check.check_version)
    || !CHECK_LAYERS.includes(check.check_layer)
    || check.environment !== environment
    || !Array.isArray(check.capability_ids)
    || check.capability_ids.length === 0
    || check.capability_ids.some((capabilityId) => !capabilityIds.has(capabilityId))
    || !["passed", "failed", "unverified", "not_applicable"].includes(check.status)
    || !Array.isArray(check.evidence)
    || (check.check_layer === "integration_consistency"
      && (!Array.isArray(check.integration_contract_ids)
        || check.integration_contract_ids.length === 0))
  ) invalidInput(`Layered Check ${check?.check_id ?? "unknown"} must be typed and bound to the assurance environment.`);

  const evidence = check.evidence.filter((entry) => evidenceQualifies(entry, environment));
  const evidenceComplete = evidence.length === check.evidence.length;
  let status = check.status;
  let reasonCode = check.reason_code;
  if (status === "passed" && (evidence.length === 0 || !evidenceComplete)) {
    status = "unverified";
    reasonCode = "insufficient_environment_bound_evidence";
  }
  if (
    status === "failed"
    && check.failure_basis === "absence"
    && (
      check.coverage?.state !== "complete"
      || check.coverage.required_targets?.length === 0
      || check.coverage.required_targets?.some((target) =>
        !check.coverage.observed_targets?.includes(target))
      || evidence.length === 0
      || !evidenceComplete
    )
  ) {
    status = "unverified";
    reasonCode = "incomplete_negative_observation";
  }
  return {
    ...structuredClone(check),
    status,
    ...(reasonCode ? { reason_code: reasonCode } : {}),
    evidence,
  };
}

function aggregateLayer(layer, checks, applicable, requiredBindings = []) {
  if (!applicable) {
    return { layer, status: "not_applicable", check_refs: [], evidence_refs: [] };
  }
  if (checks.length === 0) {
    return { layer, status: "unverified", check_refs: [], evidence_refs: [] };
  }
  const missingBinding = requiredBindings.some((binding) => !checks.some((check) =>
    check.integration_contract_ids?.includes(binding)));
  const status = missingBinding
    ? "unverified"
    : checks.some((check) => check.status === "failed")
    ? "failed"
    : checks.some((check) => check.status === "unverified")
      ? "unverified"
      : checks.every((check) => check.status === "not_applicable")
        ? "not_applicable"
        : checks.every((check) => ["passed", "not_applicable"].includes(check.status))
          ? "passed"
          : "unverified";
  return {
    layer,
    status,
    check_refs: checks.map(({ check_id: checkId, check_version: checkVersion }) => ({
      check_id: checkId,
      check_version: checkVersion,
      status: checks.find((check) => check.check_id === checkId).status,
    })),
    evidence_refs: checks.flatMap((check) => check.evidence.map((entry) => ({
      digest: entry.digest,
      source: entry.source,
      target: entry.target,
      environment: entry.environment,
    }))),
  };
}

function decisionFor(capabilityId, architectureRecord) {
  return architectureRecord.confirmed_decisions.find(
    ({ capability_id: decisionCapabilityId }) => decisionCapabilityId === capabilityId,
  );
}

export function deriveArchitectureStatus(input) {
  try {
    assertValidArchitectureRecord(input?.architecture_record);
  } catch {
    invalidInput("Architecture Status requires a valid immutable Architecture Record.");
  }
  const currentness = input?.currentness;
  if (![
    "current",
    "needs_reassessment",
    "partially_invalidated",
    "superseded",
  ].includes(currentness)) invalidInput("Architecture Status requires explicit currentness.");
  const architectureRecord = input.architecture_record;
  const decisionStates = architectureRecord.confirmed_decisions.map(
    ({ decision_id: decisionId, status: state }) => ({ decision_id: decisionId, state }),
  );
  const unknowns = decisionStates
    .filter(({ state }) => ["investigate", "undecided"].includes(state))
    .map(({ decision_id: decisionId, state }) => `${decisionId}:${state}`);
  const status = {
    schema_version: ARCHITECTURE_STATUS_SCHEMA,
    status_id: "pending",
    architecture_record: createRecordReference(
      architectureRecord.record_id,
      architectureRecord.schema_version,
      architectureRecord,
    ),
    environment: architectureRecord.environment,
    currentness,
    summary: deriveArchitectureStatusSummary(currentness, decisionStates),
    decision_states: decisionStates,
    unknowns,
    launch_assessment: {
      independent: true,
      assessment_ref: null,
    },
  };
  status.status_id = deriveArchitectureStatusId(status);
  assertValidArchitectureStatus(status);
  return status;
}

export function deriveCompositeAssurance(input) {
  try {
    assertValidCapabilityGraph(input?.capability_graph);
    assertValidArchitectureRecord(input?.architecture_record);
    input?.integration_contracts?.forEach(assertValidIntegrationContract);
  } catch {
    invalidInput("Composite assurance requires valid Phase 1 source records.");
  }
  const environment = input?.environment;
  const graph = input.capability_graph;
  const architectureRecord = input.architecture_record;
  if (
    typeof environment !== "string"
    || environment.length === 0
    || graph.environment !== environment
    || architectureRecord.environment !== environment
    || ![
      "current",
      "needs_reassessment",
      "partially_invalidated",
      "superseded",
    ].includes(input.architecture_currentness)
    || !Array.isArray(input.integration_contracts)
    || input.integration_contracts.some((contract) => contract.environment !== environment)
    || !Array.isArray(input.checks)
  ) invalidInput("Composite assurance sources cannot cross environments.");

  const capabilityIds = new Set(graph.nodes.map(({ capability_id: capabilityId }) => capabilityId));
  const checks = input.checks.map((check) => normalizedCheck(check, environment, capabilityIds));
  if (new Set(checks.map(({ check_id: checkId }) => checkId)).size !== checks.length) {
    invalidInput("Layered Check identities must be unique.");
  }
  const architectureStatus = deriveArchitectureStatus({
    architecture_record: architectureRecord,
    currentness: input.architecture_currentness,
  });

  const capabilities = graph.nodes.map((node) => {
    const capabilityId = node.capability_id;
    const decision = decisionFor(capabilityId, architectureRecord);
    const excluded = ["deferred", "not_applicable"].includes(node.requirement_state);
    const implementationPath = decision?.implementation_path ?? node.implementation_path;
    const providerApplicable = ["managed", "existing_platform"].includes(implementationPath);
    const relevantContracts = input.integration_contracts.filter((contract) =>
      contract.source_capability_id === capabilityId
      || contract.target_capability_id === capabilityId);
    const checksFor = (layer) => checks.filter((check) =>
      check.check_layer === layer && check.capability_ids.includes(capabilityId));
    const facets = Object.fromEntries([
      ["requirement", aggregateLayer(
        "requirement",
        checksFor("requirement"),
        !excluded,
      )],
      ["local_implementation", aggregateLayer(
        "local_implementation",
        checksFor("local_implementation"),
        !excluded,
      )],
      ["provider_configuration", aggregateLayer(
        "provider_configuration",
        checksFor("provider_configuration"),
        !excluded && providerApplicable,
      )],
      ["integration_consistency", aggregateLayer(
        "integration_consistency",
        checksFor("integration_consistency"),
        !excluded && relevantContracts.length > 0,
        relevantContracts.map(({ contract_id: contractId }) => contractId),
      )],
      ["deployment", aggregateLayer("deployment", checksFor("deployment"), !excluded)],
      ["operational_delivery", aggregateLayer(
        "operational_delivery",
        checksFor("operational_delivery"),
        !excluded,
      )],
      ["downstream_outcome", aggregateLayer(
        "downstream_outcome",
        checksFor("downstream_outcome"),
        !excluded,
      )],
    ]);
    const state = deriveCapabilityAssuranceState({
      requirement_state: node.requirement_state,
      implementation_path: implementationPath,
      facets,
    });
    const minimum = node.requirement_state === "required"
      && node.release_scope === "current_release"
      ? CAPABILITY_MINIMUM_ASSURANCE[capabilityId] ?? "operationally_verified"
      : null;
    return {
      capability_id: capabilityId,
      environment,
      release_scope: node.release_scope,
      requirement_state: node.requirement_state,
      decision_ref: decision
        ? { decision_id: decision.decision_id, decision_revision: decision.decision_revision }
        : null,
      implementation_path: implementationPath,
      integration_contract_ids: relevantContracts.map(({ contract_id: contractId }) => contractId),
      minimum_assurance: minimum,
      facets,
      assurance_state: state,
      launch_gate: {
        gating: node.requirement_state === "required"
          && node.release_scope === "current_release",
        satisfied: capabilityAssuranceMeetsMinimum({
          assurance_state: state,
          minimum_assurance: minimum,
        }),
      },
    };
  });
  const gating = capabilities.filter(({ launch_gate: launchGate }) => launchGate.gating);
  const assessment = deriveCompositeLaunchAssessment(capabilities);
  const checkRefs = capabilities.flatMap(({ facets }) =>
    Object.values(facets).flatMap(({ check_refs: references }) => references));
  const checkIdsWithStatus = (status) => [...new Set(checkRefs
    .filter((reference) => reference.status === status)
    .map(({ check_id: checkId }) => checkId))];
  const source = {
    capability_graph: createRecordReference(graph.graph_id, graph.schema_version, graph),
    architecture_record: createRecordReference(
      architectureRecord.record_id,
      architectureRecord.schema_version,
      architectureRecord,
    ),
    integration_contracts: input.integration_contracts.map((contract) =>
      createRecordReference(contract.contract_id, contract.schema_version, contract)),
    check_set_digest: sha256(checks),
    source_report: input.source_report ?? null,
    evidence_index: input.source_evidence_index ?? null,
    architecture_status: createRecordReference(
      architectureStatus.status_id,
      architectureStatus.schema_version,
      architectureStatus,
    ),
  };
  const result = {
    schema_version: COMPOSITE_ASSURANCE_SCHEMA,
    assurance_id: `assurance_${sha256({
      policy_version: ASSURANCE_POLICY_VERSION,
      environment,
      source,
    }).slice(7, 27)}`,
    policy_version: ASSURANCE_POLICY_VERSION,
    environment,
    source,
    capabilities,
    launch_assessment: {
      assessment,
      gating_capability_ids: gating.map(({ capability_id: capabilityId }) => capabilityId),
      failed_check_ids: checkIdsWithStatus("failed"),
      verification_gap_check_ids: checkIdsWithStatus("unverified"),
    },
    architecture_status: {
      independent: true,
      status: architectureStatus,
    },
  };
  assertValidCompositeAssurance(result);
  return result;
}

export function deriveCompositeAssuranceFromReport(input) {
  try {
    assertValidReportPackage(input?.report_package);
  } catch {
    invalidInput("Composite assurance requires a valid current Report Package.");
  }
  const { report, evidence_index: evidenceIndex } = input.report_package;
  const expectedReportBinding = createReportReference(report);
  if (
    report.policy.current !== true
    || report.scope.release_intent.intended_environment !== input.environment
    || JSON.stringify(input.architecture_record?.bindings?.source_report)
      !== JSON.stringify(expectedReportBinding)
    || report.results.checks.some((check) => check.environment !== input.environment)
    || evidenceIndex.entries.some((entry) => entry.environment !== input.environment)
  ) invalidInput("Composite assurance requires the bound current Report environment.");
  const capabilityIds = new Set(input.capability_graph?.nodes?.map(
    ({ capability_id: capabilityId }) => capabilityId,
  ) ?? []);
  const evidenceByDigest = new Map(evidenceIndex.entries.map((entry) => [entry.digest, entry]));
  const reportChecks = report.results.checks.flatMap((check) => {
    const capabilities = (check.capability_ids ?? []).filter((capabilityId) =>
      capabilityIds.has(capabilityId));
    if (!check.check_layer || capabilities.length === 0 || !check.environment) return [];
    return [{
      check_id: check.check_id,
      check_version: check.check_version,
      check_layer: check.check_layer,
      capability_ids: capabilities,
      environment: check.environment,
      status: check.status,
      ...(check.failure_basis ? { failure_basis: check.failure_basis } : {}),
      ...(check.coverage ? { coverage: structuredClone(check.coverage) } : {}),
      evidence: check.evidence.flatMap((reference) => {
        const entry = evidenceByDigest.get(reference.digest);
        return entry ? [{
          digest: entry.digest,
          source: entry.source,
          target: entry.target,
          environment: entry.environment,
          current: entry.current,
        }] : [];
      }),
    }];
  });
  return deriveCompositeAssurance({
    ...input,
    source_report: expectedReportBinding,
    source_evidence_index: createRecordReference(
      evidenceIndex.index_id,
      evidenceIndex.schema_version,
      evidenceIndex,
    ),
    checks: [...reportChecks, ...(input.additional_checks ?? [])],
  });
}

export const COMPOSITE_ASSURANCE_LAYERS = CHECK_LAYERS;
export { COMPOSITE_ASSURANCE_STATES };
