import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  REFERENCE_INTEGRATION_PACK_SCHEMA,
  assertValidReferenceIntegrationPack,
  computeReferenceIntegrationPackDigest,
} from "../packages/contracts/src/index.js";
import {
  REFERENCE_INTEGRATION_FAMILIES,
  REFERENCE_PRODUCT_SHAPES,
  applyReferenceJourneyState,
  referenceExecutorDescriptors,
  createReferenceCoverageMatrix,
  normalizeReferenceImplementation,
  referenceIntegrationPacks,
  runReferenceHostJourney,
  runReferenceOutcomeJourney,
} from "../packages/core/src/index.js";
import {
  assertValidExecutorDescriptor,
  computeExecutorDescriptorDigest,
} from "../packages/contracts/src/index.js";

const REQUIRED_OUTCOMES = [
  "cleanup_failed",
  "complete",
  "denied",
  "failed",
  "partial",
  "stale",
  "successful",
  "unknown",
];

test("reference packs cover every product shape and integration family without Provider semantics", () => {
  assert.equal(REFERENCE_INTEGRATION_PACK_SCHEMA, "launchrally.dev/reference-integration-pack/v1");
  assert.equal(referenceIntegrationPacks.length, 8);
  for (const pack of referenceIntegrationPacks) {
    assert.equal(assertValidReferenceIntegrationPack(pack), true);
    assert.equal(pack.pack_digest, computeReferenceIntegrationPackDigest(pack));
    assert.equal(pack.capability_contract.provider_fields, false);
    assert.equal(pack.integration_contract.provider_fields, false);
    assert.deepEqual(pack.effects.allowed, ["provider_configuration_read", "source_write"]);
    assert.ok(pack.effects.prohibited.includes("credential_persistence"));
    assert.deepEqual(pack.fixture_outcomes.map(({ outcome }) => outcome).sort(), REQUIRED_OUTCOMES);
    assert.ok(pack.implementations.filter(({ kind }) => kind === "managed").length >= 2);
    assert.ok(pack.implementations.some(({ kind }) => kind === "custom"));
    assert.ok(pack.implementations.some(({ kind }) => kind === "self_hosted"));
    assert.ok(pack.implementations.some(({ kind }) => kind === "unknown"));
    assert.ok(pack.implementations.some(({ kind }) => kind === "retained"));
    assert.ok(pack.implementations.every(({ interface_version: version }) => version.length > 1));
  }
  const matrix = createReferenceCoverageMatrix();
  assert.deepEqual(matrix.product_shapes, [...REFERENCE_PRODUCT_SHAPES]);
  assert.deepEqual(matrix.integration_families, [...REFERENCE_INTEGRATION_FAMILIES]);
  assert.equal(matrix.cells.length, 5 * 8);
  assert.ok(matrix.cells.every(({ support_state: state }) =>
    ["mixed", "generic", "transparent_gap"].includes(state)));
  assert.ok(matrix.cells.every(({ implementations }) => implementations.length >= 6));
});

test("reference packs fail closed on Provider-specific contract leakage and tampering", () => {
  const pack = structuredClone(referenceIntegrationPacks[0]);
  pack.integration_contract.provider_fields = ["clerk_user_id"];
  assert.throws(
    () => assertValidReferenceIntegrationPack(pack),
    (error) => error.code === "invalid_reference_integration_pack",
  );

  const tampered = structuredClone(referenceIntegrationPacks[0]);
  tampered.implementations[0].interface_version = "clerk-cli/99.0.0";
  assert.throws(
    () => assertValidReferenceIntegrationPack(tampered),
    (error) => error.code === "invalid_reference_integration_pack",
  );

  const overstated = structuredClone(referenceIntegrationPacks.find(({ family }) =>
    family === "storage_to_metadata_access"));
  overstated.implementations[0].read_adapter = "cloudflare-read/v1";
  overstated.implementations[0].support_depth = "read_only";
  overstated.pack_digest = computeReferenceIntegrationPackDigest(overstated);
  assert.throws(
    () => createReferenceCoverageMatrix([overstated]),
    (error) => error.code === "unsupported_reference_integration_pack",
  );

  const unknownRecipe = structuredClone(referenceIntegrationPacks[0]);
  unknownRecipe.test_recipe_ids = ["recipe_provider_specific_claim"];
  unknownRecipe.pack_digest = computeReferenceIntegrationPackDigest(unknownRecipe);
  assert.throws(
    () => createReferenceCoverageMatrix([unknownRecipe]),
    (error) => error.code === "unsupported_reference_integration_pack",
  );

  const untrustedExecutor = structuredClone(referenceIntegrationPacks[0]);
  untrustedExecutor.implementations[0].executor_descriptors[0].digest =
    "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  untrustedExecutor.pack_digest = computeReferenceIntegrationPackDigest(untrustedExecutor);
  assert.throws(
    () => createReferenceCoverageMatrix([untrustedExecutor]),
    (error) => error.code === "unsupported_reference_integration_pack",
  );

  const swappedShape = structuredClone(referenceIntegrationPacks[0]);
  swappedShape.implementations[0].normalization_fixture.synthetic_input.shape =
    swappedShape.implementations[1].normalization_shape;
  swappedShape.pack_digest = computeReferenceIntegrationPackDigest(swappedShape);
  assert.throws(
    () => assertValidReferenceIntegrationPack(swappedShape),
    (error) => error.code === "invalid_reference_integration_pack",
  );

  const missingExecutorBinding = structuredClone(referenceIntegrationPacks[0]);
  missingExecutorBinding.implementations[0].executor_descriptors = [];
  missingExecutorBinding.pack_digest = computeReferenceIntegrationPackDigest(missingExecutorBinding);
  assert.throws(
    () => assertValidReferenceIntegrationPack(missingExecutorBinding),
    (error) => error.code === "invalid_reference_integration_pack",
  );

  const fallbackExecutorBinding = structuredClone(referenceIntegrationPacks[0]);
  fallbackExecutorBinding.implementations.find(({ kind }) => kind === "retained")
    .executor_descriptors = structuredClone(
      fallbackExecutorBinding.implementations.find(({ kind }) => kind === "managed")
        .executor_descriptors,
    );
  fallbackExecutorBinding.pack_digest = computeReferenceIntegrationPackDigest(
    fallbackExecutorBinding,
  );
  assert.throws(
    () => assertValidReferenceIntegrationPack(fallbackExecutorBinding),
    (error) => error.code === "invalid_reference_integration_pack",
  );
});

test("reference Executors use exact reviewed tools, effects, and tamper-bound descriptors", () => {
  assert.equal(referenceExecutorDescriptors.length, 2);
  for (const descriptor of referenceExecutorDescriptors) {
    assert.equal(assertValidExecutorDescriptor(descriptor), true);
    assert.equal(descriptor.tools.length, 1);
    assert.equal(descriptor.tools[0].exact_version, descriptor.descriptor_id.includes("codex")
      ? "0.147.0"
      : "2.1.231");
    assert.equal(descriptor.trust.digest, computeExecutorDescriptorDigest(descriptor));
    assert.deepEqual(descriptor.allowed_effects, ["source_write"]);
    assert.ok(descriptor.prohibited_effects.includes("provider_configuration_write"));
  }
  const tampered = structuredClone(referenceExecutorDescriptors[0]);
  tampered.allowed_effects = ["deployment_write"];
  assert.throws(
    () => assertValidExecutorDescriptor(tampered),
    (error) => error.code === "invalid_executor_descriptor",
  );
});

test("reference journeys preserve complete, partial, denied, unknown, stale, success, and failure", async () => {
  const cases = JSON.parse(await readFile(
    new URL("./fixtures/reference-packs/journey-cases.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(cases.map(({ outcome }) => outcome).sort(), REQUIRED_OUTCOMES);
  const matrix = createReferenceCoverageMatrix();
  for (const journey of cases) {
    const cell = matrix.cells.find(({ product_shape: shape, integration_family: family }) =>
      shape === journey.product_shape && family === journey.integration_family);
    const implementation = referenceIntegrationPacks.find(({ family }) =>
      family === journey.integration_family).implementations.find(({ kind }) =>
      kind === journey.implementation_kind);
    const support = cell.implementations.find(({ implementation_id: id }) =>
      id === implementation.implementation_id).support_state;
    assert.equal(support, journey.expected_support_state, journey.case_id);
    const pack = referenceIntegrationPacks.find(({ family }) =>
      family === journey.integration_family);
    const result = runReferenceOutcomeJourney(pack, implementation.implementation_id, journey.outcome);
    assert.equal(result.outcome, journey.outcome);
    assert.equal(result.machine_evidence, false);
    assert.equal(result.assurance_change, false);
    if (["complete", "partial"].includes(journey.outcome)) {
      assert.equal(result.status, "verification_pending", journey.case_id);
    } else if (["denied", "unknown", "stale"].includes(journey.outcome)) {
      assert.equal(result.status, "verification_gap", journey.case_id);
    }
  }
});

test("every family and managed implementation exercises partial and unavailable Executor paths", async () => {
  for (const pack of referenceIntegrationPacks) {
    for (const implementation of pack.implementations.filter(({ kind }) => kind === "managed")) {
      for (const host of ["codex", "claude"]) {
        for (const outcome of ["partial", "denied", "unknown", "stale"]) {
          const result = await runReferenceHostJourney({
            host,
            pack_id: pack.pack_id,
            implementation_id: implementation.implementation_id,
            outcome,
            assessment_time: "2026-08-14T12:00:00.000Z",
          });
          assert.equal(result.outcome, outcome);
          assert.equal(result.machine_evidence, false);
          assert.equal(result.assurance_change, false);
          assert.notEqual(result.status, "verification_completed");
        }
      }
    }
  }
});

test("every managed implementation exercises the shared deterministic outcome boundary", () => {
  for (const pack of referenceIntegrationPacks) {
    for (const implementation of pack.implementations.filter(({ kind }) => kind === "managed")) {
      const normalized = normalizeReferenceImplementation(pack, implementation.implementation_id);
      assert.match(implementation.interface_version, /^[A-Za-z0-9]/u);
      assert.deepEqual(normalized, {
        implementation_id: implementation.implementation_id,
        status: "normalized",
        reason_code: null,
        observation: {
          configuration_state: "configured",
          verification_state: "unverified",
        },
      });
      assert.ok(!JSON.stringify(normalized).includes(implementation.name));
    }
  }
});

test("reference pack fixtures reject Provider secrets, personal content, and raw messages", () => {
  const sensitiveValues = [
    ["clerk", { credential_value: "opaque_test_fixture" }],
    ["paddle", { endpoint_secret_key: "pdl_ntfset_opaque_secret" }],
    ["resend", { recipients: ["person@example.com"], subject: "private subject" }],
    ["aws_sqs", { queue_message_body: "private production payload" }],
  ];
  for (const [implementationId, syntheticInput] of sensitiveValues) {
    const pack = structuredClone(referenceIntegrationPacks.find(({ implementations }) =>
      implementations.some(({ implementation_id: id }) => id === implementationId)));
    const implementation = pack.implementations.find(({ implementation_id: id }) =>
      id === implementationId);
    implementation.normalization_fixture.synthetic_input = syntheticInput;
    pack.pack_digest = computeReferenceIntegrationPackDigest(pack);
    assert.throws(
      () => assertValidReferenceIntegrationPack(pack),
      (error) => error.code === "invalid_reference_integration_pack",
      implementationId,
    );
  }
});

test("reference outcomes preserve Executor mismatches and assurance boundaries", () => {
  const pack = referenceIntegrationPacks.find(({ family }) => family === "backup_to_restore");
  const implementation = pack.implementations.find(({ kind }) => kind === "managed");
  const complete = runReferenceOutcomeJourney(pack, implementation.implementation_id, "complete");
  const partial = runReferenceOutcomeJourney(pack, implementation.implementation_id, "partial");
  const denied = runReferenceOutcomeJourney(pack, implementation.implementation_id, "denied");
  const stale = runReferenceOutcomeJourney(pack, implementation.implementation_id, "stale");
  assert.deepEqual(
    [complete.fresh_verification, partial.claim_state, denied.executor_state, stale.executor_state],
    ["required", "partial", "denied", "expired"],
  );
  assert.ok([complete, partial, denied, stale].every(({ machine_evidence: evidence }) => !evidence));
  assert.ok([complete, partial, denied, stale].every(({ assurance_change: change }) => !change));
  const cancelled = applyReferenceJourneyState(complete, "cancel");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.machine_evidence, false);
  assert.equal(cancelled.assurance_change, false);
});

test("Codex and Claude reference journeys keep receipts as claims before fresh verification", async () => {
  const pack = referenceIntegrationPacks.find(({ family }) =>
    family === "identity_to_application_data");
  const implementation = pack.implementations.find(({ kind }) => kind === "managed");
  for (const host of ["codex", "claude"]) {
    for (const outcome of REQUIRED_OUTCOMES) {
      const result = await runReferenceHostJourney({
        host,
        pack_id: pack.pack_id,
        implementation_id: implementation.implementation_id,
        outcome,
        assessment_time: "2026-08-14T12:00:00.000Z",
      });
      assert.equal(result.host, host);
      assert.equal(result.outcome, outcome);
      assert.equal(result.machine_evidence, false);
      assert.equal(result.assurance_change, false);
      if (["complete", "partial", "successful", "failed", "cleanup_failed"].includes(outcome)) {
        assert.equal(result.handoff_status, "partial_completion");
        assert.equal(result.receipt_claim_only, true);
        assert.equal(result.verify_handoff_status, "completed");
        assert.equal(result.fresh_verification_request.operation, "verify");
        assert.equal(result.fresh_verification_request.fresh_evidence_required, true);
        assert.match(
          result.fresh_verification_request.task_requests[0].evidence_targets[0],
          new RegExp(`${pack.pack_digest.slice(7)}.*${implementation.implementation_id}`, "u"),
        );
      } else {
        assert.equal(result.status, "verification_gap");
      }
    }
  }
});

test("reference host journeys require current Pack and implementation-bound Executor authority", async () => {
  const pack = referenceIntegrationPacks[0];
  const managed = pack.implementations.find(({ kind }) => kind === "managed");
  const unknown = pack.implementations.find(({ kind }) => kind === "unknown");
  const stale = await runReferenceHostJourney({
    host: "codex",
    pack_id: pack.pack_id,
    implementation_id: managed.implementation_id,
    outcome: "complete",
    assessment_time: "2026-11-13T00:00:00.000Z",
  });
  const unbound = await runReferenceHostJourney({
    host: "codex",
    pack_id: pack.pack_id,
    implementation_id: unknown.implementation_id,
    outcome: "complete",
    assessment_time: "2026-08-14T12:00:00.000Z",
  });
  assert.equal(stale.reason_code, "stale_reference_pack");
  assert.equal(unbound.reason_code, "unsupported_reference_executor");
  assert.equal(stale.machine_evidence, false);
  assert.equal(unbound.machine_evidence, false);
});
