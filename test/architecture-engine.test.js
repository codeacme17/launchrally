import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertValidArchitectInteraction,
  assertValidArchitectureBlueprint,
  assertValidHostResumeArtifact,
  assertValidIntegrationContract,
} from "../packages/contracts/src/index.js";
import {
  buildCapabilityGraph,
  createCapabilityCatalog,
  resolveExecutionAuthority,
  runArchitectureDecisionEngine,
  runArchitectureJourney,
  runAudit,
} from "../packages/core/src/index.js";
import {
  normalizeArchitectAnswer,
  runHumanArchitect,
} from "../packages/cli/bin/human-architect.js";
import {
  materializeExactToolchain,
  writeExactToolchain,
} from "./helpers/exact-toolchain.js";

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

async function initializedP0Fixture() {
  const directory = await fixture();
  const launchrally = path.join(directory, ".launchrally");
  await mkdir(path.join(launchrally, "reports"), { recursive: true });
  await mkdir(path.join(launchrally, "evidence"), { recursive: true });
  const unknown = { state: "unknown", reason: "fixture" };
  await writeFile(path.join(launchrally, "manifest.yaml"), `${JSON.stringify({
    schema_version: "launchrally.dev/manifest/v2",
    project: { name: unknown, type: unknown, package_manager: unknown },
    release: {
      intended_environment: unknown,
      production_targets: unknown,
      core_journeys: unknown,
    },
    execution: {
      source_report_id: unknown,
      assessment: unknown,
      public_verification: unknown,
    },
    support: { layers: unknown },
    providers: { roles: unknown },
  })}\n`);
  await writeFile(path.join(launchrally, "reports", "p0-report.json"), "{\"phase\":\"p0\"}\n");
  await writeFile(path.join(launchrally, "evidence", "p0-evidence.json"), "{\"phase\":\"p0\"}\n");
  await writeExactToolchain(directory);
  await materializeExactToolchain(directory);
  await writeFile(path.join(launchrally, "toolchain", "authority.json"), `${JSON.stringify({
    contract: "launchrally.dev/execution-authority/v1",
    engine: {
      package: "@launchrally/cli",
      version: "0.3.2",
      entrypoint: "bin/engine.js",
    },
  })}\n`);
  return directory;
}

async function snapshotLaunchRally(directory) {
  const root = path.join(directory, ".launchrally");
  const files = [];
  async function walk(current, relative = "") {
    for (const entry of (await readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const selected = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(selected, nextRelative);
      else files.push([nextRelative, await readFile(selected, "utf8")]);
    }
  }
  await walk(root);
  return files;
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

test("first Architect use previews additive P1 adoption and denial preserves P0 bytes", async () => {
  const directory = await initializedP0Fixture();
  const authority = await resolveExecutionAuthority({
    cwd: directory,
    launcher_version: "0.3.2",
  });
  assert.equal(authority.state, "ready", JSON.stringify(authority));
  assert.equal(authority.source, "project_toolchain", JSON.stringify(authority));
  const before = await snapshotLaunchRally(directory);
  const source = await inputs(directory);
  await assert.rejects(readFile(path.join(
    directory,
    ".launchrally/phase-1/adoption.json",
  ), "utf8"), (error) => error.code === "ENOENT");
  const preview = await runArchitectureJourney(directory, source, {
    review_date: "2026-08-13",
    launcher_version: "0.3.2",
  });

  assert.equal(preview.status, "needs_confirmation", JSON.stringify(preview));
  assert.equal(preview.state, "blueprint_review");
  assert.deepEqual(preview.request, {
    kind: "p1_migration_confirmation",
    choices: ["confirm", "deny", "cancel"],
  });
  assert.deepEqual(preview.migration_preview.files, [
    ".launchrally/phase-1/adoption.json",
    ".launchrally/phase-1/records/",
    ".launchrally/phase-1/transactions/",
  ]);
  assert.ok(preview.migration_preview.preserved_paths.includes(".launchrally/manifest.yaml"));
  assert.ok(preview.migration_preview.preserved_paths.includes(".launchrally/reports/"));
  assert.ok(preview.migration_preview.preserved_paths.includes(".launchrally/evidence/"));
  assert.deepEqual(await snapshotLaunchRally(directory), before);

  const denied = await runArchitectureJourney(directory, {}, {
    resume_token: preview.resume_token,
    migration_confirmation: "deny",
    launcher_version: "0.3.2",
  });
  assert.equal(denied.status, "denied");
  assert.equal(denied.outcome, "p1_migration_denied");
  assert.deepEqual(await snapshotLaunchRally(directory), before);
  const auditAfterDenial = await completeAudit(directory);
  assert.equal(auditAfterDenial.status, "completed");
  assert.equal(auditAfterDenial.operation, "audit");
  assert.equal(auditAfterDenial.report.schema_version, "launchrally.dev/report/v2");
});

test("the initialized P0 migration preview resumes cross-host before adoption", async () => {
  const directory = await initializedP0Fixture();
  const source = await inputs(directory);
  const codex = await import("../adapters/codex/launchrally/host-adapter/resume.js");
  const claude = await import("../adapters/claude/launchrally/host-adapter/resume.js");
  const before = await snapshotLaunchRally(directory);
  const preview = await runArchitectureJourney(directory, source, {
    review_date: "2026-08-13",
    launcher_version: "0.3.2",
  });
  const artifactPath = path.join(directory, "migration-resume.json");
  await codex.saveResumeArtifact(artifactPath, preview.interaction, directory);
  assert.deepEqual(await snapshotLaunchRally(directory), before);

  const resumed = await claude.resumeArtifactFile({
    cwd: directory,
    artifact_path: artifactPath,
    options: { migration_confirmation: "deny", launcher_version: "0.3.2" },
  });
  assert.equal(resumed.status, "denied", JSON.stringify(resumed));
  assert.equal(resumed.outcome, "p1_migration_denied");
  assert.deepEqual(await snapshotLaunchRally(directory), before);
});

test("confirmed P1 adoption commits atomically and interruption preserves the P0 project", async () => {
  const interruptedDirectory = await initializedP0Fixture();
  const interruptedSource = await inputs(interruptedDirectory);
  const interruptedBefore = await snapshotLaunchRally(interruptedDirectory);
  const interruptedPreview = await runArchitectureJourney(
    interruptedDirectory,
    interruptedSource,
    { review_date: "2026-08-13", launcher_version: "0.3.2" },
  );
  const interrupted = await runArchitectureJourney(interruptedDirectory, {}, {
    resume_token: interruptedPreview.resume_token,
    migration_confirmation: "confirm",
    launcher_version: "0.3.2",
    file_operations: {
      async before_migration_commit() {
        const error = new Error("simulated interruption");
        error.code = "simulated_migration_interruption";
        throw error;
      },
    },
  });
  assert.equal(interrupted.status, "execution_error", JSON.stringify(interrupted));
  assert.equal(interrupted.error, "simulated_migration_interruption");
  assert.deepEqual(await snapshotLaunchRally(interruptedDirectory), interruptedBefore);

  const directory = await initializedP0Fixture();
  const source = await inputs(directory);
  const before = await snapshotLaunchRally(directory);
  const preview = await runArchitectureJourney(directory, source, {
    review_date: "2026-08-13",
    launcher_version: "0.3.2",
  });
  const confirmed = await runArchitectureJourney(directory, {}, {
    resume_token: preview.resume_token,
    migration_confirmation: "confirm",
    launcher_version: "0.3.2",
  });
  assert.equal(confirmed.status, "needs_confirmation", JSON.stringify(confirmed));
  assert.equal(confirmed.state, "blueprint_review");
  const adoption = JSON.parse(await readFile(path.join(
    directory,
    ".launchrally/phase-1/adoption.json",
  ), "utf8"));
  assert.equal(adoption.schema_version, "launchrally.dev/phase-1-adoption/v1");
  assert.equal(adoption.historical_reports_relabelled, false);
  assert.equal(
    runArchitectureDecisionEngine(directory, source, { review_date: "2026-08-13" }).status,
    "needs_confirmation",
  );
  const after = await snapshotLaunchRally(directory);
  for (const [relative, content] of before) {
    assert.equal(after.find(([candidate]) => candidate === relative)?.[1], content, relative);
  }
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

test("Architecture alternatives cannot bypass Provider Knowledge with a Provider claim", async () => {
  const directory = await fixture();
  const source = await inputs(directory);
  const result = runArchitectureDecisionEngine(directory, {
    ...source,
    alternatives: [{
      implementation_id: "identity_managed_eu",
      provider_id: "unreviewed_identity_provider",
      action: "adopt",
    }],
  }, { review_date: "2026-08-13" });
  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "invalid_architecture_alternatives");
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

test("desktop shared-backend assessment keeps distribution readiness explicitly Unknown", async () => {
  const directory = await fixture();
  const source = await inputs(directory);
  const runtime = source.capability_graph.nodes.find(({ capability_id: id }) =>
    id === "runtime_execution");
  runtime.implementation_state = "present";
  runtime.implementation_path = "existing_platform";
  const result = runArchitectureDecisionEngine(directory, source, {
    review_date: "2026-08-13",
    desktop_shared_backend_capability_ids: ["runtime_execution"],
  });
  assert.equal(result.status, "needs_confirmation", JSON.stringify(result));
  const decision = result.blueprint.decisions.find(({ capability_id: id }) =>
    id === "runtime_execution");
  assert.equal(decision.implementation_path, "existing_platform");
  assert.deepEqual(result.desktop_topology, {
    schema_version: "launchrally.dev/desktop-shared-backend/v1",
    topology: "desktop_with_shared_backend",
    capability_ids: ["runtime_execution"],
    excluded_release_readiness: [
      "signing",
      "notarization",
      "store_review",
      "distribution",
      "updater",
    ],
  });
  assert.match(decision.tradeoffs.join(" "), /signing.*notarization.*store review.*distribution.*updater/iu);
  assert.deepEqual(result.blueprint.unknowns.filter((value) =>
    value.startsWith("desktop_")), [
    "desktop_distribution_not_assessed",
    "desktop_notarization_not_assessed",
    "desktop_signing_not_assessed",
    "desktop_store_review_not_assessed",
    "desktop_updater_readiness_not_assessed",
  ]);
  assert.equal(runArchitectureDecisionEngine(directory, source, {
    review_date: "2026-08-13",
    desktop_shared_backend_capability_ids: ["runtime_execution", "runtime_execution"],
  }).error, "invalid_desktop_shared_backend_scope");
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
  assert.equal(completed.status, "completed", JSON.stringify(completed));
  assert.equal(assertValidArchitectInteraction(completed.interaction), true);
  assert.equal(completed.decision_results.length, review.pending_decision_ids.length);
  assert.equal(completed.architecture_package.package.currentness.state, "current");
  assert.equal(
    completed.architecture_package.architecture_record.confirmed_decisions.length,
    review.pending_decision_ids.length - 1,
  );
});

test("Codex Architecture state resumes in Claude from one validated local artifact", async () => {
  const directory = await fixture();
  const source = await inputs(directory);
  const codex = await import("../adapters/codex/launchrally/host-adapter/resume.js");
  const claude = await import("../adapters/claude/launchrally/host-adapter/resume.js");
  const blueprint = runArchitectureDecisionEngine(directory, source, {
    review_date: "2026-08-13",
  });
  const artifactPath = path.join(directory, "architecture-resume.json");
  const artifact = await codex.saveResumeArtifact(artifactPath, blueprint.interaction, directory);
  assert.equal(assertValidHostResumeArtifact(artifact), true);
  assert.equal(artifact.resume_token.startsWith("lrarchitect_"), true);
  assert.equal(artifact.resume_token.includes("whole_product"), false);
  assert.equal(artifact.resume_token.includes("rationale"), false);
  await assert.rejects(
    readdir(path.join(directory, ".launchrally")),
    (error) => error.code === "ENOENT",
  );
  await assert.rejects(
    readFile(`${artifactPath}.key`),
    (error) => error.code === "ENOENT",
  );

  const resumed = await claude.resumeArtifactFile({
    cwd: directory,
    artifact_path: artifactPath,
    options: { blueprint_confirmation: "confirm" },
  });
  assert.equal(resumed.status, "partial_completion", JSON.stringify(resumed));
  assert.equal(resumed.state, "decision_confirmation");
  assert.notEqual(resumed.resume_token, blueprint.resume_token);
  const tamperedTokenArtifact = {
    ...artifact,
    resume_token: `${blueprint.resume_token}tampered`,
  };
  await assert.rejects(
    claude.resumeArtifact({
      cwd: directory,
      artifact: tamperedTokenArtifact,
      options: { blueprint_confirmation: "confirm" },
    }),
    (error) => error.code === "invalid_host_resume_artifact",
  );
  await assert.rejects(
    codex.saveResumeArtifact(artifactPath, blueprint.interaction, directory),
    (error) => error.code === "host_resume_artifact_exists",
  );
  await assert.rejects(
    claude.resumeArtifact({
      cwd: directory,
      artifact: { ...artifact, state: "completed" },
      options: { blueprint_confirmation: "confirm" },
    }),
    (error) => error.code === "invalid_host_resume_artifact",
  );
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
    desktopSharedBackendCapabilityIds: ["runtime_execution"],
    runArchitect: runArchitectureDecisionEngine,
    prompt: {
      async confirmMigration() {
        assert.fail("pre-Init flow must not request migration");
      },
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
  assert.deepEqual(result.desktop_topology.capability_ids, ["runtime_execution"]);
  assert.deepEqual(
    result.architecture_package.desktop_topology,
    result.desktop_topology,
  );
  assert.deepEqual(reviewed, result.blueprint.decisions.map(({ decision_id: id }) => id));
  assert.equal(result.decision_results[1].response, "reject");
  assert.deepEqual(result.human_mode, {
    typed_interactions: true,
    external_agent_automation: false,
    cross_host_resume: false,
    unavailable_capabilities: [
      "external_executor_automation",
      "cross_host_agent_resume",
    ],
  });
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
