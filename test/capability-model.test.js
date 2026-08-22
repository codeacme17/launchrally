import assert from "node:assert/strict";
import test from "node:test";

import {
  assertValidCapabilityCatalog,
  assertValidCapabilityGraph,
  assertValidIntegrationContract,
} from "../packages/contracts/src/index.js";
import {
  buildCapabilityGraph,
  confirmDerivedObligations,
  createCapabilityCatalog,
  createIntegrationContract,
  invalidatedOutputsForCatalogUpdate,
} from "../packages/core/src/index.js";

const intent = {
  schema_version: "launchrally.dev/product-intent-profile/v1",
  profile_id: "intent_product_01",
  revision: 1,
  environment: "production",
  created_at: "2026-08-13T00:00:00.000Z",
  desired_intent: {
    confirmation: "confirmed",
    behaviors: ["customers_purchase_subscription", "customers_sign_in"],
    hard_constraints: [],
    preferences: [],
  },
  observed_implementation: [],
  provenance: [{
    source_id: "source_local_safe_scan",
    source_class: "normalized_repository_facts",
    path: ".",
    digest: `sha256:${"a".repeat(64)}`,
    permission: "local_safe_scan",
  }],
  coverage: {
    state: "partial",
    supported_sources: ["local_safe_scan"],
    excluded_sources: [],
    negative_findings_allowed: false,
  },
  conflicts: [],
  unknowns: ["semantic_coverage_incomplete"],
  retention: {
    raw_source_retained: false,
    provider_output_retained: false,
    sensitive_data_retained: false,
  },
};

test("the core Capability Catalog independently versions all 13 launch domains", () => {
  const catalog = createCapabilityCatalog({ reviewed_at: "2026-08-13T00:00:00.000Z" });
  assert.equal(assertValidCapabilityCatalog(catalog), true);
  assert.equal(catalog.catalog_version, "1.0.0");
  assert.equal(catalog.domains.length, 13);
  assert.equal(new Set(catalog.domains).size, 13);
  assert.equal(catalog.capabilities.length, 13);
  assert.match(catalog.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(Object.hasOwn(catalog, "completion_percentage"), false);

  const missingDomain = structuredClone(catalog);
  missingDomain.capabilities = missingDomain.capabilities.filter(({ domain }) => domain !== "dns_tls");
  assert.throws(
    () => assertValidCapabilityCatalog(missingDomain),
    (error) => error.code === "invalid_capability_catalog",
  );
});

test("the graph keeps four state facets orthogonal and obligations inspectable", () => {
  const catalog = createCapabilityCatalog({ reviewed_at: "2026-08-13T00:00:00.000Z" });
  const graph = buildCapabilityGraph(intent, catalog, {
    graph_id: "graph_product_01",
  });
  assert.equal(assertValidCapabilityGraph(graph), true);
  assert.equal(graph.nodes.length, 13);
  assert.deepEqual(
    graph.nodes.find(({ capability_id: id }) => id === "identity_authentication"),
    {
      capability_id: "identity_authentication",
      environment: "production",
      release_scope: "current_release",
      requirement_state: "unknown",
      decision_state: "undecided",
      implementation_state: "unknown",
      evidence_state: "unverified",
      implementation_path: "unknown",
    },
  );
  assert.ok(graph.derived_obligations.every(({ state }) => state === "candidate"));
  assert.deepEqual(graph.derived_obligations[0].derivation_chain.slice(0, 2), [
    graph.derived_obligations[0].source_behavior_ids[0],
    graph.derived_obligations[0].target_capability_id,
  ]);
  assert.equal(Object.hasOwn(graph, "completion_percentage"), false);

  const confirmed = confirmDerivedObligations(graph, ["obligation_session_lifecycle"]);
  assert.equal(assertValidCapabilityGraph(confirmed), true);
  assert.equal(
    confirmed.derived_obligations.find(({ obligation_id: id }) =>
      id === "obligation_session_lifecycle").confirmation,
    "explicit_user_confirmation",
  );
  assert.equal(
    confirmed.nodes.find(({ capability_id: id }) =>
      id === "identity_authentication").requirement_state,
    "required",
  );
  assert.equal(graph.derived_obligations.every(({ state }) => state === "candidate"), true);
});

test("materially intent-changing obligations cannot be silently confirmed", () => {
  const catalog = createCapabilityCatalog({ reviewed_at: "2026-08-13T00:00:00.000Z" });
  const graph = buildCapabilityGraph(intent, catalog, {
    graph_id: "graph_product_01",
  });
  assert.throws(
    () => confirmDerivedObligations(graph, ["unknown_obligation"]),
    (error) => error.code === "invalid_obligation_confirmation",
  );
});

test("catalog and Product Intent content are cryptographically bound", () => {
  const catalog = createCapabilityCatalog({ reviewed_at: "2026-08-13T00:00:00.000Z" });
  const tamperedCatalog = structuredClone(catalog);
  tamperedCatalog.capabilities[0].summary = "Changed without a new digest.";
  assert.throws(
    () => assertValidCapabilityCatalog(tamperedCatalog),
    (error) => error.code === "invalid_capability_catalog",
  );
  assert.throws(
    () => buildCapabilityGraph({
      schema_version: intent.schema_version,
      desired_intent: intent.desired_intent,
    }, catalog, { graph_id: "graph_impostor" }),
    (error) => error.code === "invalid_capability_graph_input",
  );
});

test("Provider-neutral Integration Contracts cover sync and async semantics", () => {
  for (const mode of ["synchronous", "asynchronous"]) {
    const contract = createIntegrationContract({
      contract_id: `integration_identity_data_${mode}`,
      environment: "production",
      source_capability_id: "identity_authentication",
      target_capability_id: "application_data",
      mode,
      provider_binding: { kind: "unknown", provider_id: null },
      semantics: {
        authentication: "signed_or_equivalent",
        ordering: "per_subject",
        duplication: "possible",
        retry: "bounded_backoff",
        replay: "supported",
        idempotency: "required",
        eventual_consistency: "expected",
        failure_visibility: "operator_visible",
        privacy: "normalized_identifiers_only",
        success_evidence: ["state_transition_observed"],
        invalidation_dependencies: ["identity_event_shape", "data_projection"],
      },
    });
    assert.equal(assertValidIntegrationContract(contract), true);
    assert.deepEqual(contract.provider_binding, { kind: "unknown", provider_id: null });
  }
  assert.throws(
    () => createIntegrationContract({
      contract_id: "integration_unknown_provider",
      environment: "production",
      source_capability_id: "identity_authentication",
      target_capability_id: "application_data",
      mode: "synchronous",
      provider_binding: { kind: "unknown", provider_id: "invented_provider" },
      semantics: {
        authentication: "none_required",
        ordering: "not_applicable",
        duplication: "not_applicable",
        retry: "not_applicable",
        replay: "not_applicable",
        idempotency: "not_applicable",
        eventual_consistency: "not_applicable",
        failure_visibility: "operator_visible",
        privacy: "normalized_identifiers_only",
        success_evidence: ["state_transition_observed"],
        invalidation_dependencies: ["identity_event_shape"],
      },
    }),
    (error) => error.code === "invalid_integration_contract",
  );
});

test("Integration Contract factory canonicalizes supported legacy idempotency semantics", () => {
  const create = (idempotency) => createIntegrationContract({
    contract_id: "integration_identity_data_legacy",
    environment: "production",
    source_capability_id: "identity_authentication",
    target_capability_id: "application_data",
    mode: "asynchronous",
    provider_binding: { kind: "unknown", provider_id: null },
    semantics: {
      authentication: "signed_or_equivalent",
      ordering: "per_subject",
      duplication: "possible",
      retry: "bounded_backoff",
      replay: "supported",
      idempotency,
      eventual_consistency: "expected",
      failure_visibility: "operator_visible",
      privacy: "normalized_identifiers_only",
      success_evidence: ["state_transition_observed"],
      invalidation_dependencies: ["identity_event_shape"],
    },
  });

  assert.deepEqual(create("required_by_provider_event_id").semantics, {
    ...create("required").semantics,
    idempotency_key: "provider_event_id",
  });
  assert.deepEqual(create("deduplicate_by_delivery_attempt_id").semantics, {
    ...create("required").semantics,
    idempotency_key: "delivery_attempt_id",
  });
  assert.throws(
    () => create("best_effort_when_possible"),
    (error) => error.code === "invalid_integration_contract_input"
      && /required, not_required, not_applicable, or unknown/u.test(error.message)
      && /idempotency_key/u.test(error.message),
  );
});

test("catalog changes invalidate only outputs declaring changed dependencies", () => {
  const outputs = [
    { output_id: "identity_plan", invalidation_dependencies: ["identity_authentication"] },
    { output_id: "billing_plan", invalidation_dependencies: ["billing_entitlement"] },
    { output_id: "whole_blueprint", invalidation_dependencies: ["catalog:*", "runtime_execution"] },
  ];
  assert.deepEqual(
    invalidatedOutputsForCatalogUpdate(["identity_authentication"], outputs),
    ["identity_plan", "whole_blueprint"],
  );
  assert.deepEqual(invalidatedOutputsForCatalogUpdate([], outputs), []);
});
