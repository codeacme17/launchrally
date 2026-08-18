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
  AUTHENTICATED_JOURNEY_ATTESTATION_SCHEMA,
  AUTHENTICATED_JOURNEY_EVIDENCE_SCHEMA,
  CAPABILITY_CATALOG_SCHEMA,
  CAPABILITY_GRAPH_SCHEMA,
  COMPOSITE_ASSURANCE_SCHEMA,
  DESKTOP_SHARED_BACKEND_SCHEMA,
  INTEGRATION_CONTRACT_SCHEMA,
  EXECUTION_RECEIPT_SCHEMA,
  EXECUTOR_DESCRIPTOR_SCHEMA,
  HANDOFF_PACKAGE_SCHEMA,
  HANDOFF_INTERACTION_SCHEMA,
  HOST_RESUME_ARTIFACT_SCHEMA,
  PHASE_1_SCHEMA_VERSIONS,
  PHASE_1_ADOPTION_SCHEMA,
  PHASE_1_MIGRATION_PREVIEW_SCHEMA,
  PRODUCT_INTENT_PROFILE_SCHEMA,
  REFERENCE_INTEGRATION_PACK_SCHEMA,
  TASK_GRAPH_SCHEMA,
  assertValidArchitectureBlueprint,
  assertValidArchitecturePackage,
  assertValidArchitectureRecord,
  assertValidArchitectInteraction,
  assertValidArchitectureStatus,
  assertValidActiveVerificationRequest,
  assertValidActiveVerificationResult,
  assertValidAuthenticatedJourneyAttestation,
  assertValidAuthenticatedJourneyEvidence,
  assertValidCapabilityCatalog,
  assertValidCapabilityGraph,
  assertValidCompositeAssurance,
  assertValidDesktopSharedBackend,
  assertValidIntegrationContract,
  assertValidExecutionReceipt,
  assertValidExecutorDescriptor,
  assertValidHandoffPackage,
  assertValidHandoffInteraction,
  assertValidHostResumeArtifact,
  assertSupportedPhase1Version,
  assertValidPhase1References,
  assertValidPhase1Record,
  assertValidPhase1Adoption,
  assertValidPhase1MigrationPreview,
  assertValidProductIntentProfile,
  assertValidReferenceIntegrationPack,
  assertValidTaskGraph,
  computeExecutorDescriptorDigest,
} from "../packages/contracts/src/index.js";
import {
  CORE_PROVIDER_KNOWLEDGE,
  referenceIntegrationPacks,
} from "../packages/core/src/index.js";
import { sha256 } from "../packages/core/src/local-history.js";

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
  const compositeAssurance = await readFixture("composite-assurance.valid.json");
  const legacyRequest = structuredClone(verification.request);
  legacyRequest.schema_version = "launchrally.dev/active-verification-request/v1";
  delete legacyRequest.environment_class;
  delete legacyRequest.integration_contract;
  delete legacyRequest.expected_conditions;
  const legacyResult = structuredClone(verification.result);
  legacyResult.schema_version = "launchrally.dev/active-verification-result/v1";
  legacyResult.request.schema_version = "launchrally.dev/active-verification-request/v1";
  delete legacyResult.handoff;
  delete legacyResult.executor;
  delete legacyResult.integration_contract;
  delete legacyResult.observation_provenance;
  delete legacyResult.capability_id;
  delete legacyResult.recipe_id;
  delete legacyResult.observation.replay;
  delete legacyResult.evidence;
  delete legacyResult.verification_gap;
  const authenticatedJourneyEvidence = {
    schema_version: AUTHENTICATED_JOURNEY_EVIDENCE_SCHEMA,
    kind: "authenticated_journey_machine_evidence",
    journey_id: "target-1:journey-1:authenticated",
    target: "https://example.com/control",
    method: "GET",
    purpose: "authenticated Core Journey",
    authentication_class: "staff",
    status: "failed",
    outcome: "unexpected_denial",
    status_code: 403,
    collected_at: "2026-08-12T06:00:00.000Z",
    provenance: {
      collector: "host-agent-authenticated-journey/v1",
      exact_target: "https://example.com/control",
      collected_at: "2026-08-12T06:00:00.000Z",
      permission_id: "authenticated_journey_verification",
      collection_not_before: "2026-08-12T05:59:00.000Z",
      collection_not_after: "2026-08-12T06:14:00.000Z",
      attestation_id: "attestation_host_observation_01",
      request_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      result_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      verification: "host_adapter_verified",
    },
  };
  const authenticatedJourneyAttestation = {
    schema_version: AUTHENTICATED_JOURNEY_ATTESTATION_SCHEMA,
    adapter_version: "host-agent-authenticated-journey/v1",
    attestation_id: "attestation_host_observation_01",
    request_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    result_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    issued_at: "2026-08-12T06:00:00.000Z",
  };
  const hostResumeContent = {
    schema_version: HOST_RESUME_ARTIFACT_SCHEMA,
    origin_host: "codex",
    operation: "architect",
    state: verification.architect_interaction.state,
    resume_token: verification.architect_interaction.resume_token,
    source_refs: verification.architect_interaction.source_refs,
    portable_state: {
      algorithm: "aes-256-gcm",
      nonce: "a".repeat(16),
      ciphertext: "a",
      tag: "a".repeat(22),
    },
  };
  const hostResumeDigest = sha256(hostResumeContent);
  const hostResumeArtifact = {
    ...hostResumeContent,
    artifact_id: `host_resume_${hostResumeDigest.slice(7, 27)}`,
    artifact_digest: hostResumeDigest,
    attestation: "a".repeat(43),
  };
  const phase1Adoption = {
    schema_version: PHASE_1_ADOPTION_SCHEMA,
    adopted: true,
    launcher_version: "0.3.2",
    migration: "additive",
    preserved_contracts: [
      "launchrally.dev/manifest/v2",
      "launchrally.dev/report/v2",
      "launchrally.dev/evidence-index/v1",
    ],
    historical_reports_relabelled: false,
  };
  const phase1MigrationPreview = {
    schema_version: PHASE_1_MIGRATION_PREVIEW_SCHEMA,
    migration: "additive",
    files: [
      ".launchrally/phase-1/adoption.json",
      ".launchrally/phase-1/records/",
      ".launchrally/phase-1/transactions/",
    ],
    preserved_paths: [
      ".launchrally/manifest.yaml",
      ".launchrally/reports/",
      ".launchrally/evidence/",
    ],
  };
  const desktopSharedBackend = {
    schema_version: DESKTOP_SHARED_BACKEND_SCHEMA,
    topology: "desktop_with_shared_backend",
    capability_ids: ["runtime_execution"],
    excluded_release_readiness: [
      "signing",
      "notarization",
      "store_review",
      "distribution",
      "updater",
    ],
  };
  return [
    authenticatedJourneyAttestation,
    authenticatedJourneyEvidence,
    intent,
    CORE_PROVIDER_KNOWLEDGE,
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
    legacyRequest,
    legacyResult,
    verification.request,
    verification.result,
    compositeAssurance,
    verification.architecture_status,
    verification.architect_interaction,
    phase1Adoption,
    phase1MigrationPreview,
    hostResumeArtifact,
    desktopSharedBackend,
    referenceIntegrationPacks[0],
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

test("authenticated Journey success and failure are normative Phase 1 Machine Evidence", async () => {
  const [, failure] = await allPositiveRecords();
  const success = {
    ...structuredClone(failure),
    status: "passed",
    outcome: "completed",
    status_code: 200,
  };

  assert.equal(AUTHENTICATED_JOURNEY_EVIDENCE_SCHEMA,
    "launchrally.dev/authenticated-journey-evidence/v1");
  assert.equal(assertValidAuthenticatedJourneyEvidence(failure), true);
  assert.equal(assertValidAuthenticatedJourneyEvidence(success), true);
  const signedTokenJourney = {
    ...structuredClone(success),
    target: "https://example.com/guardian/authorize",
    authentication_class: "signed_token",
    provenance: {
      ...success.provenance,
      exact_target: "https://example.com/guardian/authorize",
    },
  };
  assert.equal(assertValidAuthenticatedJourneyEvidence(signedTokenJourney), true);
  const applicationSpecificJourney = {
    ...structuredClone(success),
    target: "https://example.com/me/notifications/settings",
    provenance: {
      ...success.provenance,
      exact_target: "https://example.com/me/notifications/settings",
    },
  };
  assert.equal(assertValidAuthenticatedJourneyEvidence(applicationSpecificJourney), true);
  assert.throws(
    () => assertValidAuthenticatedJourneyEvidence({
      ...failure,
      agent_statement: "The journey failed.",
    }),
    (error) => error.code === "invalid_authenticated_journey_evidence",
  );
  for (const invalid of [
    { ...success, status_code: null },
    { ...success, status: "failed" },
    { ...failure, outcome: "redirect", status_code: 200 },
    { ...failure, status_code: null },
    {
      ...failure,
      target: "https://user:password@example.com/control",
      provenance: {
        ...failure.provenance,
        exact_target: "https://user:password@example.com/control",
      },
    },
    {
      ...failure,
      target: "https://example.com/control?token=private",
      provenance: {
        ...failure.provenance,
        exact_target: "https://example.com/control?token=private",
      },
    },
    {
      ...failure,
      target: "https://example.com/users/alice@example.com",
      provenance: {
        ...failure.provenance,
        exact_target: "https://example.com/users/alice@example.com",
      },
    },
    { ...failure, purpose: "Alice alice@example.com account loads" },
    {
      ...failure,
      target: "http://example.com/control",
      provenance: {
        ...failure.provenance,
        exact_target: "http://example.com/control",
      },
    },
    {
      ...failure,
      target: "https://example.com/orders/12345678",
      provenance: {
        ...failure.provenance,
        exact_target: "https://example.com/orders/12345678",
      },
    },
    {
      ...failure,
      target: "https://example.com/patients/john-smith",
      purpose: "John Smith patient profile loads",
      provenance: {
        ...failure.provenance,
        exact_target: "https://example.com/patients/john-smith",
      },
    },
    {
      ...failure,
      target: "https://example.com/account%2D12345",
      provenance: {
        ...failure.provenance,
        exact_target: "https://example.com/account%2D12345",
      },
    },
    {
      ...failure,
      target: "https://example.com/control/../moderation",
      provenance: {
        ...failure.provenance,
        exact_target: "https://example.com/control/../moderation",
      },
    },
    {
      ...failure,
      target: "https://EXAMPLE.com/control",
      provenance: {
        ...failure.provenance,
        exact_target: "https://EXAMPLE.com/control",
      },
    },
    {
      ...failure,
      target: "https://example.com:443/control",
      provenance: {
        ...failure.provenance,
        exact_target: "https://example.com:443/control",
      },
    },
  ]) {
    assert.throws(
      () => assertValidAuthenticatedJourneyEvidence(invalid),
      (error) => error.code === "invalid_authenticated_journey_evidence",
    );
  }
});

test("authenticated Journey attestation is a strict host integration contract", async () => {
  const [attestation] = await allPositiveRecords();

  assert.equal(assertValidAuthenticatedJourneyAttestation(attestation), true);
  assert.throws(
    () => assertValidAuthenticatedJourneyAttestation({
      ...attestation,
      result_digest: attestation.request_digest,
    }),
    (error) => error.code === "invalid_authenticated_journey_attestation",
  );
});

test("each Phase 1 contract publishes a stable standalone JSON Schema", async () => {
  assert.equal(PHASE_1_SCHEMA_VERSIONS.length, 27);
  for (const schemaVersion of PHASE_1_SCHEMA_VERSIONS) {
    const [contract, major] = schemaVersion.replace("launchrally.dev/", "").split("/v");
    const schema = JSON.parse(await readFile(
      path.resolve(`packages/contracts/schemas/${contract}/v${major}.schema.json`),
      "utf8",
    ));
    assert.equal(schema.$id, `https://${schemaVersion}`, contract);
    assert.equal(schema["x-launchrally-contract-major"], Number(major), contract);
  }
});

test("Reference Integration Packs are registered public Phase 1 records", () => {
  assert.equal(REFERENCE_INTEGRATION_PACK_SCHEMA,
    "launchrally.dev/reference-integration-pack/v1");
  assert.equal(assertValidReferenceIntegrationPack(referenceIntegrationPacks[0]), true);
  assert.equal(assertValidPhase1Record(referenceIntegrationPacks[0]), true);
});

test("desktop shared-backend topology excludes desktop distribution readiness", async () => {
  const topology = (await allPositiveRecords()).find(({ schema_version: schemaVersion }) =>
    schemaVersion === DESKTOP_SHARED_BACKEND_SCHEMA);
  assert.equal(assertValidDesktopSharedBackend(topology), true);
  assert.equal(assertValidDesktopSharedBackend({
    ...topology,
    excluded_release_readiness: [...topology.excluded_release_readiness].reverse(),
  }), true);
  assert.throws(
    () => assertValidDesktopSharedBackend({
      ...topology,
      excluded_release_readiness: topology.excluded_release_readiness.slice(1),
    }),
    (error) => error.code === "invalid_desktop_shared_backend",
  );
});

test("Host Resume Artifacts bind the exact resumable interaction state", async () => {
  const artifact = (await allPositiveRecords()).find(({ schema_version: schemaVersion }) =>
    schemaVersion === HOST_RESUME_ARTIFACT_SCHEMA);
  const withDigest = (changes) => {
    const content = {
      ...Object.fromEntries(Object.entries(artifact).filter(([key]) =>
        !["artifact_id", "artifact_digest", "attestation"].includes(key))),
      ...changes,
    };
    const digest = sha256(content);
    return {
      ...content,
      artifact_id: `host_resume_${digest.slice(7, 27)}`,
      artifact_digest: digest,
      attestation: artifact.attestation,
    };
  };

  assert.equal(assertValidHostResumeArtifact(artifact), true);
  assert.throws(
    () => assertValidHostResumeArtifact(withDigest({ state: "authority_preview" })),
    (error) => error.code === "invalid_host_resume_artifact",
  );
  assert.throws(
    () => assertValidHostResumeArtifact(withDigest({
      portable_state: {
        ...artifact.portable_state,
        ciphertext: "a".repeat(220001),
      },
    })),
    (error) => error.code === "invalid_host_resume_artifact",
  );
});

test("Phase 1 adoption remains additive and cannot relabel historical records", async () => {
  const adoption = (await allPositiveRecords()).find(({ schema_version: schemaVersion }) =>
    schemaVersion === PHASE_1_ADOPTION_SCHEMA);

  assert.equal(assertValidPhase1Adoption(adoption), true);
  assert.throws(
    () => assertValidPhase1Adoption({ ...adoption, historical_reports_relabelled: true }),
    (error) => error.code === "invalid_phase_1_adoption",
  );
});

test("Phase 1 migration preview binds every additive and preserved path", async () => {
  const preview = (await allPositiveRecords()).find(({ schema_version: schemaVersion }) =>
    schemaVersion === PHASE_1_MIGRATION_PREVIEW_SCHEMA);

  assert.equal(assertValidPhase1MigrationPreview(preview), true);
  assert.throws(
    () => assertValidPhase1MigrationPreview({ ...preview, files: [".launchrally/phase-1/"] }),
    (error) => error.code === "invalid_phase_1_migration_preview",
  );
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
    "launchrally.dev/active-verification-request/v2",
  );
  assert.equal(
    ACTIVE_VERIFICATION_RESULT_SCHEMA,
    "launchrally.dev/active-verification-result/v2",
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

  const legacyRequest = JSON.parse(JSON.stringify(fixture.request));
  legacyRequest.schema_version = "launchrally.dev/active-verification-request/v1";
  delete legacyRequest.environment_class;
  delete legacyRequest.integration_contract;
  delete legacyRequest.expected_conditions;
  assert.equal(assertValidActiveVerificationRequest(legacyRequest), true);

  const legacyResult = JSON.parse(JSON.stringify(fixture.result));
  legacyResult.schema_version = "launchrally.dev/active-verification-result/v1";
  legacyResult.request.schema_version = "launchrally.dev/active-verification-request/v1";
  delete legacyResult.handoff;
  delete legacyResult.executor;
  delete legacyResult.integration_contract;
  delete legacyResult.observation_provenance;
  delete legacyResult.capability_id;
  delete legacyResult.recipe_id;
  delete legacyResult.observation.replay;
  delete legacyResult.evidence;
  delete legacyResult.verification_gap;
  assert.equal(assertValidActiveVerificationResult(legacyResult), true);

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

test("Composite Assurance is independently versioned and environment-bound", async () => {
  const assurance = await readFixture("composite-assurance.valid.json");
  assert.equal(COMPOSITE_ASSURANCE_SCHEMA, "launchrally.dev/composite-assurance/v1");
  assert.equal(assertValidCompositeAssurance(assurance), true);
  assert.equal(assurance.architecture_status.independent, true);
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
  const missingDependency = structuredClone(taskGraph);
  missingDependency.tasks[1].prerequisites = ["task_missing_dependency"];
  assert.throws(
    () => assertValidTaskGraph(missingDependency),
    (error) => error.code === "invalid_task_graph",
  );
  const incompatibleEnvironment = structuredClone(taskGraph);
  incompatibleEnvironment.tasks[0].environment = "staging";
  assert.throws(
    () => assertValidTaskGraph(incompatibleEnvironment),
    (error) => error.code === "invalid_task_graph",
  );
  const secretValue = structuredClone(taskGraph);
  secretValue.tasks[0].recovery_notes = ["Use https://test-user:test-password@example.invalid/"];
  assert.throws(
    () => assertValidTaskGraph(secretValue),
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

  const verified = structuredClone(taskGraph);
  verified.tasks[0].status = "verified";
  verified.tasks[0].verification_evidence = [{
    digest: `sha256:${"7".repeat(64)}`,
    target: "identity_configuration",
    collected_at: "2026-08-13T00:00:00.000Z",
    current: true,
  }];
  verified.tasks[1].status = "not_started";
  verified.ready_frontier = ["task_verify_identity"];
  assert.equal(assertValidTaskGraph(verified), true);

  const hiddenProviderWrite = structuredClone(taskGraph);
  hiddenProviderWrite.tasks[1].prohibited_effects = ["production_data_write"];
  hiddenProviderWrite.tasks[1].allowed_effects.push("provider_configuration_write");
  assert.throws(
    () => assertValidTaskGraph(hiddenProviderWrite),
    (error) => error.code === "invalid_task_graph",
  );

  const unsafeEffectFrontier = structuredClone(taskGraph);
  unsafeEffectFrontier.tasks[0].status = "reported_succeeded";
  unsafeEffectFrontier.tasks[1] = {
    ...unsafeEffectFrontier.tasks[1],
    task_type: "configure_dependent_capability",
    source: "implementation_work",
    effect_class: "local_source",
    allowed_effects: ["source_write"],
    prohibited_effects: ["provider_configuration_write", "production_data_write"],
    status: "not_started",
  };
  unsafeEffectFrontier.ready_frontier = ["task_verify_identity"];
  assert.throws(
    () => assertValidTaskGraph(unsafeEffectFrontier),
    (error) => error.code === "invalid_task_graph",
  );
});

test("Executor and Handoff validators reject ambiguous tools and under-bounded approval", async () => {
  const { executor, handoff } = await readFixture("handoff.valid.json");
  const duplicateTool = structuredClone(executor);
  duplicateTool.tools.push(structuredClone(duplicateTool.tools[0]));
  duplicateTool.trust.digest = computeExecutorDescriptorDigest(duplicateTool);
  assert.throws(
    () => assertValidExecutorDescriptor(duplicateTool),
    (error) => error.code === "invalid_executor_descriptor",
  );

  const implicitRequired = structuredClone(handoff);
  implicitRequired.approval = {
    state: "required",
    confirmation: "implicit",
    confirmed_at: null,
  };
  assert.throws(
    () => assertValidHandoffPackage(implicitRequired),
    (error) => error.code === "invalid_handoff_package",
  );

  const underBounded = structuredClone(handoff);
  underBounded.authority_batch.prohibited_effects = ["credential_persistence"];
  assert.throws(
    () => assertValidHandoffPackage(underBounded),
    (error) => error.code === "invalid_handoff_package",
  );
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
