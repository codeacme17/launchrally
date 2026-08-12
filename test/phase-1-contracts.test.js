import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  ARCHITECTURE_BLUEPRINT_SCHEMA,
  ARCHITECTURE_PACKAGE_SCHEMA,
  ARCHITECTURE_RECORD_SCHEMA,
  ARCHITECT_INTERACTION_SCHEMA,
  ARCHITECTURE_STATUS_SCHEMA,
  ACTIVE_VERIFICATION_REQUEST_SCHEMA,
  ACTIVE_VERIFICATION_RESULT_SCHEMA,
  CAPABILITY_CATALOG_SCHEMA,
  CAPABILITY_GRAPH_SCHEMA,
  INTEGRATION_CONTRACT_SCHEMA,
  EXECUTION_RECEIPT_SCHEMA,
  EXECUTOR_DESCRIPTOR_SCHEMA,
  HANDOFF_PACKAGE_SCHEMA,
  HANDOFF_INTERACTION_SCHEMA,
  PHASE_1_SCHEMA_VERSIONS,
  PRODUCT_INTENT_PROFILE_SCHEMA,
  TASK_GRAPH_SCHEMA,
  assertValidArchitectureBlueprint,
  assertValidArchitecturePackage,
  assertValidArchitectureRecord,
  assertValidArchitectInteraction,
  assertValidArchitectureStatus,
  assertValidActiveVerificationRequest,
  assertValidActiveVerificationResult,
  assertValidCapabilityCatalog,
  assertValidCapabilityGraph,
  assertValidIntegrationContract,
  assertValidExecutionReceipt,
  assertValidExecutorDescriptor,
  assertValidHandoffPackage,
  assertValidHandoffInteraction,
  assertSupportedPhase1Version,
  assertValidPhase1References,
  assertValidPhase1Record,
  assertValidProductIntentProfile,
  assertValidTaskGraph,
} from "../packages/contracts/src/index.js";

const fixtures = path.resolve("test/fixtures/phase-1-contracts");

async function readFixture(name) {
  return JSON.parse(await readFile(path.join(fixtures, name), "utf8"));
}

function setPath(source, dottedPath, value) {
  const result = structuredClone(source);
  const segments = dottedPath.split(".");
  const property = segments.pop();
  const target = segments.reduce((current, segment) => current[segment], result);
  target[property] = value;
  return result;
}

async function allPositiveRecords() {
  const intent = await readFixture("product-intent-profile.valid.json");
  const { catalog, graph, integration } = await readFixture("capability-model.valid.json");
  const { blueprint, record, package: architecturePackage } = await readFixture(
    "architecture.valid.json",
  );
  const { task_graph: taskGraph, executor, handoff, receipt } = await readFixture(
    "handoff.valid.json",
  );
  const verification = await readFixture("verification-and-interactions.valid.json");
  return [
    intent,
    catalog,
    graph,
    integration,
    blueprint,
    record,
    architecturePackage,
    taskGraph,
    executor,
    handoff,
    receipt,
    verification.request,
    verification.result,
    verification.architecture_status,
    verification.architect_interaction,
    verification.handoff_interaction,
  ];
}

test("Product Intent Profile keeps confirmed intent separate from observations", async () => {
  const profile = await readFixture("product-intent-profile.valid.json");

  assert.equal(
    PRODUCT_INTENT_PROFILE_SCHEMA,
    "launchrally.dev/product-intent-profile/v1",
  );
  assert.equal(assertValidProductIntentProfile(profile), true);
  assert.equal(profile.desired_intent.confirmation, "confirmed");
  assert.equal(profile.observed_implementation[0].confidence, "observed");
  assert.equal(profile.coverage.negative_findings_allowed, false);

  assert.throws(
    () => assertValidProductIntentProfile({ ...profile, raw_source: "private source" }),
    (error) => error.code === "invalid_product_intent_profile",
  );
});

test("each Phase 1 contract publishes a stable standalone JSON Schema", async () => {
  assert.equal(PHASE_1_SCHEMA_VERSIONS.length, 16);
  for (const schemaVersion of PHASE_1_SCHEMA_VERSIONS) {
    const contract = schemaVersion.replace("launchrally.dev/", "").replace("/v1", "");
    const schema = JSON.parse(await readFile(
      path.resolve(`packages/contracts/schemas/${contract}/v1.schema.json`),
      "utf8",
    ));
    assert.equal(schema.$id, `https://${schemaVersion}`, contract);
    assert.equal(schema["x-launchrally-contract-major"], 1, contract);
  }
});

test("the Phase 1 registry validates known records and fails closed on versions and enums", async () => {
  const records = await allPositiveRecords();
  const blueprint = records.find(({ schema_version: schemaVersion }) =>
    schemaVersion === ARCHITECTURE_BLUEPRINT_SCHEMA);
  const taskGraph = records.find(({ schema_version: schemaVersion }) =>
    schemaVersion === TASK_GRAPH_SCHEMA);

  for (const phase1Record of records) {
    assert.equal(assertSupportedPhase1Version(phase1Record), 1);
    assert.equal(assertValidPhase1Record(phase1Record), true);
  }

  const historicalReportReference = structuredClone(blueprint);
  historicalReportReference.source_report.schema_version = "launchrally.dev/report/v1";
  assert.equal(assertValidArchitectureBlueprint(historicalReportReference), true);
  assert.throws(
    () => assertSupportedPhase1Version("launchrally.dev/task-graph/v2"),
    (error) => error.code === "unsupported_phase_1_version",
  );
  assert.throws(
    () => assertValidPhase1Record({ ...taskGraph, schema_version: "launchrally.dev/task-graph/v2" }),
    (error) => error.code === "unsupported_phase_1_version",
  );
  assert.throws(
    () => assertValidTaskGraph({
      ...taskGraph,
      tasks: [{ ...taskGraph.tasks[0], status: "future_unknown_state" }],
      ready_frontier: [],
    }),
    (error) => error.code === "invalid_task_graph",
  );
});

test("cross-record IDs, versions, and digests validate against an external record index", async () => {
  const records = await allPositiveRecords();
  const architecturePackage = records.find(({ schema_version: schemaVersion }) =>
    schemaVersion === ARCHITECTURE_PACKAGE_SCHEMA);
  const referenceIndex = new Map([
    ["intent_01hphase1", architecturePackage.records.product_intent],
    ["graph_product_01", architecturePackage.records.capability_graph],
    ["architecture_record_01", architecturePackage.records.architecture_record],
  ]);

  assert.equal(assertValidPhase1References(architecturePackage, referenceIndex), true);
  const tamperedDigest = structuredClone(architecturePackage);
  tamperedDigest.records.product_intent.digest =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000";
  assert.throws(
    () => assertValidPhase1References(tamperedDigest, referenceIndex),
    (error) => error.code === "invalid_phase_1_reference",
  );
  assert.throws(
    () => assertValidPhase1References(architecturePackage, new Map()),
    (error) => error.code === "invalid_phase_1_reference",
  );
});

test("every Phase 1 contract has a focused negative fixture", async () => {
  const records = await allPositiveRecords();
  const cases = await readFixture("negative-cases.json");
  const recordBySchema = new Map(records.map((record) => [record.schema_version, record]));

  assert.deepEqual(
    cases.map(({ schema_version: schemaVersion }) => schemaVersion).sort(),
    [...PHASE_1_SCHEMA_VERSIONS].sort(),
  );
  for (const fixture of cases) {
    const invalid = setPath(
      recordBySchema.get(fixture.schema_version),
      fixture.path,
      fixture.value,
    );
    assert.throws(
      () => assertValidPhase1Record(invalid),
      undefined,
      fixture.schema_version,
    );
  }
});

test("focused negative fixtures reject sensitive persistence and receipt-as-Evidence", async () => {
  const [sensitiveIntent, evidenceReceipt] = await Promise.all([
    readFixture("product-intent-profile.sensitive.negative.json"),
    readFixture("execution-receipt.evidence.negative.json"),
  ]);

  assert.throws(
    () => assertValidProductIntentProfile(sensitiveIntent),
    (error) => error.code === "invalid_product_intent_profile",
  );
  assert.throws(
    () => assertValidExecutionReceipt(evidenceReceipt),
    (error) => error.code === "invalid_execution_receipt",
  );
});

test("Active verification and interaction contracts keep outcomes typed and environment-bound", async () => {
  const fixture = await readFixture("verification-and-interactions.valid.json");

  assert.equal(
    ACTIVE_VERIFICATION_REQUEST_SCHEMA,
    "launchrally.dev/active-verification-request/v1",
  );
  assert.equal(
    ACTIVE_VERIFICATION_RESULT_SCHEMA,
    "launchrally.dev/active-verification-result/v1",
  );
  assert.equal(ARCHITECTURE_STATUS_SCHEMA, "launchrally.dev/architecture-status/v1");
  assert.equal(ARCHITECT_INTERACTION_SCHEMA, "launchrally.dev/architect-interaction/v1");
  assert.equal(HANDOFF_INTERACTION_SCHEMA, "launchrally.dev/handoff-interaction/v1");
  assert.equal(assertValidActiveVerificationRequest(fixture.request), true);
  assert.equal(assertValidActiveVerificationResult(fixture.result), true);
  assert.equal(assertValidArchitectureStatus(fixture.architecture_status), true);
  assert.equal(assertValidArchitectInteraction(fixture.architect_interaction), true);
  assert.equal(assertValidHandoffInteraction(fixture.handoff_interaction), true);
  assert.equal(fixture.architecture_status.launch_assessment.independent, true);

  const partiallyConfirmedArchitecture = {
    ...fixture.architect_interaction,
    status: "partial_completion",
  };
  assert.equal(assertValidArchitectInteraction(partiallyConfirmedArchitecture), true);

  const unsafeProduction = structuredClone(fixture.request);
  unsafeProduction.environment = "production";
  assert.throws(
    () => assertValidActiveVerificationRequest(unsafeProduction),
    (error) => error.code === "invalid_active_verification_request",
  );
  assert.throws(
    () => assertValidActiveVerificationResult({ ...fixture.result, outcome: "success" }),
    (error) => error.code === "invalid_active_verification_result",
  );
  assert.throws(
    () => assertValidArchitectInteraction({
      ...fixture.architect_interaction,
      status: "resumable",
      resume_token: null,
    }),
    (error) => error.code === "invalid_architect_interaction",
  );
  assert.throws(
    () => assertValidHandoffInteraction({
      ...fixture.handoff_interaction,
      status: "cancelled",
    }),
    (error) => error.code === "invalid_handoff_interaction",
  );
});

test("Task and handoff contracts expose bounded effects while receipts remain claims", async () => {
  const { task_graph: taskGraph, executor, handoff, receipt } = await readFixture(
    "handoff.valid.json",
  );

  assert.equal(TASK_GRAPH_SCHEMA, "launchrally.dev/task-graph/v1");
  assert.equal(EXECUTOR_DESCRIPTOR_SCHEMA, "launchrally.dev/executor-descriptor/v1");
  assert.equal(HANDOFF_PACKAGE_SCHEMA, "launchrally.dev/handoff-package/v1");
  assert.equal(EXECUTION_RECEIPT_SCHEMA, "launchrally.dev/execution-receipt/v1");
  assert.equal(assertValidTaskGraph(taskGraph), true);
  assert.equal(assertValidExecutorDescriptor(executor), true);
  assert.equal(assertValidHandoffPackage(handoff), true);
  assert.equal(assertValidExecutionReceipt(receipt), true);
  assert.equal(receipt.classification.machine_evidence, false);

  const cyclic = structuredClone(taskGraph);
  cyclic.tasks[0].prerequisites.push("task_verify_identity");
  assert.throws(
    () => assertValidTaskGraph(cyclic),
    (error) => error.code === "invalid_task_graph",
  );
  assert.throws(
    () => assertValidExecutionReceipt({
      ...receipt,
      classification: { ...receipt.classification, machine_evidence: true },
    }),
    (error) => error.code === "invalid_execution_receipt",
  );

  const progressed = structuredClone(taskGraph);
  progressed.tasks[0].status = "reported_succeeded";
  progressed.tasks[1].status = "not_started";
  progressed.ready_frontier = ["task_verify_identity"];
  assert.equal(assertValidTaskGraph(progressed), true);
});

test("Architecture contracts bind explainable decisions without rewriting source records", async () => {
  const { blueprint, record, package: architecturePackage } = await readFixture(
    "architecture.valid.json",
  );

  assert.equal(ARCHITECTURE_BLUEPRINT_SCHEMA, "launchrally.dev/architecture-blueprint/v1");
  assert.equal(ARCHITECTURE_RECORD_SCHEMA, "launchrally.dev/architecture-record/v1");
  assert.equal(ARCHITECTURE_PACKAGE_SCHEMA, "launchrally.dev/architecture-package/v1");
  assert.equal(assertValidArchitectureBlueprint(blueprint), true);
  assert.equal(assertValidArchitectureRecord(record), true);
  assert.equal(assertValidArchitecturePackage(architecturePackage), true);
  assert.equal(blueprint.whole_product.cost_scenarios[0].currency_estimate, null);
  assert.equal(architecturePackage.storage.local_history_immutable, true);

  const unconfirmed = structuredClone(record);
  unconfirmed.confirmed_decisions[0].confirmation = "agent_inference";
  assert.throws(
    () => assertValidArchitectureRecord(unconfirmed),
    (error) => error.code === "invalid_architecture_record",
  );
  assert.throws(
    () => assertValidArchitecturePackage({
      ...architecturePackage,
      currentness: { state: "current", invalidated_record_ids: [record.record_id], reasons: [] },
    }),
    (error) => error.code === "invalid_architecture_package",
  );
});

test("Capability contracts preserve orthogonal states and Provider-neutral integration semantics", async () => {
  const { catalog, graph, integration } = await readFixture("capability-model.valid.json");

  assert.equal(CAPABILITY_CATALOG_SCHEMA, "launchrally.dev/capability-catalog/v1");
  assert.equal(CAPABILITY_GRAPH_SCHEMA, "launchrally.dev/capability-graph/v1");
  assert.equal(INTEGRATION_CONTRACT_SCHEMA, "launchrally.dev/integration-contract/v1");
  assert.equal(assertValidCapabilityCatalog(catalog), true);
  assert.equal(assertValidCapabilityGraph(graph), true);
  assert.equal(assertValidIntegrationContract(integration), true);
  assert.deepEqual(
    graph.nodes.map((node) => [
      node.requirement_state,
      node.decision_state,
      node.implementation_state,
      node.evidence_state,
    ]),
    [["required", "investigate", "unknown", "unverified"]],
  );
  assert.deepEqual(integration.provider_binding, { kind: "unknown", provider_id: null });

  const silentlyConfirmed = structuredClone(graph);
  silentlyConfirmed.derived_obligations[0].state = "confirmed";
  assert.throws(
    () => assertValidCapabilityGraph(silentlyConfirmed),
    (error) => error.code === "invalid_capability_graph",
  );
  assert.throws(
    () => assertValidIntegrationContract({ ...integration, completion_percentage: 80 }),
    (error) => error.code === "invalid_integration_contract",
  );
});
