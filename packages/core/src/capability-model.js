import { createHash } from "node:crypto";

import {
  CAPABILITY_CATALOG_SCHEMA,
  CAPABILITY_GRAPH_SCHEMA,
  INTEGRATION_CONTRACT_SCHEMA,
  PRODUCT_INTENT_PROFILE_SCHEMA,
  assertValidCapabilityCatalog,
  assertValidCapabilityGraph,
  assertValidIntegrationContract,
  assertValidProductIntentProfile,
  computeCapabilityCatalogDigest,
} from "@launchrally/contracts";

const CATALOG_VERSION = "1.0.0";
const DOMAINS = Object.freeze([
  "runtime",
  "identity",
  "data",
  "billing_entitlement",
  "object_storage",
  "communication",
  "background_work",
  "observability",
  "analytics_privacy",
  "dns_tls",
  "ci_cd",
  "secrets_configuration",
  "backup_recovery_retention",
]);

const CAPABILITIES = Object.freeze([
  ["runtime_execution", "runtime", "Execute the product runtime."],
  ["identity_authentication", "identity", "Authenticate and authorize product users."],
  ["application_data", "data", "Persist and retrieve application data."],
  ["billing_entitlement", "billing_entitlement", "Connect billing events to entitlements."],
  ["object_storage", "object_storage", "Store and serve product objects."],
  ["communication_delivery", "communication", "Deliver product communications."],
  ["background_work", "background_work", "Execute asynchronous background work."],
  ["operational_observability", "observability", "Expose operational health and failures."],
  ["analytics_privacy", "analytics_privacy", "Collect analytics within privacy constraints."],
  ["dns_tls", "dns_tls", "Route trusted DNS and TLS traffic."],
  ["ci_cd", "ci_cd", "Build and deliver reviewed product changes."],
  ["secrets_configuration", "secrets_configuration", "Supply environment-scoped configuration."],
  ["backup_recovery_retention", "backup_recovery_retention", "Recover retained product state."],
]);

const OBLIGATION_RULES = Object.freeze([
  {
    behavior_id: "customers_purchase_subscription",
    obligation_id: "obligation_entitlement_lifecycle",
    target_capability_id: "billing_entitlement",
    consequence: "billing_events_require_entitlement_state",
  },
  {
    behavior_id: "customers_receive_transactional_email",
    obligation_id: "obligation_delivery_visibility",
    target_capability_id: "communication_delivery",
    consequence: "delivery_failures_require_visibility",
  },
  {
    behavior_id: "customers_sign_in",
    obligation_id: "obligation_session_lifecycle",
    target_capability_id: "identity_authentication",
    consequence: "authenticated_sessions_require_revocation",
  },
  {
    behavior_id: "customers_upload_objects",
    obligation_id: "obligation_object_retention",
    target_capability_id: "object_storage",
    consequence: "stored_objects_require_access_and_retention",
  },
  {
    behavior_id: "background_jobs_execute",
    obligation_id: "obligation_background_failure_visibility",
    target_capability_id: "background_work",
    consequence: "background_failures_require_retry_visibility",
  },
  {
    behavior_id: "product_analytics_collected",
    obligation_id: "obligation_analytics_consent",
    target_capability_id: "analytics_privacy",
    consequence: "analytics_collection_requires_privacy_controls",
  },
]);

const NORMALIZED_VALUE = /^[a-z][a-z0-9_]{2,127}$/u;

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function digest(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex")}`;
}

function capability([capabilityId, domain, summary]) {
  return {
    capability_id: capabilityId,
    domain,
    summary,
    requirement_facets: ["applicability", "environment", "source_behavior"],
    decision_facets: ["action", "implementation_path"],
    implementation_facets: ["presence", "environment_binding"],
    evidence_facets: ["configuration", "operational", "outcome"],
  };
}

export function createCapabilityCatalog({ reviewed_at: reviewedAt } = {}) {
  if (typeof reviewedAt !== "string" || Number.isNaN(Date.parse(reviewedAt))) {
    const error = new Error("A reviewed_at date-time is required for the Capability Catalog.");
    error.code = "invalid_capability_catalog_input";
    throw error;
  }
  const content = {
    catalog_id: "catalog_launchrally_phase1",
    catalog_version: CATALOG_VERSION,
    reviewed_at: reviewedAt,
    domains: [...DOMAINS],
    capabilities: CAPABILITIES.map(capability),
    provenance: {
      trust_tier: "core_catalog",
      source_refs: ["phase1_product_contract", "issue_127"],
    },
  };
  const catalog = {
    schema_version: CAPABILITY_CATALOG_SCHEMA,
    ...content,
    digest: computeCapabilityCatalogDigest(content),
  };
  assertValidCapabilityCatalog(catalog);
  return catalog;
}

function derivedObligations(behaviors) {
  return OBLIGATION_RULES.filter(({ behavior_id: behaviorId }) => behaviors.includes(behaviorId))
    .map((rule) => ({
      obligation_id: rule.obligation_id,
      source_behavior_ids: [rule.behavior_id],
      target_capability_id: rule.target_capability_id,
      state: "candidate",
      derivation_chain: [rule.behavior_id, rule.target_capability_id, rule.consequence],
    }))
    .sort((left, right) => left.obligation_id.localeCompare(right.obligation_id));
}

export function buildCapabilityGraph(intent, catalog, options = {}) {
  try {
    assertValidProductIntentProfile(intent);
  } catch {
    const error = new Error("A valid confirmed Product Intent is required.");
    error.code = "invalid_capability_graph_input";
    throw error;
  }
  if (
    intent.desired_intent.confirmation !== "confirmed"
    || typeof options.graph_id !== "string"
    || !NORMALIZED_VALUE.test(options.graph_id)
  ) {
    const error = new Error("A confirmed Product Intent and graph identity are required.");
    error.code = "invalid_capability_graph_input";
    throw error;
  }
  assertValidCapabilityCatalog(catalog);
  const obligations = derivedObligations(intent.desired_intent.behaviors);
  const graph = {
    schema_version: CAPABILITY_GRAPH_SCHEMA,
    graph_id: options.graph_id,
    revision: 1,
    environment: intent.environment,
    product_intent: {
      id: intent.profile_id,
      schema_version: PRODUCT_INTENT_PROFILE_SCHEMA,
      digest: digest(intent),
    },
    catalog: {
      id: catalog.catalog_id,
      schema_version: CAPABILITY_CATALOG_SCHEMA,
      digest: catalog.digest,
    },
    nodes: catalog.capabilities.map(({ capability_id: capabilityId }) => ({
      capability_id: capabilityId,
      environment: intent.environment,
      requirement_state: "unknown",
      decision_state: "undecided",
      implementation_state: "unknown",
      evidence_state: "unverified",
      implementation_path: "unknown",
    })),
    edges: obligations.map(({ source_behavior_ids: [behaviorId], target_capability_id: target }) => ({
      from: behaviorId,
      to: target,
      kind: "requires",
    })),
    derived_obligations: obligations,
  };
  assertValidCapabilityGraph(graph);
  return graph;
}

export function confirmDerivedObligations(graph, obligationIds) {
  assertValidCapabilityGraph(graph);
  if (!Array.isArray(obligationIds) || obligationIds.length === 0) {
    const error = new Error("At least one derived obligation must be explicitly selected.");
    error.code = "invalid_obligation_confirmation";
    throw error;
  }
  const selected = new Set(obligationIds);
  if (selected.size !== obligationIds.length || obligationIds.some((id) =>
    !graph.derived_obligations.some(({ obligation_id: obligationId }) => obligationId === id))) {
    const error = new Error("Only current derived-obligation candidates can be confirmed.");
    error.code = "invalid_obligation_confirmation";
    throw error;
  }
  const next = structuredClone(graph);
  next.revision += 1;
  next.derived_obligations = next.derived_obligations.map((obligation) => selected.has(
    obligation.obligation_id,
  ) ? {
      ...obligation,
      state: "confirmed",
      confirmation: "explicit_user_confirmation",
    } : obligation);
  const confirmedTargets = new Set(next.derived_obligations
    .filter(({ state }) => state === "confirmed")
    .map(({ target_capability_id: target }) => target));
  next.nodes = next.nodes.map((node) => confirmedTargets.has(node.capability_id)
    ? { ...node, requirement_state: "required" }
    : node);
  assertValidCapabilityGraph(next);
  return next;
}

function normalizedIntegrationInput(input) {
  const scalarValues = [
    input.contract_id,
    input.environment,
    input.source_capability_id,
    input.target_capability_id,
    ...Object.entries(input.semantics ?? {})
      .filter(([, value]) => typeof value === "string")
      .map(([, value]) => value),
  ];
  const listValues = [
    ...(input.semantics?.success_evidence ?? []),
    ...(input.semantics?.invalidation_dependencies ?? []),
  ];
  return scalarValues.every((value) => typeof value === "string" && NORMALIZED_VALUE.test(value))
    && listValues.length >= 2
    && listValues.every((value) => typeof value === "string" && NORMALIZED_VALUE.test(value));
}

export function createIntegrationContract(input) {
  if (!normalizedIntegrationInput(input)) {
    const error = new Error("Integration Contract values must be normalized, secret-safe identifiers.");
    error.code = "invalid_integration_contract_input";
    throw error;
  }
  const contract = {
    schema_version: INTEGRATION_CONTRACT_SCHEMA,
    contract_id: input.contract_id,
    contract_version: "1.0.0",
    environment: input.environment,
    source_capability_id: input.source_capability_id,
    target_capability_id: input.target_capability_id,
    mode: input.mode,
    provider_binding: structuredClone(input.provider_binding),
    semantics: structuredClone(input.semantics),
  };
  assertValidIntegrationContract(contract);
  return contract;
}

export function invalidatedOutputsForCatalogUpdate(changedCapabilityIds, outputs) {
  if (!Array.isArray(changedCapabilityIds) || !Array.isArray(outputs)) {
    const error = new Error("Catalog invalidation requires changed capabilities and typed outputs.");
    error.code = "invalid_catalog_invalidation_input";
    throw error;
  }
  const changed = new Set(changedCapabilityIds);
  if (changed.size === 0) return [];
  return outputs.filter(({ invalidation_dependencies: dependencies }) =>
    Array.isArray(dependencies)
    && (dependencies.includes("catalog:*") || dependencies.some((id) => changed.has(id))))
    .map(({ output_id: outputId }) => outputId)
    .sort();
}

export const CAPABILITY_CATALOG_DOMAINS = DOMAINS;
