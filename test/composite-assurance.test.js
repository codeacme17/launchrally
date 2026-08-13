import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  COMPOSITE_ASSURANCE_SCHEMA,
  assertValidCompositeAssurance,
} from "../packages/contracts/src/index.js";
import {
  deriveCompositeAssurance,
  deriveCompositeAssuranceFromReport,
  runAudit,
} from "../packages/core/src/index.js";

const capabilityFixture = JSON.parse(await readFile(
  new URL("./fixtures/phase-1-contracts/capability-model.valid.json", import.meta.url),
  "utf8",
));
const architectureFixture = JSON.parse(await readFile(
  new URL("./fixtures/phase-1-contracts/architecture.valid.json", import.meta.url),
  "utf8",
));

const DIGESTS = Object.freeze({
  local: `sha256:${"1".repeat(64)}`,
  configuration: `sha256:${"2".repeat(64)}`,
  deployment: `sha256:${"3".repeat(64)}`,
  operational: `sha256:${"4".repeat(64)}`,
  outcome: `sha256:${"5".repeat(64)}`,
});

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

function layeredCheck(layer, digest) {
  return {
    check_id: `identity_${layer}`,
    check_version: 1,
    check_layer: layer,
    capability_ids: ["identity_authentication"],
    environment: "production",
    ...(layer === "integration_consistency"
      ? { integration_contract_ids: ["integration_identity_data"] }
      : {}),
    status: "passed",
    coverage: {
      state: "complete",
      required_targets: [`identity:${layer}`],
      observed_targets: [`identity:${layer}`],
    },
    evidence: [{
      digest,
      source: "test-collector/v1",
      target: `identity:${layer}`,
      environment: "production",
      current: true,
    }],
  };
}

function source(overrides = {}) {
  const graph = structuredClone(capabilityFixture.graph);
  const architectureRecord = structuredClone(architectureFixture.record);
  architectureRecord.confirmed_decisions[0] = {
    decision_id: "decision_identity",
    decision_revision: 1,
    capability_id: "identity_authentication",
    implementation_path: "managed",
    confirmation: "explicit_user_confirmation",
    status: "adopt",
  };
  return {
    environment: "production",
    capability_graph: graph,
    architecture_record: architectureRecord,
    integration_contracts: [],
    checks: [],
    ...overrides,
  };
}

test("assurance advances only through contiguous environment-bound Check layers", () => {
  const checks = [
    layeredCheck("local_implementation", DIGESTS.local),
    layeredCheck("provider_configuration", DIGESTS.configuration),
    layeredCheck("deployment", DIGESTS.deployment),
    layeredCheck("operational_delivery", DIGESTS.operational),
    layeredCheck("downstream_outcome", DIGESTS.outcome),
  ];
  const expected = [
    "locally_evidenced",
    "configured_not_deployed",
    "deployed_not_operationally_verified",
    "operationally_verified",
    "outcome_verified",
  ];

  for (let index = 0; index < checks.length; index += 1) {
    const result = deriveCompositeAssurance(source({ checks: checks.slice(0, index + 1) }));
    const identity = result.capabilities.find(
      ({ capability_id: capabilityId }) => capabilityId === "identity_authentication",
    );

    assert.equal(identity.assurance_state, expected[index]);
    assert.equal(identity.environment, "production");
  }

  const providerOnly = deriveCompositeAssurance(source({ checks: [checks[1]] }));
  assert.equal(providerOnly.capabilities[0].assurance_state, "unverified");

  const complete = deriveCompositeAssurance(source({ checks }));
  assert.equal(COMPOSITE_ASSURANCE_SCHEMA, "launchrally.dev/composite-assurance/v1");
  assert.equal(assertValidCompositeAssurance(complete), true);
  const crossEnvironmentOutput = structuredClone(complete);
  crossEnvironmentOutput.capabilities[0].environment = "staging";
  assert.throws(
    () => assertValidCompositeAssurance(crossEnvironmentOutput),
    (error) => error.code === "invalid_composite_assurance",
  );
});

test("cross-environment or incomplete negative observations remain Unverified", () => {
  const crossEnvironment = layeredCheck("local_implementation", DIGESTS.local);
  crossEnvironment.evidence[0].environment = "staging";
  const crossEnvironmentResult = deriveCompositeAssurance(source({
    checks: [crossEnvironment],
  }));
  assert.equal(
    crossEnvironmentResult.capabilities[0].facets.local_implementation.status,
    "unverified",
  );
  assert.equal(crossEnvironmentResult.capabilities[0].assurance_state, "unverified");

  const uncoveredAbsence = {
    ...layeredCheck("local_implementation", DIGESTS.local),
    status: "failed",
    failure_basis: "absence",
    coverage: {
      state: "partial",
      required_targets: ["identity:local_implementation"],
      observed_targets: [],
    },
  };
  const absenceResult = deriveCompositeAssurance(source({ checks: [uncoveredAbsence] }));
  assert.equal(
    absenceResult.capabilities[0].facets.local_implementation.status,
    "unverified",
  );
  assert.equal(absenceResult.launch_assessment.assessment, "inconclusive");
  assert.deepEqual(
    absenceResult.launch_assessment.verification_gap_check_ids,
    ["identity_local_implementation"],
  );
});

test("Contract prerequisites gate Required capabilities while Optional failures stay warnings", () => {
  const value = source();
  value.capability_graph.nodes.push({
    capability_id: "application_data",
    environment: "production",
    requirement_state: "optional",
    decision_state: "retain",
    implementation_state: "present",
    evidence_state: "unverified",
    implementation_path: "application_native",
  });
  value.architecture_record.confirmed_decisions.push({
    decision_id: "decision_application_data",
    decision_revision: 1,
    capability_id: "application_data",
    implementation_path: "application_native",
    confirmation: "explicit_user_confirmation",
    status: "retain",
  });
  value.integration_contracts = [structuredClone(capabilityFixture.integration)];
  value.checks = [
    layeredCheck("local_implementation", DIGESTS.local),
    layeredCheck("provider_configuration", DIGESTS.configuration),
    layeredCheck("integration_consistency", `sha256:${"6".repeat(64)}`),
    layeredCheck("deployment", DIGESTS.deployment),
    layeredCheck("operational_delivery", DIGESTS.operational),
    {
      ...layeredCheck("local_implementation", `sha256:${"7".repeat(64)}`),
      check_id: "application_data_local",
      capability_ids: ["application_data"],
      status: "failed",
      failure_basis: "observed_conflict",
    },
  ];

  const result = deriveCompositeAssurance(value);
  const identity = result.capabilities.find(
    ({ capability_id: capabilityId }) => capabilityId === "identity_authentication",
  );
  const applicationData = result.capabilities.find(
    ({ capability_id: capabilityId }) => capabilityId === "application_data",
  );

  assert.equal(identity.assurance_state, "operationally_verified");
  assert.equal(identity.launch_gate.satisfied, true);
  assert.equal(applicationData.launch_gate.gating, false);
  assert.equal(applicationData.facets.local_implementation.status, "failed");
  assert.equal(result.launch_assessment.assessment, "ready_with_warnings");

  const withoutContractProof = deriveCompositeAssurance({
    ...value,
    checks: value.checks.filter(({ check_layer: layer }) => layer !== "integration_consistency"),
  });
  assert.equal(withoutContractProof.launch_assessment.assessment, "inconclusive");
});

test("a current Report feeds layered assurance without promoting missing higher layers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-assurance-"));
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "assurance-web", scripts: { build: "vite build" } }),
  );
  await writeFile(path.join(directory, "package-lock.json"), '{"lockfileVersion":3}');
  const initial = await runAudit(directory, "0.3.2");
  const confirmation = await runAudit(directory, "0.3.2", {
    resume_token: initial.interaction.resume_token,
    answers: {
      intended_environment: "production",
      production_targets: ["https://example.com"],
      core_journeys: ["homepage loads"],
      provider_roles: [],
      support_layers: [],
    },
  });
  const permission = await runAudit(directory, "0.3.2", {
    resume_token: confirmation.interaction.resume_token,
    confirmation: "confirm",
  });
  const reportPackage = await runAudit(directory, "0.3.2", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });
  const graph = structuredClone(capabilityFixture.graph);
  graph.nodes = [{
    capability_id: "runtime_execution",
    environment: "production",
    requirement_state: "required",
    decision_state: "retain",
    implementation_state: "present",
    evidence_state: "unverified",
    implementation_path: "application_native",
  }];
  graph.derived_obligations = [];
  const architectureRecord = structuredClone(architectureFixture.record);
  architectureRecord.bindings.source_report = reportBinding(reportPackage.report);
  architectureRecord.confirmed_decisions = [{
    decision_id: "decision_runtime",
    decision_revision: 1,
    capability_id: "runtime_execution",
    implementation_path: "application_native",
    confirmation: "explicit_user_confirmation",
    status: "retain",
  }];

  const result = deriveCompositeAssuranceFromReport({
    environment: "production",
    report_package: reportPackage,
    capability_graph: graph,
    architecture_record: architectureRecord,
    integration_contracts: [],
  });

  assert.equal(result.capabilities[0].facets.local_implementation.status, "passed");
  assert.equal(result.capabilities[0].assurance_state, "locally_evidenced");
  assert.equal(result.capabilities[0].facets.deployment.status, "unverified");
  assert.equal(result.launch_assessment.assessment, "inconclusive");
});
