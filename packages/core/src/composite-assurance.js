import { createHash } from "node:crypto";

import {
  COMPOSITE_ASSURANCE_SCHEMA,
  assertValidArchitectureRecord,
  assertValidCapabilityGraph,
  assertValidCompositeAssurance,
  assertValidIntegrationContract,
  assertValidReportPackage,
} from "@launchrally/contracts";

const CHECK_LAYERS = Object.freeze([
  "requirement",
  "local_implementation",
  "provider_configuration",
  "integration_consistency",
  "deployment",
  "operational_delivery",
  "downstream_outcome",
]);

const ASSURANCE_RANK = Object.freeze([
  "unverified",
  "locally_evidenced",
  "configured_not_deployed",
  "deployed_not_operationally_verified",
  "operationally_verified",
  "outcome_verified",
]);
const ASSURANCE_POLICY_VERSION = "composite-assurance-policy/v1";

const MINIMUM_ASSURANCE = Object.freeze({
  runtime_execution: "operationally_verified",
  identity_authentication: "operationally_verified",
  application_data: "operationally_verified",
  billing_entitlement: "outcome_verified",
  object_storage: "operationally_verified",
  communication_delivery: "outcome_verified",
  background_work: "operationally_verified",
  operational_observability: "operationally_verified",
  analytics_privacy: "outcome_verified",
  dns_tls: "operationally_verified",
  ci_cd: "deployed_not_operationally_verified",
  secrets_configuration: "configured_not_deployed",
  backup_recovery_retention: "outcome_verified",
});

function invalidInput(message) {
  const error = new Error(message);
  error.code = "invalid_composite_assurance_input";
  throw error;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function reportBinding(report) {
  const digest = `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalValue(report)))
    .digest("hex")}`;
  return {
    id: `report_${digest.slice(7, 27)}`,
    schema_version: report.schema_version,
    digest,
  };
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
  ) invalidInput("Layered Checks must be typed and bound to the assurance environment.");

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

function assuranceState(facets, providerApplicable) {
  const passed = (layer) => ["passed", "not_applicable"].includes(facets[layer].status);
  if (!passed("requirement") || !passed("local_implementation")) return "unverified";
  let state = "locally_evidenced";
  if (!passed("provider_configuration") || !passed("integration_consistency")) return state;
  if (providerApplicable) state = "configured_not_deployed";
  if (!passed("deployment")) return state;
  state = "deployed_not_operationally_verified";
  if (!passed("operational_delivery")) return state;
  state = "operationally_verified";
  if (!passed("downstream_outcome")) return state;
  return "outcome_verified";
}

function rank(state) {
  return ASSURANCE_RANK.indexOf(state);
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
    || !Array.isArray(input.integration_contracts)
    || input.integration_contracts.some((contract) => contract.environment !== environment)
    || !Array.isArray(input.checks)
  ) invalidInput("Composite assurance sources cannot cross environments.");

  const capabilityIds = new Set(graph.nodes.map(({ capability_id: capabilityId }) => capabilityId));
  const checks = input.checks.map((check) => normalizedCheck(check, environment, capabilityIds));
  if (new Set(checks.map(({ check_id: checkId }) => checkId)).size !== checks.length) {
    invalidInput("Layered Check identities must be unique.");
  }

  const capabilities = graph.nodes.map((node) => {
    const capabilityId = node.capability_id;
    const decision = decisionFor(capabilityId, architectureRecord);
    const excluded = ["deferred", "not_applicable"].includes(node.requirement_state);
    const requirementStatus = excluded
      ? "not_applicable"
      : node.requirement_state === "required" || node.requirement_state === "optional"
        ? decision && !["investigate", "undecided"].includes(decision.status)
          ? "passed"
          : "unverified"
        : "unverified";
    const implementationPath = decision?.implementation_path ?? node.implementation_path;
    const providerApplicable = ["managed", "existing_platform"].includes(implementationPath);
    const relevantContracts = input.integration_contracts.filter((contract) =>
      contract.source_capability_id === capabilityId
      || contract.target_capability_id === capabilityId);
    const checksFor = (layer) => checks.filter((check) =>
      check.check_layer === layer && check.capability_ids.includes(capabilityId));
    const facets = Object.fromEntries([
      ["requirement", {
        layer: "requirement",
        status: requirementStatus,
        check_refs: [{
          check_id: `requirement.${capabilityId}`,
          check_version: 1,
          status: requirementStatus,
        }],
        evidence_refs: [],
      }],
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
    const state = excluded ? "unverified" : assuranceState(facets, providerApplicable);
    const minimum = node.requirement_state === "required"
      ? MINIMUM_ASSURANCE[capabilityId] ?? "operationally_verified"
      : null;
    return {
      capability_id: capabilityId,
      environment,
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
        gating: node.requirement_state === "required",
        satisfied: minimum === null || rank(state) >= rank(minimum),
      },
    };
  });
  const gating = capabilities.filter(({ launch_gate: launchGate }) => launchGate.gating);
  const gatingFailed = gating.some(({ facets }) =>
    Object.values(facets).some(({ status }) => status === "failed"));
  const hasNonGatingWarning = capabilities
    .filter(({ launch_gate: launchGate }) => !launchGate.gating)
    .some(({ facets }) => Object.values(facets)
      .some(({ status }) => ["failed", "unverified"].includes(status)));
  const assessment = gatingFailed
    ? "no_go"
    : gating.some(({ launch_gate: launchGate }) => !launchGate.satisfied)
      ? "inconclusive"
      : hasNonGatingWarning
        ? "ready_with_warnings"
        : "launch_ready";
  const checkRefs = capabilities.flatMap(({ facets }) =>
    Object.values(facets).flatMap(({ check_refs: references }) => references));
  const checkIdsWithStatus = (status) => [...new Set(checkRefs
    .filter((reference) => reference.status === status)
    .map(({ check_id: checkId }) => checkId))];
  const result = {
    schema_version: COMPOSITE_ASSURANCE_SCHEMA,
    assurance_id: `assurance_${architectureRecord.record_id}_${graph.revision}`,
    policy_version: ASSURANCE_POLICY_VERSION,
    environment,
    source: {
      capability_graph_id: graph.graph_id,
      architecture_record_id: architectureRecord.record_id,
      integration_contract_ids: input.integration_contracts.map(
        ({ contract_id: contractId }) => contractId,
      ),
    },
    capabilities,
    launch_assessment: {
      assessment,
      gating_capability_ids: gating.map(({ capability_id: capabilityId }) => capabilityId),
      failed_check_ids: checkIdsWithStatus("failed"),
      verification_gap_check_ids: checkIdsWithStatus("unverified"),
    },
    architecture_status: {
      independent: true,
      architecture_record_id: architectureRecord.record_id,
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
  const expectedReportBinding = reportBinding(report);
  if (
    report.policy.current !== true
    || report.scope.release_intent.intended_environment !== input.environment
    || JSON.stringify(input.architecture_record?.bindings?.source_report)
      !== JSON.stringify(expectedReportBinding)
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
          environment: report.scope.release_intent.intended_environment,
          current: entry.current,
        }] : [];
      }),
    }];
  });
  return deriveCompositeAssurance({
    ...input,
    checks: [...reportChecks, ...(input.additional_checks ?? [])],
  });
}

export const COMPOSITE_ASSURANCE_LAYERS = CHECK_LAYERS;
export const COMPOSITE_ASSURANCE_STATES = ASSURANCE_RANK;
