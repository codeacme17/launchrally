import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertValidArchitectInteraction,
  assertValidArchitectureBlueprint,
  assertValidIntegrationContract,
} from "../packages/contracts/src/index.js";
import {
  buildCapabilityGraph,
  createCapabilityCatalog,
  runArchitectureDecisionEngine,
  runAudit,
} from "../packages/core/src/index.js";
import {
  normalizeArchitectAnswer,
  runHumanArchitect,
} from "../packages/cli/bin/human-architect.js";

const execFileAsync = promisify(execFile);
const cli = path.resolve("packages/cli/bin/rally.js");

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-architect-"));
  await writeFile(path.join(directory, "package.json"), `${JSON.stringify({
    name: "architect-web",
    scripts: { build: "vite build" },
  }, null, 2)}\n`);
  return directory;
}

async function completeAudit(directory) {
  const initial = await runAudit(directory, "0.1.0");
  const confirmation = await runAudit(directory, "0.1.0", {
    resume_token: initial.interaction.resume_token,
    answers: {
      intended_environment: "production",
      production_targets: ["https://example.com"],
      core_journeys: ["homepage loads"],
      provider_roles: [],
      support_layers: [],
    },
  });
  const permission = await runAudit(directory, "0.1.0", {
    resume_token: confirmation.interaction.resume_token,
    confirmation: "confirm",
  });
  return runAudit(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });
}

function productIntent() {
  return {
    schema_version: "launchrally.dev/product-intent-profile/v1",
    profile_id: "intent_architect_01",
    revision: 1,
    environment: "production",
    created_at: "2026-08-13T00:00:00.000Z",
    desired_intent: {
      confirmation: "confirmed",
      behaviors: ["customers_sign_in"],
      hard_constraints: ["data_residency_eu"],
      preferences: ["managed_operations"],
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
}

async function inputs(directory) {
  const report_package = await completeAudit(directory);
  const product_intent = productIntent();
  const catalog = createCapabilityCatalog({ reviewed_at: "2026-08-13T00:00:00.000Z" });
  const capability_graph = buildCapabilityGraph(product_intent, catalog, {
    graph_id: "graph_architect_01",
  });
  const integration_contracts = [{
    schema_version: "launchrally.dev/integration-contract/v1",
    contract_id: "integration_identity_data",
    contract_version: "1.0.0",
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
      idempotency: "required",
      eventual_consistency: "expected",
      failure_visibility: "operator_visible",
      privacy: "normalized_identifiers_only",
      success_evidence: ["state_transition_observed"],
      invalidation_dependencies: ["identity_event_shape"],
    },
  }];
  assert.equal(assertValidIntegrationContract(integration_contracts[0]), true);
  return { report_package, product_intent, catalog, capability_graph, integration_contracts };
}

test("Architect requires a current full Report and produces the whole Blueprint first", async () => {
  const directory = await fixture();
  const source = await inputs(directory);
  const result = runArchitectureDecisionEngine(directory, source, {
    review_date: "2026-08-13",
  });
  assert.equal(result.status, "needs_confirmation", JSON.stringify(result));
  assert.equal(result.state, "blueprint_review");
  assert.equal(assertValidArchitectInteraction(result.interaction), true);
  assert.equal(assertValidArchitectureBlueprint(result.blueprint), true);
  assert.deepEqual(result.blueprint.constraints, {
    hard: ["data_residency_eu"],
    preferences: ["managed_operations"],
  });
  assert.equal(result.blueprint.decisions.length, 13);
  assert.ok(result.blueprint.decisions.every(({ action }) => action !== "replace"));
  assert.equal(result.blueprint.whole_product.cost_scenarios[0].currency_estimate, null);
  assert.ok(result.blueprint.whole_product.cost_scenarios[0].unknowns.length > 0);
  assert.match(
    result.blueprint.whole_product.integration_compatibility,
    /asynchronous;authentication=signed_or_equivalent.*idempotency=required/u,
  );

  await writeFile(path.join(directory, "package.json"), `${JSON.stringify({
    name: "architect-web-changed",
    scripts: { build: "vite build" },
  }, null, 2)}\n`);
  assert.equal(
    runArchitectureDecisionEngine(directory, source).status,
    "stale_input",
  );
});

test("hard-constraint violations are excluded and never recommended", async () => {
  const directory = await fixture();
  const source = await inputs(directory);
  const result = runArchitectureDecisionEngine(directory, {
    ...source,
    alternatives: [{
      implementation_id: "identity_managed_us",
      action: "adopt",
    }],
  }, { review_date: "2026-08-13" });
  const alternative = result.blueprint.decisions.find(({ decision_id: id }) =>
    id === "decision_identity_managed_us_adopt");
  assert.equal(alternative.disposition, "excluded");
  assert.notEqual(alternative.disposition, "recommended");

  const unknownIntent = productIntent();
  unknownIntent.desired_intent.hard_constraints = ["self_hosting_required"];
  const unknownGraph = buildCapabilityGraph(unknownIntent, source.catalog, {
    graph_id: "graph_architect_unknown_fit",
  });
  const unknownResult = runArchitectureDecisionEngine(directory, {
    ...source,
    product_intent: unknownIntent,
    capability_graph: unknownGraph,
    alternatives: [{
      implementation_id: "identity_managed_eu",
      action: "adopt",
    }],
  }, { review_date: "2026-08-13" });
  assert.equal(unknownResult.blueprint.decisions.find(({ decision_id: id }) =>
    id === "decision_identity_managed_eu_adopt").disposition, "excluded");
});

test("Architecture alternatives cover every decision action with replacement rationale", async () => {
  const directory = await fixture();
  const source = await inputs(directory);
  const actions = ["adopt", "replace", "defer", "undecided"];
  const result = runArchitectureDecisionEngine(directory, {
    ...source,
    alternatives: actions.map((action) => ({
      implementation_id: "identity_managed_eu",
      action,
      ...(action === "replace" ? {
        replacement_reason: "confirmed_operational_mismatch",
      } : {}),
    })),
  }, { review_date: "2026-08-13" });
  assert.deepEqual(
    result.blueprint.decisions.slice(-4).map(({ action }) => action).sort(),
    [...actions].sort(),
  );
  assert.ok(result.blueprint.decisions.slice(-4).every(({ disposition }) =>
    disposition === "alternative"));

  const absent = structuredClone(source.capability_graph);
  absent.nodes.find(({ capability_id: id }) =>
    id === "identity_authentication").implementation_state = "absent";
  const recommended = runArchitectureDecisionEngine(directory, {
    ...source,
    capability_graph: absent,
    alternatives: [{
      implementation_id: "identity_managed_eu",
      action: "adopt",
    }],
  }, { review_date: "2026-08-13" });
  assert.equal(recommended.blueprint.decisions.at(-1).disposition, "recommended");
  assert.deepEqual(recommended.blueprint.whole_product.operational_burden, [
    "managed_operations",
  ]);
  assert.deepEqual(recommended.blueprint.whole_product.failure_domains, [
    "external_identity_service",
  ]);
  assert.match(recommended.blueprint.whole_product.provider_concentration, /identity_provider:1/u);
  assert.deepEqual(recommended.blueprint.whole_product.data_flow_residency, [
    "data_residency_eu_confirmed",
  ]);

  const duplicate = runArchitectureDecisionEngine(directory, {
    ...source,
    alternatives: [0, 1].map(() => ({
      implementation_id: "identity_managed_eu",
      action: "adopt",
    })),
  }, { review_date: "2026-08-13" });
  assert.equal(duplicate.status, "execution_error");
});

test("preferences deterministically choose among compatible implementations", async () => {
  const directory = await fixture();
  const source = await inputs(directory);
  const portableIntent = productIntent();
  portableIntent.desired_intent.hard_constraints = [];
  portableIntent.desired_intent.preferences = ["provider_portability"];
  const graph = buildCapabilityGraph(portableIntent, source.catalog, {
    graph_id: "graph_architect_preference",
  });
  graph.nodes.find(({ capability_id: id }) =>
    id === "identity_authentication").implementation_state = "absent";
  const proposal = (implementationId) => ({
    implementation_id: implementationId,
    action: "adopt",
  });
  for (const alternatives of [
    [proposal("identity_managed_eu"), proposal("identity_self_hosted")],
    [proposal("identity_self_hosted"), proposal("identity_managed_eu")],
  ]) {
    const result = runArchitectureDecisionEngine(directory, {
      ...source,
      product_intent: portableIntent,
      capability_graph: graph,
      alternatives,
    }, { review_date: "2026-08-13" });
    assert.equal(
      result.blueprint.decisions.find(({ disposition, action }) =>
        disposition === "recommended" && action === "adopt")?.decision_id,
      "decision_identity_self_hosted_adopt",
    );
  }
});

test("Integration compatibility derives incompatible and unknown conclusions", async () => {
  const directory = await fixture();
  const source = await inputs(directory);
  const incompatible = structuredClone(source.integration_contracts[0]);
  incompatible.contract_id = "integration_identity_data_unsafe";
  incompatible.provider_binding = { kind: "known", provider_id: "reviewed_provider" };
  incompatible.semantics.idempotency = "best_effort";
  const result = runArchitectureDecisionEngine(directory, {
    ...source,
    integration_contracts: [source.integration_contracts[0], incompatible],
  }, { review_date: "2026-08-13" });
  assert.match(result.blueprint.whole_product.integration_compatibility, /incompatible=1/u);
  assert.match(
    result.blueprint.whole_product.integration_compatibility,
    /duplicate_delivery_without_required_idempotency/u,
  );
  assert.match(result.blueprint.whole_product.integration_compatibility, /unknown=1/u);
});

test("each Blueprint decision can be accepted or rejected independently", async () => {
  const directory = await fixture();
  const source = await inputs(directory);
  const blueprint = runArchitectureDecisionEngine(directory, source, {
    review_date: "2026-08-13",
  });
  const review = runArchitectureDecisionEngine(directory, {}, {
    resume_token: blueprint.resume_token,
    blueprint_confirmation: "confirm",
  });
  assert.equal(review.status, "partial_completion");
  assert.equal(review.state, "decision_confirmation");

  const [first, second] = review.pending_decision_ids;
  const partial = runArchitectureDecisionEngine(directory, {}, {
    resume_token: review.resume_token,
    decision_responses: {
      [first]: "confirm",
      [second]: "reject",
    },
  });
  assert.equal(partial.status, "partial_completion");
  assert.deepEqual(partial.decision_results.slice(0, 2), [
    { decision_id: first, response: "confirm" },
    { decision_id: second, response: "reject" },
  ]);

  const remaining = Object.fromEntries(partial.pending_decision_ids.map((id) => [id, "confirm"]));
  const completed = runArchitectureDecisionEngine(directory, {}, {
    resume_token: partial.resume_token,
    decision_responses: remaining,
  });
  assert.equal(completed.status, "completed");
  assert.equal(assertValidArchitectInteraction(completed.interaction), true);
  assert.equal(completed.decision_results.length, review.pending_decision_ids.length);
});

test("Agent CLI exposes the same typed Architecture decision semantics", async () => {
  const directory = await fixture();
  const source = await inputs(directory);
  const inputDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrally-architect-input-"));
  const files = {
    report_package: "report.json",
    product_intent: "intent.json",
    catalog: "catalog.json",
    capability_graph: "graph.json",
    integration_contracts: "integrations.json",
  };
  for (const [field, name] of Object.entries(files)) {
    await writeFile(path.join(inputDirectory, name), `${JSON.stringify(source[field])}\n`);
  }
  const { stdout } = await execFileAsync(process.execPath, [
    cli,
    "architect",
    "--json",
    "--cwd",
    directory,
    "--report",
    path.join(inputDirectory, files.report_package),
    "--intent",
    path.join(inputDirectory, files.product_intent),
    "--catalog",
    path.join(inputDirectory, files.catalog),
    "--graph",
    path.join(inputDirectory, files.capability_graph),
    "--integrations",
    path.join(inputDirectory, files.integration_contracts),
    "--review-date",
    "2026-08-13",
  ]);
  const result = JSON.parse(stdout);
  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.interaction.state, "blueprint_review");
  assert.equal(assertValidArchitectInteraction(result.interaction), true);
});

test("Human flow reviews the same Blueprint and every decision independently", async () => {
  const directory = await fixture();
  const source = await inputs(directory);
  const reviewed = [];
  const result = await runHumanArchitect({
    cwd: directory,
    source,
    reviewDate: "2026-08-13",
    runArchitect: runArchitectureDecisionEngine,
    prompt: {
      async confirmBlueprint(blueprint) {
        assert.equal(assertValidArchitectureBlueprint(blueprint), true);
        return "confirm";
      },
      async reviewDecision(decision) {
        reviewed.push(decision.decision_id);
        return reviewed.length === 2 ? "reject" : "confirm";
      },
    },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(reviewed, result.blueprint.decisions.map(({ decision_id: id }) => id));
  assert.equal(result.decision_results[1].response, "reject");
  assert.equal(normalizeArchitectAnswer(" YES "), "confirm");
  assert.equal(normalizeArchitectAnswer("n"), "reject");
  assert.equal(normalizeArchitectAnswer("cancel"), "cancel");
  assert.equal(normalizeArchitectAnswer("maybe"), null);
});

test("public non-TTY Architect refuses unsafe prompting", async () => {
  const directory = await fixture();
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "architect", "--cwd", directory]),
    (error) => error.code === 2
      && /Non-TTY Human Mode cannot confirm Architecture decisions safely/u.test(error.stderr),
  );
});
