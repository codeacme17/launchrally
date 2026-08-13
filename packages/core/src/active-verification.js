import {
  ACTIVE_VERIFICATION_REQUEST_SCHEMA,
  ACTIVE_VERIFICATION_RESULT_SCHEMA,
  EXECUTOR_DESCRIPTOR_SCHEMA,
  HANDOFF_PACKAGE_SCHEMA,
  INTEGRATION_CONTRACT_SCHEMA,
  TASK_GRAPH_SCHEMA,
  assertValidActiveVerificationRequest,
  assertValidActiveVerificationResult,
  assertValidExecutorDescriptor,
  assertValidHandoffPackage,
  assertValidIntegrationContract,
  assertValidTaskGraph,
} from "@launchrally/contracts";

import { sha256 } from "./local-history.js";
import { createHandoffAuthorityBatch } from "./handoff-authority.js";
import { createRecordReference, recordReferencesEqual } from "./record-reference.js";

const RECIPE_REVIEWED_AT = "2026-08-13";
const RECIPE_EXPIRES_AT = "2027-08-13";

function reviewedRecipe(recipe) {
  return Object.freeze({
    ...recipe,
    trust_tier: "core_catalog",
    reviewed_at: RECIPE_REVIEWED_AT,
    expires_at: RECIPE_EXPIRES_AT,
    provenance: Object.freeze({
      source: "launchrally-active-verification-catalog/v1",
      authority: "launchrally_core_review",
    }),
  });
}

const PRODUCTION_ENVIRONMENT_TOKEN = /(?:^|[-_.])(?:prod(?:uction)?|live|prd)(?:$|[-_.])/iu;

const ACTIVE_VERIFICATION_RECIPES = Object.freeze({
  recipe_test_webhook: reviewedRecipe({
    recipe_version: "1.0.0",
    capability_id: "communication_delivery",
    executor_modes: Object.freeze(["synthetic_webhook_delivery"]),
    integration_mode: "asynchronous",
    allowed_effects: Object.freeze(["synthetic_webhook_send", "synthetic_webhook_delete"]),
    expected_effect_class: "webhook_business_outcome",
    cleanup_strategy: "delete_synthetic_webhook_fixture",
    production_safety: "production_unsafe",
  }),
  recipe_test_user: reviewedRecipe({
    recipe_version: "1.0.0",
    capability_id: "identity_authentication",
    executor_modes: Object.freeze(["synthetic_identity_login"]),
    integration_mode: "synchronous",
    allowed_effects: Object.freeze(["synthetic_user_create", "synthetic_user_delete"]),
    expected_effect_class: "identity_session_created",
    cleanup_strategy: "delete_synthetic_user",
    production_safety: "production_unsafe",
  }),
  recipe_test_checkout: reviewedRecipe({
    recipe_version: "1.0.0",
    capability_id: "billing_entitlement",
    executor_modes: Object.freeze(["synthetic_checkout"]),
    integration_mode: "asynchronous",
    allowed_effects: Object.freeze(["synthetic_checkout_create", "synthetic_checkout_void"]),
    expected_effect_class: "entitlement_observed",
    cleanup_strategy: "void_synthetic_checkout",
    production_safety: "production_unsafe",
  }),
  recipe_test_email: reviewedRecipe({
    recipe_version: "1.0.0",
    capability_id: "communication_delivery",
    executor_modes: Object.freeze(["synthetic_email_delivery"]),
    integration_mode: "asynchronous",
    allowed_effects: Object.freeze(["synthetic_email_send", "synthetic_recipient_expire"]),
    expected_effect_class: "email_delivery_observed",
    cleanup_strategy: "expire_synthetic_recipient",
    production_safety: "production_unsafe",
  }),
  recipe_test_object_upload: reviewedRecipe({
    recipe_version: "1.0.0",
    capability_id: "object_storage",
    executor_modes: Object.freeze(["synthetic_object_upload"]),
    integration_mode: "synchronous",
    allowed_effects: Object.freeze(["synthetic_object_upload", "synthetic_object_delete"]),
    expected_effect_class: "object_round_trip_observed",
    cleanup_strategy: "delete_synthetic_object",
    production_safety: "production_unsafe",
  }),
  recipe_test_ci_dispatch: reviewedRecipe({
    recipe_version: "1.0.0",
    capability_id: "ci_cd",
    executor_modes: Object.freeze(["synthetic_webhook_delivery", "synthetic_ci_dispatch"]),
    integration_mode: "asynchronous",
    allowed_effects: Object.freeze(["synthetic_ci_dispatch"]),
    expected_effect_class: "ci_dispatch_completed",
    cleanup_strategy: "no_cleanup_required",
    production_safety: "production_safe",
  }),
});

function failure(code, message = code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function gap(reasonCode) {
  return {
    status: "verification_gap",
    verification_gap: { reason_code: reasonCode },
    assurance_change: false,
  };
}

function taskAndRecipe(source) {
  try {
    assertValidTaskGraph(source?.task_graph);
    assertValidExecutorDescriptor(source?.executor_descriptor);
    assertValidIntegrationContract(source?.integration_contract);
  } catch (error) {
    failure("invalid_active_verification_source", error.code);
  }
  const recipe = ACTIVE_VERIFICATION_RECIPES[source.recipe_id];
  const task = source.task_graph.tasks.find(({ task_id: taskId }) => taskId === source.task_id);
  if (
    !recipe
    || !task
    || task.effect_class !== "active_test"
    || task.environment !== source.environment
    || source.task_graph.environment !== source.environment
    || task.expected_target !== recipe.capability_id
    || source.integration_contract.environment !== source.environment
    || source.integration_contract.mode !== recipe.integration_mode
    || ![
      source.integration_contract.source_capability_id,
      source.integration_contract.target_capability_id,
    ].includes(recipe.capability_id)
    || !source.integration_contract.semantics.success_evidence.includes(
      recipe.expected_effect_class,
    )
    || JSON.stringify(task.allowed_effects) !== JSON.stringify(recipe.allowed_effects)
    || source.environment_class !== "production"
      && source.environment_class !== "non_production"
    || !source.task_graph.ready_frontier.includes(task.task_id)
  ) return { unsupported: "unsupported_active_verification_recipe" };
  if (!Number.isFinite(Date.parse(source.assessment_time))) {
    return { unsupported: "unsupported_active_verification_recipe" };
  }
  const assessmentDate = source.assessment_time.slice(0, 10);
  if (assessmentDate < recipe.reviewed_at || assessmentDate > recipe.expires_at) {
    return { unsupported: "unsupported_active_verification_recipe" };
  }
  const executor = source.executor_descriptor;
  const review = source.reviewed_executor;
  const assessmentTime = source.assessment_time;
  const reviewCurrent = review?.descriptor_id === executor.descriptor_id
    && review?.descriptor_version === executor.descriptor_version
    && review?.digest === executor.trust.digest
    && Date.parse(executor.trust.reviewed_at) <= Date.parse(assessmentTime)
    && Date.parse(assessmentTime) <= Date.parse(executor.trust.expires_at);
  if (
    !recipe.executor_modes.includes(source.executor_mode)
    || !executor.active_verification_modes.includes(source.executor_mode)
    || !executor.supported_task_types.includes(task.task_type)
    || !executor.environments.includes(source.environment)
    || executor.result_schema !== ACTIVE_VERIFICATION_RESULT_SCHEMA
    || task.allowed_effects.some((effect) => !executor.allowed_effects.includes(effect))
    || task.prohibited_effects.some((effect) => !executor.prohibited_effects.includes(effect))
    || !reviewCurrent
  ) return { unsupported: "unsupported_executor_mode" };
  return {
    task,
    recipe,
    executor,
    environmentClass: source.environment_class === "production"
      || PRODUCTION_ENVIRONMENT_TOKEN.test(source.environment)
      ? "production"
      : "non_production",
  };
}

function expectedConditionsFor(contract) {
  const semantics = contract.semantics;
  return {
    transport_status: "accepted",
    business_outcome: "observed_success",
    timing: "within_window",
    retry_state: semantics.retry === "not_applicable" ? "not_exhausted" : "not_exhausted",
    maximum_duplicate_count: semantics.duplication === "not_applicable" ? 0 : 0,
    ordering: semantics.ordering === "not_applicable" ? "not_applicable" : "as_expected",
    replay: semantics.replay === "not_applicable" ? "not_applicable" : "not_observed",
    eventual_consistency: semantics.eventual_consistency === "not_applicable"
      ? "not_applicable"
      : "observed",
    failure_visible: false,
  };
}

function approvalContext(source) {
  return structuredClone({
    recipe_id: source.recipe_id,
    environment: source.environment,
    environment_class: source.environment_class,
    executor_mode: source.executor_mode,
    fixture_id: source.fixture_id,
    correlation_id: source.correlation_id,
    task_graph: source.task_graph,
    task_id: source.task_id,
    executor_descriptor: source.executor_descriptor,
    integration_contract: source.integration_contract,
    reviewed_executor: source.reviewed_executor,
    assessment_time: source.assessment_time,
  });
}

function normalizedPlanForComparison(planned) {
  const request = structuredClone(planned.request);
  request.approval = {
    state: "required",
    confirmation: null,
    separate_production_approval: false,
  };
  const handoffPackage = structuredClone(planned.handoff_package);
  handoffPackage.active_verification_request = createRecordReference(
    request.request_id,
    ACTIVE_VERIFICATION_REQUEST_SCHEMA,
    request,
  );
  handoffPackage.approval = { state: "required", confirmation: null, confirmed_at: null };
  return { request, handoff_package: handoffPackage };
}

function validateBoundPlan(planned, expectedStatus, assessmentTime) {
  try {
    assertValidActiveVerificationRequest(planned?.request);
    assertValidHandoffPackage(planned?.handoff_package);
  } catch {
    failure("invalid_active_verification_plan");
  }
  const request = planned.request;
  const handoffPackage = planned.handoff_package;
  let expected;
  let normalized;
  try {
    const currentContext = structuredClone(planned.approval_context);
    currentContext.assessment_time = assessmentTime ?? currentContext.assessment_time;
    expected = planActiveVerification(currentContext, {
      created_at: handoffPackage.created_at,
      observation_window_ms: request.observation_window_ms,
      timeout_ms: request.timeout_ms,
    });
    normalized = normalizedPlanForComparison(planned);
  } catch {
    failure("invalid_active_verification_plan");
  }
  const expectedRequest = createRecordReference(
    request.request_id,
    ACTIVE_VERIFICATION_REQUEST_SCHEMA,
    request,
  );
  if (
    planned.status !== expectedStatus
    || expected.status !== "needs_confirmation"
    || sha256(normalized.request) !== sha256(expected.request)
    || sha256(normalized.handoff_package) !== sha256(expected.handoff_package)
    || request.environment !== handoffPackage.environment
    || !recordReferencesEqual(handoffPackage.active_verification_request, expectedRequest)
    || handoffPackage.authority_batch.effect_classes.length !== 1
    || handoffPackage.authority_batch.effect_classes[0] !== "active_test"
    || JSON.stringify([...request.effects.allowed].sort())
      !== JSON.stringify(handoffPackage.authority_batch.allowed_effects)
    || JSON.stringify([...request.effects.prohibited].sort())
      !== JSON.stringify(handoffPackage.authority_batch.prohibited_effects)
  ) failure("invalid_active_verification_plan");
}

export function planActiveVerification(source, options = {}) {
  const classified = taskAndRecipe(source);
  if (classified.unsupported) return gap(classified.unsupported);
  const { task, recipe, executor, environmentClass } = classified;
  if (
    environmentClass === "production"
    && recipe.production_safety !== "production_safe"
  ) {
    return gap("production_recipe_not_safe");
  }
  if (!Number.isFinite(Date.parse(options.created_at))) {
    failure("invalid_active_verification_time");
  }
  const requestContent = {
    revision: 1,
    environment: source.environment,
    environment_class: environmentClass,
    capability_id: recipe.capability_id,
    recipe: {
      recipe_id: source.recipe_id,
      recipe_version: recipe.recipe_version,
      trust_tier: "core_catalog",
    },
    integration_contract: createRecordReference(
      source.integration_contract.contract_id,
      INTEGRATION_CONTRACT_SCHEMA,
      source.integration_contract,
    ),
    executor_mode: source.executor_mode,
    approval: {
      state: "required",
      confirmation: null,
      separate_production_approval: false,
    },
    synthetic_fixture: {
      fixture_id: source.fixture_id,
      minimized: true,
      real_user_data: false,
      business_payload: false,
    },
    correlation_id: source.correlation_id,
    effects: {
      allowed: [...task.allowed_effects],
      prohibited: [...task.prohibited_effects],
    },
    expected_conditions: expectedConditionsFor(source.integration_contract),
    observation_window_ms: options.observation_window_ms ?? 30000,
    timeout_ms: options.timeout_ms ?? 45000,
    cleanup_strategy: recipe.cleanup_strategy,
    production_safety: {
      classification: environmentClass === "production"
        ? recipe.production_safety
        : "non_production",
      default_denied: true,
    },
  };
  const request = {
    schema_version: ACTIVE_VERIFICATION_REQUEST_SCHEMA,
    request_id: `active_verify_${sha256(requestContent).slice(7, 27)}`,
    ...requestContent,
  };
  assertValidActiveVerificationRequest(request);
  const packageContent = {
    revision: 1,
    created_at: options.created_at,
    environment: source.environment,
    task_graph: createRecordReference(
      source.task_graph.graph_id,
      TASK_GRAPH_SCHEMA,
      source.task_graph,
    ),
    task_ids: [task.task_id],
    executor: createRecordReference(
      executor.descriptor_id,
      EXECUTOR_DESCRIPTOR_SCHEMA,
      executor,
    ),
    active_verification_request: createRecordReference(
      request.request_id,
      ACTIVE_VERIFICATION_REQUEST_SCHEMA,
      request,
    ),
    authority_batch: createHandoffAuthorityBatch([task], executor),
    approval: { state: "required", confirmation: null, confirmed_at: null },
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
  return {
    status: "needs_confirmation",
    approval_context: approvalContext(source),
    request,
    handoff_package: handoffPackage,
    preview: {
      effects: [...task.allowed_effects],
      environment: source.environment,
      executor_mode: source.executor_mode,
      observation_window_ms: request.observation_window_ms,
      timeout_ms: request.timeout_ms,
      cleanup_strategy: request.cleanup_strategy,
      ordinary_read_verification_approval_reused: false,
      separate_production_approval_required: environmentClass === "production",
    },
  };
}

export function approveActiveVerification(planned, options = {}) {
  if (
    options.confirmation === "confirm"
    && !Number.isFinite(Date.parse(options.confirmed_at))
  ) failure("invalid_active_verification_time");
  validateBoundPlan(
    planned,
    "needs_confirmation",
    options.confirmation === "confirm" ? options.confirmed_at : undefined,
  );
  const request = structuredClone(planned.request);
  const handoffPackage = structuredClone(planned.handoff_package);
  if (options.confirmation !== "confirm") {
    request.approval.state = "denied";
    handoffPackage.approval.state = "denied";
    assertValidActiveVerificationRequest(request);
    assertValidHandoffPackage(handoffPackage);
    return {
      status: "verification_gap",
      approval_context: structuredClone(planned.approval_context),
      request,
      handoff_package: handoffPackage,
      verification_gap: { reason_code: "active_verification_denied" },
      assurance_change: false,
    };
  }
  if (
    request.environment_class === "production"
    && options.separate_production_approval !== true
  ) failure("production_active_verification_approval_required");
  request.approval = {
    state: "approved",
    confirmation: "explicit_user_confirmation",
    separate_production_approval: options.separate_production_approval === true,
  };
  handoffPackage.active_verification_request = createRecordReference(
    request.request_id,
    ACTIVE_VERIFICATION_REQUEST_SCHEMA,
    request,
  );
  handoffPackage.approval = {
    state: "approved",
    confirmation: "explicit_user_confirmation",
    confirmed_at: options.confirmed_at,
  };
  assertValidActiveVerificationRequest(request);
  assertValidHandoffPackage(handoffPackage);
  return {
    status: "approved",
    approval_context: structuredClone(planned.approval_context),
    request,
    handoff_package: handoffPackage,
  };
}

function classifyObservation(observation) {
  if (observation.cleanup_status === "failed") return "cleanup_failure";
  if (observation.duplicate_count > 0) return "duplicate_delivery";
  if (observation.retry_state === "exhausted") return "retry_exhausted";
  if (observation.timing === "late" && observation.business_outcome === "observed_success") {
    return "late_success";
  }
  if (observation.timing === "timeout") return "timeout";
  if (observation.business_outcome === "observed_failure") return "observed_failure";
  return "inconclusive";
}

function observationMeetsExpectedConditions(observation, expected) {
  return observation.transport_status === expected.transport_status
    && observation.business_outcome === expected.business_outcome
    && observation.timing === expected.timing
    && observation.retry_state === expected.retry_state
    && observation.duplicate_count <= expected.maximum_duplicate_count
    && observation.ordering === expected.ordering
    && observation.replay === expected.replay
    && observation.eventual_consistency === expected.eventual_consistency
    && observation.dead_letter_visible === expected.failure_visible;
}

function normalizedObservationSemantics(result) {
  return {
    outcome: result.outcome,
    observed: result.observed,
    latency_ms: result.latency_ms,
    cleanup_status: result.cleanup_status,
    observation: result.observation,
    evidence: result.evidence,
    verification_gap: result.verification_gap,
  };
}

const GAP_BY_OUTCOME = Object.freeze({
  timeout: "active_verification_timeout",
  late_success: "late_success",
  duplicate_delivery: "duplicate_delivery",
  retry_exhausted: "retry_exhausted",
  cleanup_failure: "cleanup_failure",
  observed_failure: "observed_failure",
  inconclusive: "business_outcome_not_observed",
});

export function reviewActiveVerificationObservation(approved, observation, options = {}) {
  if (!Number.isFinite(Date.parse(options.collected_at))) {
    failure("invalid_active_verification_time");
  }
  validateBoundPlan(approved, "approved", options.collected_at);
  if (
    approved.request.approval.state !== "approved"
    || approved.handoff_package.approval.state !== "approved"
    || approved.request.approval.confirmation !== "explicit_user_confirmation"
    || approved.handoff_package.approval.confirmation !== "explicit_user_confirmation"
  ) failure("active_verification_not_approved");
  const observationDigest = sha256(observation);
  const observationProvenance = {
    attestation_id: options.executor_attestation_id,
    observation_digest: observationDigest,
    executor: structuredClone(approved.handoff_package.executor),
    collected_at: options.collected_at,
    verification: "external_executor_verified",
    normalized_result_digest: null,
  };
  const allowedKeys = [
    "transport_status",
    "business_outcome",
    "timing",
    "retry_state",
    "retry_count",
    "duplicate_count",
    "ordering",
    "replay",
    "eventual_consistency",
    "dead_letter_visible",
    "latency_ms",
    "cleanup_status",
  ];
  if (
    !observation
    || Object.keys(observation).some((key) => !allowedKeys.includes(key))
    || !["accepted", "rejected", "not_observed"].includes(observation.transport_status)
    || !["observed_success", "observed_failure", "not_observed"].includes(
      observation.business_outcome,
    )
    || !["within_window", "timeout", "late"].includes(observation.timing)
    || !["not_exhausted", "exhausted"].includes(observation.retry_state)
    || !Number.isInteger(observation.retry_count)
    || !Number.isInteger(observation.duplicate_count)
    || !["as_expected", "out_of_order", "not_observed"].includes(observation.ordering)
    || !["observed", "not_observed", "not_applicable"].includes(observation.replay)
    || !["observed", "not_observed", "not_applicable"].includes(
      observation.eventual_consistency,
    )
    || typeof observation.dead_letter_visible !== "boolean"
    || !Number.isInteger(observation.latency_ms)
    || !["succeeded", "failed", "not_required", "unknown"].includes(
      observation.cleanup_status,
    )
  ) failure("invalid_active_verification_observation");
  const classifiedOutcome = classifyObservation(observation);
  const outcome = classifiedOutcome === "inconclusive"
    && observationMeetsExpectedConditions(observation, approved.request.expected_conditions)
    ? observation.retry_count > 0 ? "retry_succeeded" : "observed_success"
    : classifiedOutcome;
  const qualifies = ["observed_success", "retry_succeeded"].includes(outcome)
    && ["succeeded", "not_required"].includes(observation.cleanup_status);
  const request = approved.request;
  const evidence = qualifies ? {
    recipe_id: request.recipe.recipe_id,
    capability_id: request.capability_id,
    environment: request.environment,
    correlation_id: request.correlation_id,
    expected_effect_class: ACTIVE_VERIFICATION_RECIPES[request.recipe.recipe_id]
      .expected_effect_class,
    observed: true,
    latency_ms: observation.latency_ms,
    cleanup_status: observation.cleanup_status,
    collected_at: options.collected_at,
  } : null;
  const resultContent = {
    request: createRecordReference(
      request.request_id,
      ACTIVE_VERIFICATION_REQUEST_SCHEMA,
      request,
    ),
    handoff: createRecordReference(
      approved.handoff_package.handoff_id,
      HANDOFF_PACKAGE_SCHEMA,
      approved.handoff_package,
    ),
    executor: structuredClone(approved.handoff_package.executor),
    environment: request.environment,
    capability_id: request.capability_id,
    recipe_id: request.recipe.recipe_id,
    integration_contract: structuredClone(request.integration_contract),
    observation_provenance: observationProvenance,
    outcome,
    correlation_id: request.correlation_id,
    expected_effect_class: ACTIVE_VERIFICATION_RECIPES[request.recipe.recipe_id]
      .expected_effect_class,
    observed: qualifies,
    latency_ms: Number.isInteger(observation.latency_ms) ? observation.latency_ms : null,
    cleanup_status: observation.cleanup_status,
    observation: {
      retry_count: observation.retry_count,
      duplicate_count: observation.duplicate_count,
      ordering: observation.ordering,
      replay: observation.replay,
      eventual_consistency: observation.eventual_consistency,
      failure_visible: observation.dead_letter_visible,
    },
    classification: {
      environment_bound: true,
      evidence_qualification: qualifies ? "qualifying_machine_evidence" : "verification_gap",
      provider_configuration_only: false,
    },
    retention: {
      real_user_identifiers_retained: false,
      payloads_retained: false,
      messages_retained: false,
      database_rows_retained: false,
    },
    evidence,
    verification_gap: qualifies ? null : { reason_code: GAP_BY_OUTCOME[outcome] },
  };
  const result = {
    schema_version: ACTIVE_VERIFICATION_RESULT_SCHEMA,
    result_id: `active_result_${sha256(resultContent).slice(7, 27)}`,
    ...resultContent,
  };
  result.observation_provenance.normalized_result_digest = sha256(
    normalizedObservationSemantics(result),
  );
  if (
    typeof options.verify_executor_attestation !== "function"
    || options.verify_executor_attestation(observationProvenance, observation) !== true
  ) failure("unverified_executor_observation");
  assertValidActiveVerificationResult(result);
  return { status: qualifies ? "verified" : "verification_gap", result };
}

function outcomeEvidenceReference(result) {
  if (result?.classification?.evidence_qualification !== "qualifying_machine_evidence") {
    return null;
  }
  return {
    digest: sha256(result.evidence),
    source: `${result.executor.id}/${result.request.id}`,
    target: result.expected_effect_class,
    environment: result.environment,
    current: true,
    collected_at: result.evidence.collected_at,
  };
}

function recipeForResult(result) {
  const recipe = ACTIVE_VERIFICATION_RECIPES[result.recipe_id];
  return recipe?.capability_id === result.capability_id
    && recipe?.expected_effect_class === result.expected_effect_class
    ? recipe
    : null;
}

function resultMatchesApprovedPlan(result, approved, assessedAt) {
  validateBoundPlan(approved, "approved", assessedAt);
  const request = approved.request;
  const recipe = ACTIVE_VERIFICATION_RECIPES[request.recipe.recipe_id];
  const qualifies = result.classification.evidence_qualification
    === "qualifying_machine_evidence";
  const evidenceMatches = qualifies
    ? result.evidence?.environment === request.environment
      && result.evidence?.capability_id === request.capability_id
      && result.evidence?.recipe_id === request.recipe.recipe_id
      && result.evidence?.correlation_id === request.correlation_id
      && result.evidence?.expected_effect_class === recipe?.expected_effect_class
    : result.evidence === null && typeof result.verification_gap?.reason_code === "string";
  return result.observation_provenance.normalized_result_digest === sha256(
    normalizedObservationSemantics(result),
  )
    && evidenceMatches
    && result.environment === request.environment
    && result.capability_id === request.capability_id
    && result.recipe_id === request.recipe.recipe_id
    && result.correlation_id === request.correlation_id
    && result.expected_effect_class === recipe?.expected_effect_class
    && recordReferencesEqual(result.request, createRecordReference(
    request.request_id,
    ACTIVE_VERIFICATION_REQUEST_SCHEMA,
    request,
  ))
    && recordReferencesEqual(result.handoff, createRecordReference(
      approved.handoff_package.handoff_id,
      HANDOFF_PACKAGE_SCHEMA,
      approved.handoff_package,
    ))
    && recordReferencesEqual(result.executor, approved.handoff_package.executor)
    && recordReferencesEqual(result.integration_contract, approved.request.integration_contract);
}

export function activeVerificationOutcomeCheck(result, source) {
  assertValidActiveVerificationResult(result);
  if (
    typeof source?.check_id !== "string"
    || !Number.isInteger(source?.check_version)
    || !Number.isFinite(Date.parse(source?.assessed_at))
    || typeof source?.verify_executor_attestation !== "function"
    || source.verify_executor_attestation(result.observation_provenance) !== true
    || !resultMatchesApprovedPlan(result, source?.approved_plan, source.assessed_at)
  ) failure("invalid_active_verification_check_input");
  const recipe = recipeForResult(result);
  if (!recipe) {
    failure("invalid_active_verification_check_input");
  }
  const evidence = outcomeEvidenceReference(result);
  return {
    check_id: source.check_id,
    check_version: source.check_version,
    check_layer: "downstream_outcome",
    capability_ids: [result.capability_id],
    environment: result.environment,
    status: evidence ? "passed" : "unverified",
    ...(evidence ? {} : { reason_code: result.verification_gap.reason_code }),
    evidence: evidence ? [evidence] : [],
  };
}

export function activeVerificationVerificationEvidence(result, source) {
  assertValidActiveVerificationResult(result);
  if (
    !Number.isFinite(Date.parse(source?.assessed_at))
    || typeof source?.verify_executor_attestation !== "function"
    || source.verify_executor_attestation(result.observation_provenance) !== true
    || !resultMatchesApprovedPlan(result, source?.approved_plan, source.assessed_at)
  ) failure("invalid_active_verification_evidence_input");
  const evidence = outcomeEvidenceReference(result);
  return evidence ? [{
    digest: evidence.digest,
    target: evidence.target,
    collected_at: evidence.collected_at,
    current: true,
  }] : [];
}

export { ACTIVE_VERIFICATION_RECIPES };
