import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertValidActiveVerificationRequest,
  assertValidActiveVerificationResult,
  assertValidIntegrationContract,
  computeExecutorDescriptorDigest,
} from "../packages/contracts/src/index.js";
import {
  ACTIVE_VERIFICATION_RECIPES,
  approveActiveVerification,
  activeVerificationOutcomeCheck,
  activeVerificationVerificationEvidence,
  planActiveVerification,
  reviewActiveVerificationObservation,
} from "../packages/core/src/index.js";

const fixture = JSON.parse(await readFile(
  new URL("./fixtures/phase-1-contracts/handoff.valid.json", import.meta.url),
  "utf8",
));

function source(environment = "staging", recipeId = "recipe_test_webhook") {
  const targets = {
    recipe_test_webhook: "communication_delivery",
    recipe_test_user: "identity_authentication",
    recipe_test_checkout: "billing_entitlement",
    recipe_test_email: "communication_delivery",
    recipe_test_object_upload: "object_storage",
    recipe_test_ci_dispatch: "ci_cd",
  };
  const taskGraph = structuredClone(fixture.task_graph);
  const recipeEffects = {
    recipe_test_webhook: ["synthetic_webhook_send", "synthetic_webhook_delete"],
    recipe_test_user: ["synthetic_user_create", "synthetic_user_delete"],
    recipe_test_checkout: ["synthetic_checkout_create", "synthetic_checkout_void"],
    recipe_test_email: ["synthetic_email_send", "synthetic_recipient_expire"],
    recipe_test_object_upload: ["synthetic_object_upload", "synthetic_object_delete"],
    recipe_test_ci_dispatch: ["synthetic_ci_dispatch"],
  };
  const expectedEffects = {
    recipe_test_webhook: "webhook_business_outcome",
    recipe_test_user: "identity_session_created",
    recipe_test_checkout: "entitlement_observed",
    recipe_test_email: "email_delivery_observed",
    recipe_test_object_upload: "object_round_trip_observed",
    recipe_test_ci_dispatch: "ci_dispatch_completed",
  };
  taskGraph.environment = environment;
  taskGraph.tasks = [{
    ...taskGraph.tasks[0],
    task_id: "task_active_webhook",
    task_type: "actively_verify_webhook",
    environment,
    effect_class: "active_test",
    expected_target: targets[recipeId] ?? "communication_delivery",
    allowed_effects: recipeEffects[recipeId],
    prohibited_effects: [
      "credential_persistence",
      "deployment_write",
      "production_data_write",
      "provider_configuration_write",
      "source_write",
    ],
    minimum_executor_capability: "active_webhook_v1",
    structured_result_schema: "launchrally.dev/active-verification-result/v2",
    evidence_targets: ["webhook_business_outcome"],
    prerequisites: [],
    status: "not_started",
  }];
  taskGraph.ready_frontier = ["task_active_webhook"];
  const executor = structuredClone(fixture.executor);
  executor.descriptor_id = "executor_active_webhook";
  executor.supported_task_types = ["actively_verify_webhook"];
  executor.environments = [...new Set(["staging", "production", environment])];
  executor.allowed_effects = [...taskGraph.tasks[0].allowed_effects];
  executor.prohibited_effects = [...taskGraph.tasks[0].prohibited_effects];
  executor.result_schema = "launchrally.dev/active-verification-result/v2";
  executor.active_verification_modes = ["synthetic_webhook_delivery"];
  executor.contract_versions = [
    "launchrally.dev/handoff-package/v1",
    "launchrally.dev/execution-receipt/v1",
    "launchrally.dev/active-verification-result/v2",
  ];
  executor.trust.digest = computeExecutorDescriptorDigest(executor);
  const synchronous = ["recipe_test_user", "recipe_test_object_upload"].includes(recipeId);
  const integrationContract = {
    schema_version: "launchrally.dev/integration-contract/v1",
    contract_id: `integration_${recipeId}_${environment.replaceAll(/[^a-z0-9]/giu, "_")}`,
    contract_version: "1.0.0",
    environment,
    source_capability_id: targets[recipeId],
    target_capability_id: "downstream_business_outcome",
    mode: synchronous ? "synchronous" : "asynchronous",
    provider_binding: { kind: "unknown", provider_id: null },
    semantics: {
      authentication: "executor_managed_reference",
      ordering: synchronous ? "not_applicable" : "per_correlation_id",
      duplication: synchronous ? "not_applicable" : "possible",
      retry: synchronous ? "not_applicable" : "bounded_backoff",
      replay: synchronous ? "not_applicable" : "detected",
      idempotency: synchronous ? "not_applicable" : "required",
      eventual_consistency: synchronous ? "not_applicable" : "expected",
      failure_visibility: "operator_visible",
      privacy: "synthetic_fixture_only",
      success_evidence: [expectedEffects[recipeId]],
      invalidation_dependencies: ["integration_semantics"],
    },
  };
  return {
    recipe_id: recipeId,
    environment,
    environment_class: ["production", "prod"].includes(environment)
      ? "production"
      : "non_production",
    executor_mode: "synthetic_webhook_delivery",
    fixture_id: "fixture_minimized_webhook",
    correlation_id: "corr_webhook_01",
    task_graph: taskGraph,
    task_id: "task_active_webhook",
    executor_descriptor: executor,
    integration_contract: integrationContract,
    reviewed_executor: {
      descriptor_id: executor.descriptor_id,
      descriptor_version: executor.descriptor_version,
      digest: executor.trust.digest,
    },
    assessment_time: "2026-08-13T00:00:00.000Z",
  };
}

function descriptorForRecipe(recipeId, mode) {
  const value = source("staging", recipeId);
  value.executor_mode = mode;
  value.executor_descriptor.active_verification_modes = [mode];
  value.executor_descriptor.trust.digest = computeExecutorDescriptorDigest(
    value.executor_descriptor,
  );
  value.reviewed_executor.digest = value.executor_descriptor.trust.digest;
  return value;
}

function observation(overrides = {}) {
  return {
    transport_status: "accepted",
    business_outcome: "observed_success",
    timing: "within_window",
    retry_state: "not_exhausted",
    retry_count: 0,
    duplicate_count: 0,
    ordering: "as_expected",
    replay: "not_observed",
    eventual_consistency: "observed",
    dead_letter_visible: false,
    latency_ms: 420,
    cleanup_status: "succeeded",
    ...overrides,
  };
}

function executorObservationOptions(collectedAt = "2026-08-13T00:01:10.000Z") {
  return {
    collected_at: collectedAt,
    executor_attestation_id: "attestation_executor_observation_01",
    verify_executor_attestation: (provenance) =>
      provenance.attestation_id === "attestation_executor_observation_01",
  };
}

function successEvidenceForTest(approved) {
  return {
    recipe_id: approved.request.recipe.recipe_id,
    capability_id: approved.request.capability_id,
    environment: approved.request.environment,
    correlation_id: approved.request.correlation_id,
    expected_effect_class: "webhook_business_outcome",
    observed: true,
    latency_ms: 420,
    cleanup_status: "succeeded",
    collected_at: "2026-08-13T00:01:10.000Z",
  };
}

test("a reviewed recipe produces a separately approvable active-verification handoff", () => {
  const planned = planActiveVerification(source(), {
    created_at: "2026-08-13T00:00:00.000Z",
  });

  assert.equal(planned.status, "needs_confirmation");
  assert.equal(assertValidActiveVerificationRequest(planned.request), true);
  assert.equal(planned.request.approval.state, "required");
  assert.equal(
    planned.request.integration_contract.id,
    "integration_recipe_test_webhook_staging",
  );
  assert.equal(planned.handoff_package.approval.state, "required");
  assert.equal(planned.handoff_package.authority_batch.effect_classes[0], "active_test");
  assert.equal(planned.handoff_package.active_verification_request.id, planned.request.request_id);
  assert.deepEqual(planned.preview.effects, [
    "synthetic_webhook_send",
    "synthetic_webhook_delete",
  ]);
  assert.deepEqual(planned.request.expected_conditions, {
    transport_status: "accepted",
    business_outcome: "observed_success",
    timing: "within_window",
    retry_state: "not_exhausted",
    maximum_duplicate_count: 0,
    ordering: "as_expected",
    replay: "not_observed",
    eventual_consistency: "observed",
    failure_visible: false,
  });
  assert.equal(planned.preview.ordinary_read_verification_approval_reused, false);

  const approved = approveActiveVerification(planned, {
    confirmation: "confirm",
    confirmed_at: "2026-08-13T00:01:00.000Z",
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.request.approval.confirmation, "explicit_user_confirmation");
  assert.equal(approved.handoff_package.approval.state, "approved");
});

test("the reviewed Catalog covers webhook, user, checkout, email, object, and CI recipes", () => {
  const cases = [
    ["recipe_test_webhook", "synthetic_webhook_delivery"],
    ["recipe_test_user", "synthetic_identity_login"],
    ["recipe_test_checkout", "synthetic_checkout"],
    ["recipe_test_email", "synthetic_email_delivery"],
    ["recipe_test_object_upload", "synthetic_object_upload"],
    ["recipe_test_ci_dispatch", "synthetic_ci_dispatch"],
  ];
  for (const [recipeId, mode] of cases) {
    assert.equal(ACTIVE_VERIFICATION_RECIPES[recipeId].recipe_version, "1.0.0");
    assert.equal(ACTIVE_VERIFICATION_RECIPES[recipeId].trust_tier, "core_catalog");
    assert.equal(ACTIVE_VERIFICATION_RECIPES[recipeId].reviewed_at, "2026-08-13");
    const planned = planActiveVerification(descriptorForRecipe(recipeId, mode), {
      created_at: "2026-08-13T00:00:00.000Z",
    });
    assert.equal(planned.status, "needs_confirmation", recipeId);
    assert.equal(planned.request.recipe.recipe_id, recipeId);
    assert.equal(planned.request.executor_mode, mode);
    assert.equal(
      planned.request.expected_conditions.eventual_consistency,
      ["recipe_test_user", "recipe_test_object_upload"].includes(recipeId)
        ? "not_applicable"
        : "observed",
    );
  }
});

test("reviewed recipes and Executors must authorize every exact active effect", () => {
  const wrongRecipeEffects = source();
  wrongRecipeEffects.task_graph.tasks[0].allowed_effects = ["synthetic_ci_dispatch"];
  assert.equal(
    planActiveVerification(wrongRecipeEffects, {
      created_at: "2026-08-13T00:00:00.000Z",
    }).verification_gap.reason_code,
    "unsupported_active_verification_recipe",
  );

  const missingExecutorEffect = source();
  missingExecutorEffect.executor_descriptor.allowed_effects = ["synthetic_webhook_send"];
  missingExecutorEffect.executor_descriptor.trust.digest = computeExecutorDescriptorDigest(
    missingExecutorEffect.executor_descriptor,
  );
  missingExecutorEffect.reviewed_executor.digest =
    missingExecutorEffect.executor_descriptor.trust.digest;
  assert.equal(
    planActiveVerification(missingExecutorEffect, {
      created_at: "2026-08-13T00:00:00.000Z",
    }).verification_gap.reason_code,
    "unsupported_executor_mode",
  );

  const unrelatedIntegration = source();
  unrelatedIntegration.integration_contract.semantics.success_evidence = [
    "email_delivery_observed",
  ];
  assert.equal(
    planActiveVerification(unrelatedIntegration, {
      created_at: "2026-08-13T00:00:00.000Z",
    }).verification_gap.reason_code,
    "unsupported_active_verification_recipe",
  );
});

test("an accepted transport response cannot prove an asynchronous business outcome", () => {
  const planned = planActiveVerification(source(), {
    created_at: "2026-08-13T00:00:00.000Z",
  });
  const approved = approveActiveVerification(planned, {
    confirmation: "confirm",
    confirmed_at: "2026-08-13T00:01:00.000Z",
  });
  const reviewed = reviewActiveVerificationObservation(approved, observation({
    business_outcome: "not_observed",
  }), executorObservationOptions());

  assert.equal(assertValidActiveVerificationResult(reviewed.result), true);
  assert.equal(reviewed.result.outcome, "inconclusive");
  assert.equal(reviewed.result.observed, false);
  assert.equal(reviewed.result.evidence, null);
  assert.equal(reviewed.result.verification_gap.reason_code, "business_outcome_not_observed");
  const check = activeVerificationOutcomeCheck(reviewed.result, {
    check_id: "communication.downstream-outcome",
    check_version: 1,
    approved_plan: approved,
    assessed_at: "2026-08-13T00:01:10.000Z",
    verify_executor_attestation: () => true,
  });
  assert.equal(check.status, "unverified");
  assert.equal(check.reason_code, "business_outcome_not_observed");
  assert.deepEqual(check.evidence, []);

  const promotedGap = structuredClone(reviewed.result);
  promotedGap.outcome = "observed_success";
  promotedGap.observed = true;
  promotedGap.evidence = structuredClone(successEvidenceForTest(approved));
  promotedGap.verification_gap = null;
  promotedGap.classification.evidence_qualification = "qualifying_machine_evidence";
  assert.throws(
    () => activeVerificationOutcomeCheck(promotedGap, {
      check_id: "communication.downstream-outcome",
      check_version: 1,
      approved_plan: approved,
      assessed_at: "2026-08-13T00:01:10.000Z",
      verify_executor_attestation: () => true,
    }),
    (error) => error.code === "invalid_active_verification_check_input",
  );

  assert.throws(
    () => reviewActiveVerificationObservation(approved, observation(), {
      collected_at: "2026-08-13T00:01:10.000Z",
      executor_attestation_id: "attestation_unverified",
    }),
    (error) => error.code === "unverified_executor_observation",
  );
});

test("outcome observations remain distinct and qualifying Evidence is privacy-safe", () => {
  const planned = planActiveVerification(source(), {
    created_at: "2026-08-13T00:00:00.000Z",
  });
  const approved = approveActiveVerification(planned, {
    confirmation: "confirm",
    confirmed_at: "2026-08-13T00:01:00.000Z",
  });
  const cases = [
    [observation({ timing: "timeout", business_outcome: "not_observed" }), "timeout"],
    [observation({ timing: "late" }), "late_success"],
    [observation({ duplicate_count: 1 }), "duplicate_delivery"],
    [observation({ retry_state: "exhausted", business_outcome: "observed_failure" }), "retry_exhausted"],
    [observation({ retry_count: 1 }), "retry_succeeded"],
    [observation({ cleanup_status: "failed" }), "cleanup_failure"],
  ];
  for (const [input, expected] of cases) {
    const reviewed = reviewActiveVerificationObservation(approved, input, {
      ...executorObservationOptions(),
    });
    assert.equal(reviewed.result.outcome, expected);
    assert.equal(reviewed.result.evidence === null, expected !== "retry_succeeded");
  }

  const success = reviewActiveVerificationObservation(
    approved,
    observation(),
    executorObservationOptions(),
  );
  assert.equal(success.result.outcome, "observed_success");
  assert.equal(success.result.handoff.id, approved.handoff_package.handoff_id);
  assert.equal(success.result.executor.id, approved.handoff_package.executor.id);
  assert.equal(success.result.recipe_id, "recipe_test_webhook");
  assert.equal(success.result.observation.replay, "not_observed");
  assert.equal(success.result.classification.evidence_qualification, "qualifying_machine_evidence");
  assert.deepEqual(Object.keys(success.result.evidence).sort(), [
    "capability_id",
    "cleanup_status",
    "collected_at",
    "correlation_id",
    "environment",
    "expected_effect_class",
    "latency_ms",
    "observed",
    "recipe_id",
  ]);
  assert.equal(JSON.stringify(success.result.evidence).includes("payload"), false);
  assert.equal(JSON.stringify(success.result.evidence).includes("message"), false);

  const check = activeVerificationOutcomeCheck(success.result, {
    check_id: "communication.downstream-outcome",
    check_version: 1,
    approved_plan: approved,
    assessed_at: "2026-08-13T00:01:10.000Z",
    verify_executor_attestation: (provenance) =>
      provenance.attestation_id === "attestation_executor_observation_01",
  });
  assert.equal(check.check_layer, "downstream_outcome");
  assert.equal(check.status, "passed");
  assert.equal(check.environment, "staging");
  assert.equal(check.evidence[0].current, true);
  assert.equal(check.evidence[0].target, "webhook_business_outcome");

  const changedCapability = structuredClone(success.result);
  changedCapability.capability_id = "billing_entitlement";
  assert.throws(
    () => activeVerificationOutcomeCheck(changedCapability, {
      check_id: "communication.downstream-outcome",
      check_version: 1,
      approved_plan: approved,
      assessed_at: "2026-08-13T00:01:10.000Z",
      verify_executor_attestation: () => true,
    }),
    (error) => [
      "invalid_active_verification_result",
      "invalid_active_verification_check_input",
    ].includes(error.code),
  );

  const changedRecipe = structuredClone(success.result);
  changedRecipe.recipe_id = "recipe_test_checkout";
  changedRecipe.evidence.recipe_id = "recipe_test_checkout";
  assert.throws(
    () => activeVerificationOutcomeCheck(changedRecipe, {
      check_id: "communication.downstream-outcome",
      check_version: 1,
      approved_plan: approved,
      assessed_at: "2026-08-13T00:01:10.000Z",
      verify_executor_attestation: () => true,
    }),
    (error) => error.code === "invalid_active_verification_check_input",
  );

  for (const [field, value] of [
    ["environment", "production"],
    ["correlation_id", "corr_relabelled"],
    ["expected_effect_class", "email_delivery_observed"],
  ]) {
    const relabelled = structuredClone(success.result);
    relabelled[field] = value;
    if (field in relabelled.evidence) relabelled.evidence[field] = value;
    assert.throws(
      () => activeVerificationOutcomeCheck(relabelled, {
        check_id: "communication.downstream-outcome",
        check_version: 1,
        approved_plan: approved,
        assessed_at: "2026-08-13T00:01:10.000Z",
        verify_executor_attestation: () => true,
      }),
    );
  }

  assert.deepEqual(
    activeVerificationVerificationEvidence(success.result, {
      approved_plan: approved,
      assessed_at: "2026-08-13T00:01:10.000Z",
      verify_executor_attestation: () => true,
    }),
    [{
      digest: check.evidence[0].digest,
      target: "webhook_business_outcome",
      collected_at: "2026-08-13T00:01:10.000Z",
      current: true,
    }],
  );

  for (const incompatible of [
    { transport_status: "rejected" },
    { ordering: "out_of_order" },
    { replay: "observed" },
    { eventual_consistency: "not_observed" },
    { dead_letter_visible: true },
  ]) {
    const nonQualifying = reviewActiveVerificationObservation(
      approved,
      observation(incompatible),
      executorObservationOptions(),
    );
    assert.equal(nonQualifying.result.outcome, "inconclusive");
    assert.equal(nonQualifying.result.evidence, null);
  }
});

test("production active verification is default-denied without a production-safe recipe and separate approval", () => {
  for (const environment of ["production", "prod", "prod-us", "production-eu", "live"]) {
    const productionSource = source(environment);
    assert.doesNotThrow(
      () => assertValidIntegrationContract(productionSource.integration_contract),
      environment,
    );
    const blocked = planActiveVerification(productionSource, {
      created_at: "2026-08-13T00:00:00.000Z",
    });
    assert.equal(blocked.status, "verification_gap", environment);
    assert.equal(
      blocked.verification_gap.reason_code,
      "production_recipe_not_safe",
      environment,
    );
    assert.equal(blocked.handoff_package, undefined);
  }

  const safe = planActiveVerification(
    source("production", "recipe_test_ci_dispatch"),
    { created_at: "2026-08-13T00:00:00.000Z" },
  );
  assert.equal(safe.status, "needs_confirmation");
  assert.throws(
    () => approveActiveVerification(safe, {
      confirmation: "confirm",
      confirmed_at: "2026-08-13T00:01:00.000Z",
    }),
    (error) => error.code === "production_active_verification_approval_required",
  );
  const approved = approveActiveVerification(safe, {
    confirmation: "confirm",
    separate_production_approval: true,
    confirmed_at: "2026-08-13T00:01:00.000Z",
  });
  assert.equal(approved.request.approval.separate_production_approval, true);
});

test("unsupported or denied active verification leaves a transparent Verification Gap", () => {
  const unsupported = planActiveVerification({
    ...source(),
    executor_mode: "unsupported_mode",
  }, { created_at: "2026-08-13T00:00:00.000Z" });
  assert.equal(unsupported.status, "verification_gap");
  assert.equal(unsupported.verification_gap.reason_code, "unsupported_executor_mode");

  const planned = planActiveVerification(source(), {
    created_at: "2026-08-13T00:00:00.000Z",
  });
  const denied = approveActiveVerification(planned, { confirmation: "deny" });
  assert.equal(denied.status, "verification_gap");
  assert.equal(denied.verification_gap.reason_code, "active_verification_denied");
  assert.equal(denied.request.approval.state, "denied");

  const unreviewed = source();
  unreviewed.reviewed_executor.digest = `sha256:${"f".repeat(64)}`;
  const untrusted = planActiveVerification(unreviewed, {
    created_at: "2026-08-13T00:00:00.000Z",
  });
  assert.equal(untrusted.status, "verification_gap");
  assert.equal(untrusted.verification_gap.reason_code, "unsupported_executor_mode");

  const unsafeObservation = { ...observation(), payload: { email: "person@example.com" } };
  const approved = approveActiveVerification(planActiveVerification(source(), {
    created_at: "2026-08-13T00:00:00.000Z",
  }), {
    confirmation: "confirm",
    confirmed_at: "2026-08-13T00:01:00.000Z",
  });
  assert.throws(
    () => reviewActiveVerificationObservation(approved, unsafeObservation, {
      ...executorObservationOptions(),
    }),
    (error) => error.code === "invalid_active_verification_observation",
  );

  const expired = source();
  expired.assessment_time = "2027-08-14T00:00:00.000Z";
  const stale = planActiveVerification(expired, {
    created_at: "2027-08-14T00:00:00.000Z",
  });
  assert.equal(stale.status, "verification_gap");
  assert.equal(stale.verification_gap.reason_code, "unsupported_active_verification_recipe");

  const expiring = planActiveVerification(source(), {
    created_at: "2026-08-13T00:00:00.000Z",
  });
  assert.throws(
    () => approveActiveVerification(expiring, {
      confirmation: "confirm",
      confirmed_at: "2026-11-12T00:00:00.000Z",
    }),
    (error) => error.code === "invalid_active_verification_plan",
  );

  const approvedBeforeExpiry = approveActiveVerification(expiring, {
    confirmation: "confirm",
    confirmed_at: "2026-08-13T00:01:00.000Z",
  });
  assert.throws(
    () => reviewActiveVerificationObservation(approvedBeforeExpiry, observation(), {
      ...executorObservationOptions("2026-11-12T00:00:00.000Z"),
    }),
    (error) => error.code === "invalid_active_verification_plan",
  );

  const missingAssessment = source();
  delete missingAssessment.assessment_time;
  assert.equal(
    planActiveVerification(missingAssessment, {
      created_at: "2026-08-13T00:00:00.000Z",
    }).verification_gap.reason_code,
    "unsupported_active_verification_recipe",
  );

  const forged = planActiveVerification(source(), {
    created_at: "2026-08-13T00:00:00.000Z",
  });
  forged.request.expected_conditions.maximum_duplicate_count = 10;
  forged.request.request_id = `active_verify_${"a".repeat(20)}`;
  forged.handoff_package.active_verification_request = {
    id: forged.request.request_id,
    schema_version: forged.request.schema_version,
    digest: `sha256:${"b".repeat(64)}`,
  };
  assert.throws(
    () => approveActiveVerification(forged, {
      confirmation: "confirm",
      confirmed_at: "2026-08-13T00:01:00.000Z",
    }),
    (error) => error.code === "invalid_active_verification_plan",
  );

  assert.throws(
    () => approveActiveVerification(planned, {
      confirmation: "confirm",
      confirmed_at: "not-a-time",
    }),
    (error) => error.code === "invalid_active_verification_time",
  );

  const missingContext = structuredClone(planned);
  delete missingContext.approval_context;
  assert.throws(
    () => approveActiveVerification(missingContext, { confirmation: "deny" }),
    (error) => error.code === "invalid_active_verification_plan",
  );

  assert.throws(
    () => reviewActiveVerificationObservation(approved, observation(), {
      collected_at: "not-a-time",
      executor_attestation_id: "attestation_executor_observation_01",
      verify_executor_attestation: () => true,
    }),
    (error) => error.code === "invalid_active_verification_time",
  );
});
