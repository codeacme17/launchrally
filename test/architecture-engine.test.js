import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify, stripVTControlCharacters } from "node:util";

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
import { persistLocalHistory, sha256 } from "../packages/core/src/local-history.js";
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
const engine = path.resolve("packages/cli/bin/engine.js");
const pythonAvailable = process.platform !== "win32"
  && spawnSync("python3", ["--version"]).status === 0;
const architectPtyRunner = [
  "import errno, os, pty, subprocess, sys",
  "master, slave = pty.openpty()",
  "child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, close_fds=True)",
  "os.close(slave)",
  "chunks = []",
  "observed = b''",
  "answered_choices = 0",
  "answered_legacy = 0",
  "while True:",
  "    try:",
  "        chunk = os.read(master, 4096)",
  "    except OSError as error:",
  "        if error.errno == errno.EIO:",
  "            break",
  "        raise",
  "    if not chunk:",
  "        break",
  "    chunks.append(chunk)",
  "    observed += chunk",
  "    choice_prompts = observed.count(b'Choose 1-3')",
  "    while choice_prompts > answered_choices:",
  "        os.write(master, b'1\\n')",
  "        answered_choices += 1",
  "    legacy_prompts = observed.count(b'[y/n/cancel]')",
  "    while legacy_prompts > answered_legacy:",
  "        os.write(master, b'y\\n')",
  "        answered_legacy += 1",
  "os.close(master)",
  "sys.stdout.buffer.write(b''.join(chunks))",
  "raise SystemExit(child.wait())",
].join("\n");
const architectSingleDecisionPtyRunner = [
  "import errno, os, pty, subprocess, sys",
  "answer = sys.argv[1].encode() + b'\\n'",
  "master, slave = pty.openpty()",
  "child = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave, close_fds=True)",
  "os.close(slave)",
  "chunks = []",
  "observed = b''",
  "answered = False",
  "while True:",
  "    try:",
  "        chunk = os.read(master, 4096)",
  "    except OSError as error:",
  "        if error.errno == errno.EIO:",
  "            break",
  "        raise",
  "    if not chunk:",
  "        break",
  "    chunks.append(chunk)",
  "    observed += chunk",
  "    if not answered and b'Choose 1-3' in observed:",
  "        os.write(master, answer)",
  "        answered = True",
  "os.close(master)",
  "sys.stdout.buffer.write(b''.join(chunks))",
  "raise SystemExit(child.wait())",
].join("\n");
const architectClackDecisionPtyRunner = [
  "import errno, fcntl, os, pty, struct, subprocess, sys, termios",
  "mode = sys.argv[1]",
  "master, slave = pty.openpty()",
  "fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))",
  "env = os.environ.copy()",
  "env['TERM'] = 'xterm-256color'",
  "child = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave, close_fds=True, env=env)",
  "os.close(slave)",
  "chunks = []",
  "observed = b''",
  "blueprint_answered = False",
  "decision_answered = 0",
  "while True:",
  "    try:",
  "        chunk = os.read(master, 4096)",
  "    except OSError as error:",
  "        if error.errno == errno.EIO:",
  "            break",
  "        raise",
  "    if not chunk:",
  "        break",
  "    chunks.append(chunk)",
  "    observed += chunk",
  "    if not blueprint_answered and b'Confirm this whole-product Blueprint?' in observed:",
  "        os.write(master, b'\\r' if mode == 'blueprint_reject' else b'\\x1b[A\\r')",
  "        blueprint_answered = True",
  "    if blueprint_answered and mode != 'blueprint_reject' and decision_answered == 0 and b'Review decision 1 of 13' in observed:",
  "        os.write(master, b'\\x1b[B\\r' if mode == 'cancel_first' else b'\\r')",
  "        decision_answered = 1",
  "    if mode == 'reject_all':",
  "        while decision_answered < 13:",
  "            next_decision = decision_answered + 1",
  "            if f'Review decision {next_decision} of 13'.encode() not in observed:",
  "                break",
  "            os.write(master, b'\\r')",
  "            decision_answered = next_decision",
  "os.close(master)",
  "sys.stdout.buffer.write(b''.join(chunks))",
  "raise SystemExit(child.wait())",
].join("\n");

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

test("Architect validates required source inputs before previewing P1 adoption", async () => {
  const directory = await initializedP0Fixture();
  const source = await inputs(directory);
  source.integration_contracts = [];

  const result = await runArchitectureJourney(directory, source, {
    review_date: "2026-08-13",
    launcher_version: "0.3.2",
  }, {
    store_state: () => "unexpected-migration-preview",
  });

  assert.equal(result.status, "execution_error", JSON.stringify(result));
  assert.equal(result.error, "missing_integration_contracts");
  assert.equal(result.migration_preview, undefined);
  await assert.rejects(
    readFile(path.join(directory, ".launchrally/phase-1/adoption.json"), "utf8"),
    (error) => error.code === "ENOENT",
  );
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
  const redirectedDirectory = path.join(directory, "redirected-resume");
  const actualDirectory = path.join(directory, "actual-resume");
  await mkdir(actualDirectory);
  await symlink(actualDirectory, redirectedDirectory);
  await assert.rejects(
    codex.saveResumeArtifact(
      path.join(redirectedDirectory, "resume.json"),
      blueprint.interaction,
      directory,
    ),
    (error) => error.code === "unsafe_host_resume_artifact",
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

test("Agent CLI reconstructs a complete Architect Report from local history record.json", async () => {
  const directory = await fixture();
  await mkdir(path.join(directory, ".launchrally"), { recursive: true });
  await writeFile(
    path.join(directory, ".launchrally", ".gitignore"),
    "/reports/\n/evidence/\n/cache/\n/transactions/\n/locks/\n",
  );
  const source = await inputs(directory);
  await persistLocalHistory(directory, source.report_package);
  const inputDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrally-architect-history-"));
  const files = {
    product_intent: "intent.json",
    catalog: "catalog.json",
    capability_graph: "graph.json",
    integration_contracts: "integrations.json",
  };
  for (const [field, name] of Object.entries(files)) {
    await writeFile(path.join(inputDirectory, name), `${JSON.stringify(source[field])}\n`);
  }

  const reportPath = `.launchrally/reports/${source.report_package.report.report_id}/record.json`;
  const { stdout } = await execFileAsync(process.execPath, [
    engine,
    "architect",
    "--json",
    "--cwd",
    directory,
    "--report",
    reportPath,
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
  assert.equal(result.status, "needs_confirmation", JSON.stringify(result));
  assert.equal(result.blueprint.source_report.digest, sha256(source.report_package.report));
});

test("Architect local history fails closed with recovery guidance when tampered or incomplete", async (t) => {
  const setup = async () => {
    const directory = await fixture();
    const source = await inputs(directory);
    await persistLocalHistory(directory, source.report_package);
    const reportDirectory = path.join(
      directory,
      ".launchrally",
      "reports",
      source.report_package.report.report_id,
    );
    return {
      directory,
      reportDirectory,
      reportPath: `.launchrally/reports/${source.report_package.report.report_id}/record.json`,
    };
  };
  const run = async ({ directory, reportPath }) => {
    try {
      await execFileAsync(process.execPath, [
        engine,
        "architect",
        "--json",
        "--cwd",
        directory,
        "--report",
        reportPath,
      ]);
      assert.fail("corrupt local history must fail");
    } catch (error) {
      return JSON.parse(error.stdout);
    }
  };

  await t.test("tampered Record digest", async () => {
    const fixture = await setup();
    await writeFile(path.join(fixture.reportDirectory, "record.sha256"), `sha256:${"0".repeat(64)}\n`);
    const result = await run(fixture);
    assert.equal(result.error, "invalid_local_history_report");
    assert.match(result.message, /digest does not match.*restore history or run full Verify again/iu);
  });

  await t.test("incomplete Report bundle", async () => {
    const fixture = await setup();
    await rm(path.join(fixture.reportDirectory, "view.md"));
    const result = await run(fixture);
    assert.equal(result.error, "invalid_local_history_report");
    assert.match(result.message, /missing, incomplete, or unreadable.*run full Verify again/iu);
  });
});

test("Agent and Human Architect reject invalid sources before migration confirmation", {
  skip: pythonAvailable ? false : "A local Python 3 PTY is required.",
}, async () => {
  const directory = await initializedP0Fixture();
  const source = await inputs(directory);
  source.integration_contracts = [];
  const inputDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrally-architect-ordering-"));
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
  const command = [
    engine,
    "architect",
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
  ];

  await assert.rejects(
    execFileAsync(process.execPath, [...command, "--json"]),
    (error) => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.error, "missing_integration_contracts");
      assert.equal(result.migration_preview, undefined);
      return true;
    },
  );
  await assert.rejects(
    execFileAsync("python3", [
      "-c",
      architectSingleDecisionPtyRunner,
      "1",
      process.execPath,
      ...command,
      "--plain",
    ], { timeout: 30000 }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stdout, /missing_integration_contracts/u);
      assert.doesNotMatch(error.stdout, /Additive Phase 1 Migration Preview/u);
      return true;
    },
  );
  await assert.rejects(
    readFile(path.join(directory, ".launchrally/phase-1/adoption.json"), "utf8"),
    (error) => error.code === "ENOENT",
  );
});

test("TTY Human Architect loads local history record.json and completes Blueprint review", {
  skip: pythonAvailable ? false : "A local Python 3 PTY is required.",
}, async () => {
  const directory = await fixture();
  await mkdir(path.join(directory, ".launchrally"), { recursive: true });
  await writeFile(
    path.join(directory, ".launchrally", ".gitignore"),
    "/reports/\n/evidence/\n/cache/\n/transactions/\n/locks/\n",
  );
  const source = await inputs(directory);
  await persistLocalHistory(directory, source.report_package);
  const inputDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrally-architect-tty-"));
  const files = {
    product_intent: "intent.json",
    catalog: "catalog.json",
    capability_graph: "graph.json",
    integration_contracts: "integrations.json",
  };
  for (const [field, name] of Object.entries(files)) {
    await writeFile(path.join(inputDirectory, name), `${JSON.stringify(source[field])}\n`);
  }

  const { stdout } = await execFileAsync("python3", [
    "-c",
    architectPtyRunner,
    process.execPath,
    engine,
    "architect",
    "--plain",
    "--cwd",
    directory,
    "--report",
    `.launchrally/reports/${source.report_package.report.report_id}/record.json`,
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
  ], { timeout: 30000 });

  assert.match(stdout, /LaunchRally Architect/u);
  assert.match(stdout, /Architecture Blueprint/u);
  assert.match(stdout, /Blueprint Schema: launchrally\.dev\/architecture-blueprint\/v1/u);
  assert.match(stdout, /Hard constraints/u);
  assert.match(stdout, /Integration compatibility/u);
  assert.match(stdout, /Operational burden/u);
  assert.match(stdout, /Cost scenario 1/u);
  assert.match(stdout, /Data flow and residency/u);
  assert.match(stdout, /Failure domains/u);
  assert.match(stdout, /Provider concentration/u);
  assert.match(stdout, /Lock-in and exit/u);
  assert.match(stdout, /Migration cost/u);
  assert.match(stdout, /Decision 1 of 13/u);
  assert.match(stdout, /Rationale/u);
  assert.match(stdout, /Trade-offs/u);
  assert.match(stdout, /Reevaluation triggers/u);
  assert.match(stdout, /1\. Confirm/u);
  assert.match(stdout, /2\. Reject/u);
  assert.match(stdout, /3\. Cancel/u);
  assert.match(stdout, /Architecture Review Complete/u);
  assert.doesNotMatch(stdout, /"schema_version"/u);
  assert.doesNotMatch(stdout, /Resume token:/u);
});

test("default styled Human Architect renders Blueprint rejection and decision reject/cancel outcomes", {
  skip: pythonAvailable ? false : "A local Python 3 PTY is required.",
}, async () => {
  const directory = await fixture();
  const source = await inputs(directory);
  const inputDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrally-architect-clack-"));
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
  const command = [
    process.execPath,
    engine,
    "architect",
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
  ];
  const scenarios = [
    { mode: "blueprint_reject", pattern: /Architecture Review Declined/u },
    { mode: "cancel_first", pattern: /Architecture Review Cancelled/u },
    { mode: "reject_all", pattern: /Architecture Review Complete[\s\S]*Rejected: 13/u },
  ];
  for (const scenario of scenarios) {
    const { stdout } = await execFileAsync("python3", [
      "-c",
      architectClackDecisionPtyRunner,
      scenario.mode,
      ...command,
    ], { timeout: 30000 });
    const semanticOutput = stripVTControlCharacters(stdout);
    assert.match(stdout, /\u001B\[/u);
    assert.match(semanticOutput, /LaunchRally Architect/u);
    assert.match(semanticOutput, /Whole-product Blueprint/u);
    assert.match(semanticOutput, /Confirm[\s\S]*Reject[\s\S]*Cancel/u);
    assert.match(semanticOutput, scenario.pattern);
    assert.doesNotMatch(semanticOutput, /Resume token:/u);
  }
});

test("TTY Human Architect styles migration decline and cancellation without changing P0 history", {
  skip: pythonAvailable ? false : "A local Python 3 PTY is required.",
}, async () => {
  for (const scenario of [
    { answer: "2", summary: /Architecture Review Declined/u },
    { answer: "3", summary: /Architecture Review Cancelled/u },
  ]) {
    const directory = await initializedP0Fixture();
    const source = await inputs(directory);
    const inputDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrally-migration-tty-"));
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

    const { stdout } = await execFileAsync("python3", [
      "-c",
      architectSingleDecisionPtyRunner,
      scenario.answer,
      process.execPath,
      engine,
      "architect",
      "--plain",
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
    ], { timeout: 30000 });

    assert.match(stdout, /Additive Phase 1 Migration Preview/u);
    assert.match(stdout, /Preview Schema: launchrally\.dev\/phase-1-migration-preview\/v1/u);
    assert.match(stdout, /Created paths:/u);
    assert.match(stdout, /\.launchrally\/phase-1\/adoption\.json/u);
    assert.match(stdout, /Preserved Phase 0 paths:/u);
    assert.match(stdout, /\.launchrally\/manifest\.yaml/u);
    assert.match(stdout, /1\. Confirm/u);
    assert.match(stdout, /2\. Decline/u);
    assert.match(stdout, /3\. Cancel/u);
    assert.match(stdout, scenario.summary);
    assert.doesNotMatch(stdout, /"schema_version"/u);
    await assert.rejects(
      readFile(path.join(directory, ".launchrally/phase-1/adoption.json"), "utf8"),
      (error) => error.code === "ENOENT",
    );
  }
});

test("Human Architect reports stale input and file errors without raw JSON", {
  skip: pythonAvailable ? false : "A local Python 3 PTY is required.",
}, async () => {
  const directory = await fixture();
  const source = await inputs(directory);
  const inputDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrally-architect-stale-"));
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
  await writeFile(path.join(directory, "package.json"), `${JSON.stringify({
    name: "architect-web-changed",
    scripts: { build: "vite build" },
  })}\n`);

  await assert.rejects(
    execFileAsync("python3", [
      "-c",
      architectSingleDecisionPtyRunner,
      "1",
      process.execPath,
      engine,
      "architect",
      "--plain",
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
    ], { timeout: 30000 }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stdout, /Architecture Input Is Stale/u);
      assert.doesNotMatch(error.stdout, /"currentness"/u);
      return true;
    },
  );

  const invalid = path.join(inputDirectory, "invalid.json");
  await writeFile(invalid, "not json\n");
  await assert.rejects(
    execFileAsync(process.execPath, [
      engine,
      "architect",
      "--cwd",
      directory,
      "--report",
      invalid,
    ]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stdout, /Architecture Review Could Not Complete/u);
      assert.match(error.stdout, /invalid_architecture_input_file/u);
      assert.doesNotMatch(error.stdout, /"status"/u);
      return true;
    },
  );
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
      async reviewDecision(decision, progress) {
        assert.deepEqual(progress, {
          current: reviewed.length + 1,
          total: 13,
        });
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

test("Human flow can cancel during independent review with a typed partial outcome", async () => {
  const directory = await fixture();
  const source = await inputs(directory);
  const terminal = [];
  const result = await runHumanArchitect({
    cwd: directory,
    source,
    reviewDate: "2026-08-13",
    runArchitect: runArchitectureDecisionEngine,
    prompt: {
      async confirmMigration() {
        assert.fail("pre-Init flow must not request migration");
      },
      async confirmBlueprint() {
        return "confirm";
      },
      async reviewDecision(_decision, { current, total }) {
        return current === 2 && total === 13 ? "cancel" : "confirm";
      },
      async finishArchitect(value) {
        terminal.push(value.status);
      },
    },
  });

  assert.equal(result.status, "cancelled");
  assert.equal(result.outcome, "architecture_decision_review_cancelled");
  assert.deepEqual(result.decision_results, [{
    decision_id: result.blueprint.decisions[0].decision_id,
    response: "confirm",
  }]);
  assert.equal(assertValidArchitectInteraction(result.interaction), true);
  assert.deepEqual(terminal, ["cancelled"]);
});

test("public non-TTY Architect refuses unsafe prompting", async () => {
  const directory = await fixture();
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "architect", "--cwd", directory]),
    (error) => error.code === 2
      && /Non-TTY Human Mode cannot confirm Architecture decisions safely/u.test(error.stderr),
  );
});
