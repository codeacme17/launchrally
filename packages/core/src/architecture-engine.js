import path from "node:path";

import {
  ARCHITECT_INTERACTION_SCHEMA,
  ARCHITECTURE_BLUEPRINT_SCHEMA,
  CAPABILITY_GRAPH_SCHEMA,
  PRODUCT_INTENT_PROFILE_SCHEMA,
  assertValidArchitectInteraction,
  assertValidArchitectureBlueprint,
  assertValidCapabilityCatalog,
  assertValidCapabilityGraph,
  assertValidIntegrationContract,
  assertValidProductIntentProfile,
  assertValidReportPackage,
} from "@launchrally/contracts";

import { sha256 } from "./local-history.js";
import { createArchitecturePackageBundle } from "./architecture-package.js";
import { evaluateReportCurrentness } from "./report-currentness.js";
import { decodeResumeState, encodeResumeState } from "./resume-state.js";

const STATE_VERSION = "architecture-decision-engine/v1";
const DECISION_RESPONSE = new Set(["confirm", "reject"]);
const DECISION_ACTION = new Set(["adopt", "replace", "defer", "undecided"]);
const REPLACEMENT_REASONS = Object.freeze({
  confirmed_constraint_mismatch: "The existing implementation violates a confirmed hard constraint.",
  confirmed_operational_mismatch: "The existing implementation has a confirmed operational mismatch.",
  confirmed_integration_incompatibility: "The existing implementation has a confirmed Integration Contract incompatibility.",
});
const REVIEWED_IMPLEMENTATIONS = Object.freeze({
  identity_managed_eu: Object.freeze({
    capability_id: "identity_authentication",
    implementation_path: "managed",
    attributes: Object.freeze({
      data_residency: "eu",
      external_network: true,
      operational_model: "managed_operations",
      failure_domain: "external_identity_service",
      concentration_group: "identity_provider",
      exit_complexity: "moderate_export_and_session_migration",
      migration_effort: "moderate",
      cost_drivers: ["active_users", "support_level"],
      preference_tags: ["managed_operations"],
    }),
    source_ref: "core_architecture_facts_v1",
  }),
  identity_managed_us: Object.freeze({
    capability_id: "identity_authentication",
    implementation_path: "managed",
    attributes: Object.freeze({
      data_residency: "us",
      external_network: true,
      operational_model: "managed_operations",
      failure_domain: "external_identity_service",
      concentration_group: "identity_provider",
      exit_complexity: "moderate_export_and_session_migration",
      migration_effort: "moderate",
      cost_drivers: ["active_users", "support_level"],
      preference_tags: ["managed_operations"],
    }),
    source_ref: "core_architecture_facts_v1",
  }),
  identity_self_hosted: Object.freeze({
    capability_id: "identity_authentication",
    implementation_path: "self_hosted",
    attributes: Object.freeze({
      self_hosted: true,
      external_network: false,
      operational_model: "self_hosted_operations",
      failure_domain: "application_owned_identity_runtime",
      concentration_group: "application_runtime",
      exit_complexity: "application_owned_data_portable",
      migration_effort: "high",
      cost_drivers: ["compute", "operator_time", "backup_retention"],
      preference_tags: ["provider_portability", "open_source_preferred"],
    }),
    source_ref: "core_architecture_facts_v1",
  }),
});

function decodeState(token) {
  return decodeResumeState(token, (state) => state?.state_version === STATE_VERSION);
}

function reference(id, schemaVersion, value) {
  return { id, schema_version: schemaVersion, digest: sha256(value) };
}

function reportReference(report) {
  return reference(`report_${sha256(report).slice(7, 27)}`, report.schema_version, report);
}

function interaction(status, state, resumeToken, sourceRefs, request) {
  const value = {
    schema_version: ARCHITECT_INTERACTION_SCHEMA,
    interaction_id: "interaction_architecture_decision_engine",
    operation: "architect",
    status,
    state,
    resume_token: resumeToken,
    source_refs: sourceRefs,
    request,
    preview: {
      effect_classes: ["read_only"],
      user_visible_effects: [
        "Review Provider-neutral architecture recommendations without repository or Provider writes.",
      ],
    },
  };
  assertValidArchitectInteraction(value);
  return value;
}

function result(status, state, resumeToken, sourceRefs, request, extra = {}) {
  return {
    contract: ARCHITECT_INTERACTION_SCHEMA,
    status,
    operation: "architect",
    state,
    resume_token: resumeToken,
    request,
    interaction: interaction(status, state, resumeToken, sourceRefs, request),
    ...extra,
  };
}

function executionError(error) {
  return {
    contract: ARCHITECT_INTERACTION_SCHEMA,
    status: "execution_error",
    operation: "architect",
    error,
  };
}

function decisionForNode(node) {
  const existing = node.implementation_state === "present";
  return {
    decision_id: `decision_${node.capability_id}`,
    capability_id: node.capability_id,
    action: existing ? "retain" : "investigate",
    implementation_path: node.implementation_path,
    disposition: "recommended",
    rationale: [existing
      ? "Retain the existing implementation unless a constraint conflict or positive replacement rationale is established."
      : "Investigate the unknown implementation before adopting or replacing it."],
    tradeoffs: [existing ? "Existing operational knowledge is preserved." : "Selection remains pending."],
    assumptions: ["The current Report and confirmed constraints remain current."],
    reevaluation_triggers: ["Implementation Evidence or a confirmed constraint changes."],
    knowledge_refs: [],
  };
}

function alternativeDecision(alternative, hardConstraints, disposition) {
  const implementation = REVIEWED_IMPLEMENTATIONS[alternative?.implementation_id];
  if (
    !implementation
    || !DECISION_ACTION.has(alternative?.action)
    || (alternative.action === "replace"
      && !REPLACEMENT_REASONS[alternative.replacement_reason])
  ) return null;
  const stateFor = (constraint) => {
    const { attributes } = implementation;
    if (constraint === "data_residency_eu") {
      return attributes.data_residency === "eu"
        ? "supported"
        : attributes.data_residency ? "violated" : "unknown";
    }
    if (constraint === "data_residency_us") {
      return attributes.data_residency === "us"
        ? "supported"
        : attributes.data_residency ? "violated" : "unknown";
    }
    const booleanAttributes = {
      local_first_required: ["local_first", true],
      no_external_network: ["external_network", false],
      self_hosting_required: ["self_hosted", true],
    };
    const [attribute, expected] = booleanAttributes[constraint] ?? [];
    if (!attribute || typeof attributes[attribute] !== "boolean") return "unknown";
    return attributes[attribute] === expected ? "supported" : "violated";
  };
  const coverage = hardConstraints.map((constraintId) => ({
    constraint_id: constraintId,
    state: stateFor(constraintId),
  }));
  const violated = coverage.filter(({ state }) => state === "violated")
    .map(({ constraint_id: id }) => id);
  const unknown = coverage.filter(({ state }) => state === "unknown")
    .map(({ constraint_id: id }) => id);
  const compatible = violated.length === 0 && unknown.length === 0;
  const excluded = !compatible;
  return {
    decision_id: `decision_${alternative.implementation_id}_${alternative.action}`,
    capability_id: implementation.capability_id,
    action: alternative.action,
    implementation_path: alternative.action === "defer"
      ? "deferred"
      : implementation.implementation_path,
    disposition: excluded ? "excluded" : disposition,
    rationale: [excluded
      ? violated.length > 0
        ? `This implementation conflicts with confirmed hard constraints: ${violated.join(", ")}.`
        : `This implementation has unknown hard-constraint fit: ${unknown.join(", ")}.`
      : alternative.action === "replace"
        ? REPLACEMENT_REASONS[alternative.replacement_reason]
        : "This implementation fits every confirmed hard constraint; it is not a universal best choice."],
    tradeoffs: ["Adoption introduces migration and operational change."],
    assumptions: [
      `Constraint attributes come from ${implementation.source_ref}; Provider-specific live claims remain unverified.`,
    ],
    reevaluation_triggers: ["Constraints, reviewed knowledge, or implementation Evidence changes."],
    knowledge_refs: [],
  };
}

function integrationCompatibility(contracts) {
  const fields = [
    "authentication",
    "ordering",
    "duplication",
    "retry",
    "replay",
    "idempotency",
    "eventual_consistency",
    "failure_visibility",
    "privacy",
  ];
  const evaluated = contracts.map((contract) => {
    const { semantics } = contract;
    const incompatibleReasons = [];
    if (
      contract.mode === "asynchronous"
      && semantics.duplication !== "not_applicable"
      && semantics.idempotency !== "required"
    ) incompatibleReasons.push("duplicate_delivery_without_required_idempotency");
    if (semantics.authentication === "none" || semantics.authentication === "unknown") {
      incompatibleReasons.push("authentication_boundary_unresolved");
    }
    if (semantics.failure_visibility === "none" || semantics.failure_visibility === "unknown") {
      incompatibleReasons.push("failure_visibility_unresolved");
    }
    if (semantics.privacy === "unknown" || semantics.privacy === "unrestricted") {
      incompatibleReasons.push("privacy_boundary_unresolved");
    }
    const state = incompatibleReasons.length > 0
      ? "incompatible"
      : contract.provider_binding.kind === "unknown"
        ? "unknown"
        : "compatible";
    const serializedSemantics = fields
      .map((field) => `${field}=${contract.semantics[field]}`).join(",");
    return {
      state,
      detail: `${contract.contract_id}:${state}[${contract.mode};${serializedSemantics};success_evidence=${contract.semantics.success_evidence.join("+")};invalidation=${contract.semantics.invalidation_dependencies.join("+")};reasons=${incompatibleReasons.join("+") || "none"}]`,
    };
  });
  const count = (state) => evaluated.filter((item) => item.state === state).length;
  return `compatible=${count("compatible")} incompatible=${count("incompatible")} unknown=${count("unknown")}; ${evaluated.map(({ detail }) => detail).join(" ")}`;
}

function implementationEvaluation(proposals, alternatives, hardConstraints) {
  const accepted = proposals.filter((_proposal, index) =>
    alternatives[index]?.disposition !== "excluded");
  const implementations = accepted.map(({ implementation_id: id }) => REVIEWED_IMPLEMENTATIONS[id]);
  const residencyConstraints = hardConstraints.filter((constraint) =>
    constraint.startsWith("data_residency_"));
  const concentration = new Map();
  for (const implementation of implementations) {
    const group = implementation.attributes.concentration_group;
    concentration.set(group, (concentration.get(group) ?? 0) + 1);
  }
  const byCapability = new Map();
  for (const implementation of implementations) {
    byCapability.set(
      implementation.capability_id,
      (byCapability.get(implementation.capability_id) ?? 0) + 1,
    );
  }
  return {
    operational_burden: implementations.length > 0
      ? [...new Set(implementations.map(({ attributes }) => attributes.operational_model))].sort()
      : ["implementation_operational_model_unknown"],
    cost_drivers: implementations.length > 0
      ? [...new Set(implementations.flatMap(({ attributes }) => attributes.cost_drivers))].sort()
      : ["usage_volume", "retention", "support_level", "operational_ownership"],
    data_flow_residency: residencyConstraints.length > 0
      ? residencyConstraints.map((constraint) => `${constraint}_confirmed`).sort()
      : ["data_residency_not_constrained"],
    failure_domains: implementations.length > 0
      ? [...new Set(implementations.map(({ attributes }) => attributes.failure_domain))].sort()
      : ["implementation_failure_domains_unknown"],
    provider_concentration: concentration.size === 0
      ? "Implementation concentration is unknown."
      : [...concentration].sort(([left], [right]) => left.localeCompare(right))
        .map(([group, count]) => `${group}:${count}`).join(", "),
    lock_in_exit: implementations.length > 0
      ? [...new Set(implementations.map(({ attributes }) => attributes.exit_complexity))].sort()
      : ["implementation_exit_path_unknown"],
    duplication: byCapability.size === 0
      ? ["no_alternative_implementation_selected"]
      : [...byCapability].filter(([, count]) => count > 1)
        .map(([capabilityId, count]) => `${capabilityId}:${count}_compatible_options`)
        .concat([...byCapability].every(([, count]) => count === 1) ? ["no_capability_duplication"] : []),
    migration_cost: accepted.length > 0
      ? accepted.map((proposal) => `${proposal.implementation_id}_${proposal.action}:${REVIEWED_IMPLEMENTATIONS[proposal.implementation_id].attributes.migration_effort}`)
      : ["no_migration_proposal"],
  };
}

function blueprint(source, options) {
  const { report_package: reportPackage, product_intent: intent, capability_graph: graph } = source;
  const hard = intent.desired_intent.hard_constraints;
  const preferences = intent.desired_intent.preferences;
  const preferenceScore = ({ implementation_id: implementationId }) =>
    REVIEWED_IMPLEMENTATIONS[implementationId]?.attributes.preference_tags
      .filter((tag) => preferences.includes(tag)).length ?? -1;
  const proposals = [...(source.alternatives ?? [])].sort((left, right) =>
    preferenceScore(right) - preferenceScore(left)
    || `${left.implementation_id}_${left.action}`.localeCompare(
      `${right.implementation_id}_${right.action}`,
    ));
  const proposalIds = proposals.map(({ implementation_id: id, action }) => `${id}_${action}`);
  if (new Set(proposalIds).size !== proposalIds.length) return null;
  const nodeByCapability = new Map(graph.nodes.map((node) => [node.capability_id, node]));
  if (proposals.some(({ implementation_id: implementationId }) => {
    const implementation = REVIEWED_IMPLEMENTATIONS[implementationId];
    return !implementation || !nodeByCapability.has(implementation.capability_id);
  })) return null;
  const compatibleByCapability = new Map();
  const alternatives = proposals.map((alternative) => {
    const implementation = REVIEWED_IMPLEMENTATIONS[alternative.implementation_id];
    const priorCompatible = compatibleByCapability.get(implementation.capability_id) ?? 0;
    const node = nodeByCapability.get(implementation.capability_id);
    const disposition = node.implementation_state === "absent" && priorCompatible === 0
      ? "recommended"
      : "alternative";
    const decision = alternativeDecision(alternative, hard, disposition);
    if (decision && decision.disposition !== "excluded") {
      compatibleByCapability.set(implementation.capability_id, priorCompatible + 1);
    }
    return decision;
  });
  if (alternatives.some((alternative) => alternative === null)) return null;
  const recommendedAlternativeCapabilities = new Set(alternatives
    .filter(({ disposition }) => disposition === "recommended")
    .map(({ capability_id: capabilityId }) => capabilityId));
  const decisions = [
    ...graph.nodes.map((node) => {
      const decision = decisionForNode(node);
      return recommendedAlternativeCapabilities.has(node.capability_id)
        ? { ...decision, disposition: "alternative" }
        : decision;
    }),
    ...alternatives,
  ];
  const unknowns = [...new Set([
    ...intent.unknowns,
    ...graph.nodes.filter(({ implementation_state: state }) => state === "unknown")
      .map(({ capability_id: id }) => `${id}_implementation`),
  ])].sort();
  const report = reportPackage.report;
  const integrations = source.integration_contracts;
  const evaluation = implementationEvaluation(proposals, alternatives, hard);
  const value = {
    schema_version: ARCHITECTURE_BLUEPRINT_SCHEMA,
    blueprint_id: `blueprint_${sha256({
      report: report.report_id,
      intent: intent.profile_id,
      graph: graph.graph_id,
      decisions,
    }).slice(7, 27)}`,
    revision: 1,
    environment: intent.environment,
    source_report: reportReference(report),
    product_intent: reference(intent.profile_id, PRODUCT_INTENT_PROFILE_SCHEMA, intent),
    capability_graph: reference(graph.graph_id, CAPABILITY_GRAPH_SCHEMA, graph),
    constraints: { hard: [...hard], preferences: [...intent.desired_intent.preferences] },
    decisions,
    whole_product: {
      integration_compatibility: integrationCompatibility(integrations),
      operational_burden: evaluation.operational_burden,
      cost_scenarios: [{
        scenario: "current_confirmed_scope",
        drivers: evaluation.cost_drivers,
        assumptions: ["No current official pricing source was reviewed by this decision run."],
        review_date: options.review_date,
        unknowns: ["currency_estimate", "future_usage", "provider_specific_pricing"],
        currency_estimate: null,
      }],
      data_flow_residency: evaluation.data_flow_residency,
      failure_domains: evaluation.failure_domains,
      provider_concentration: evaluation.provider_concentration,
      lock_in_exit: evaluation.lock_in_exit,
      duplication: evaluation.duplication,
      migration_cost: evaluation.migration_cost,
    },
    unknowns,
  };
  assertValidArchitectureBlueprint(value);
  return value;
}

function validateInitialSource(cwd, source) {
  try {
    assertValidReportPackage(source?.report_package);
    assertValidProductIntentProfile(source?.product_intent);
    assertValidCapabilityCatalog(source?.catalog);
    assertValidCapabilityGraph(source?.capability_graph);
    if (!Array.isArray(source?.integration_contracts) || source.integration_contracts.length === 0) {
      return { error: "missing_integration_contracts" };
    }
    source.integration_contracts.forEach(assertValidIntegrationContract);
  } catch (error) {
    return { error: error.code ?? "invalid_architecture_input" };
  }
  if (
    source.product_intent.desired_intent.confirmation !== "confirmed"
    || source.product_intent.environment !== source.capability_graph.environment
    || source.capability_graph.product_intent.id !== source.product_intent.profile_id
    || source.capability_graph.catalog.id !== source.catalog.catalog_id
    || source.integration_contracts.some((contract) =>
      contract.environment !== source.product_intent.environment
      || !source.capability_graph.nodes.some(({ capability_id: id }) =>
        id === contract.source_capability_id)
      || !source.capability_graph.nodes.some(({ capability_id: id }) =>
        id === contract.target_capability_id))
  ) return { error: "inconsistent_architecture_input" };
  const currentness = evaluateReportCurrentness(source.report_package, { cwd });
  if (!currentness.current) return { stale: currentness.currentness };
  return { valid: true };
}

export function runArchitectureDecisionEngine(cwd, source = {}, options = {}) {
  const root = path.resolve(cwd);
  if (!options.resume_token) {
    const valid = validateInitialSource(root, source);
    if (valid.error) return executionError(valid.error);
    if (valid.stale) return {
      contract: ARCHITECT_INTERACTION_SCHEMA,
      status: "stale_input",
      operation: "architect",
      state: "blueprint_review",
      currentness: valid.stale,
    };
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(options.review_date ?? "")) {
      return executionError("invalid_review_date");
    }
    const createdBlueprint = blueprint(source, options);
    if (!createdBlueprint) return executionError("invalid_architecture_alternatives");
    const sourceRefs = [
      createdBlueprint.source_report,
      createdBlueprint.product_intent,
      createdBlueprint.capability_graph,
    ];
    const state = {
      state_version: STATE_VERSION,
      root,
      stage: "blueprint_review",
      blueprint: createdBlueprint,
      source_refs: sourceRefs,
      responses: {},
      package_source: {
        product_intent: structuredClone(source.product_intent),
        catalog: structuredClone(source.catalog),
        capability_graph: structuredClone(source.capability_graph),
        integration_contracts: structuredClone(source.integration_contracts),
        provider_knowledge_refs: structuredClone(source.provider_knowledge_refs ?? []),
        previous_package: source.previous_package
          ? structuredClone(source.previous_package)
          : undefined,
      },
    };
    const request = { kind: "blueprint_confirmation", choices: ["confirm", "reject", "cancel"] };
    return result(
      "needs_confirmation",
      "blueprint_review",
      encodeResumeState(state),
      sourceRefs,
      request,
      { blueprint: createdBlueprint },
    );
  }

  const state = decodeState(options.resume_token);
  if (!state || state.root !== root) return executionError("invalid_resume_token");
  if (state.stage === "blueprint_review") {
    if (options.blueprint_confirmation === "cancel") {
      return result("cancelled", "blueprint_review", null, state.source_refs, {
        kind: "none",
        choices: ["none"],
      }, { outcome: "cancelled" });
    }
    if (options.blueprint_confirmation === "reject") {
      return result("denied", "blueprint_review", null, state.source_refs, {
        kind: "none",
        choices: ["none"],
      }, { outcome: "blueprint_rejected" });
    }
    if (options.blueprint_confirmation !== "confirm") {
      return result("needs_confirmation", "blueprint_review", options.resume_token, state.source_refs, {
        kind: "blueprint_confirmation",
        choices: ["confirm", "reject", "cancel"],
      }, { blueprint: state.blueprint });
    }
    const next = { ...state, stage: "decision_confirmation" };
    const pending = state.blueprint.decisions.map(({ decision_id: decisionId }) => decisionId);
    return result("partial_completion", "decision_confirmation", encodeResumeState(next), state.source_refs, {
      kind: "independent_decision_confirmation",
      choices: ["confirm", "reject"],
    }, { blueprint: state.blueprint, pending_decision_ids: pending, decision_results: [] });
  }

  if (state.stage === "decision_confirmation") {
    const known = new Set(state.blueprint.decisions.map(({ decision_id: decisionId }) => decisionId));
    const responses = options.decision_responses;
    if (
      !responses
      || typeof responses !== "object"
      || Array.isArray(responses)
      || Object.entries(responses).some(([id, response]) =>
        !known.has(id) || state.responses[id] || !DECISION_RESPONSE.has(response))
    ) return executionError("invalid_decision_responses");
    const nextResponses = { ...state.responses, ...responses };
    const pending = [...known].filter((id) => !nextResponses[id]);
    const decisionResults = [...known]
      .filter((id) => nextResponses[id])
      .map((id) => ({ decision_id: id, response: nextResponses[id] }));
    if (pending.length > 0) {
      const next = { ...state, responses: nextResponses };
      return result("partial_completion", "decision_confirmation", encodeResumeState(next), state.source_refs, {
        kind: "independent_decision_confirmation",
        choices: ["confirm", "reject"],
      }, { blueprint: state.blueprint, pending_decision_ids: pending, decision_results: decisionResults });
    }
    const confirmed = decisionResults.filter(({ response }) => response === "confirm");
    let architecturePackage = null;
    if (confirmed.length > 0) {
      try {
        architecturePackage = createArchitecturePackageBundle({
          blueprint: state.blueprint,
          ...state.package_source,
          decision_results: decisionResults,
          task_graph: null,
          dependencies: confirmed.map(({ decision_id: decisionId }) => ({
            source_id: decisionId,
            dependent_semantics: ["architecture_record"],
            evidence_ids: [],
          })),
          interaction_id: "interaction_architecture_decision_engine",
        });
      } catch (error) {
        return executionError(error.code ?? "invalid_architecture_package");
      }
    }
    return result("completed", "completed", null, state.source_refs, {
      kind: "none",
      choices: ["none"],
    }, {
      outcome: "architecture_decisions_reviewed",
      blueprint: state.blueprint,
      decision_results: decisionResults,
      architecture_package: architecturePackage,
    });
  }
  return executionError("unsupported_architecture_state");
}
