import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertValidTaskGraph,
  computeExecutorDescriptorDigest,
  computeTaskGraphReadyFrontier,
} from "../packages/contracts/src/index.js";
import {
  EXECUTION_AUTHORITY_DESCRIPTOR_PATH,
  evaluateArchitecturePackageCurrentness,
  generateTaskGraph,
  loadLocalHistoryReportPackage,
  mapTaskGraphExecutors,
  persistArchitecturePackage,
  runArchitectureDecisionEngine,
  runAudit,
  runPlan,
  runVerify,
} from "../packages/core/src/index.js";
import { sha256 } from "../packages/core/src/local-history.js";
import {
  materializeExactToolchain,
  writeExactToolchain,
} from "./helpers/exact-toolchain.js";

const architectureFixture = JSON.parse(await readFile(
  new URL("./fixtures/phase-1-contracts/architecture.valid.json", import.meta.url),
  "utf8",
));
const capabilityFixture = JSON.parse(await readFile(
  new URL("./fixtures/phase-1-contracts/capability-model.valid.json", import.meta.url),
  "utf8",
));
const handoffFixture = JSON.parse(await readFile(
  new URL("./fixtures/phase-1-contracts/handoff.valid.json", import.meta.url),
  "utf8",
));
const intentFixture = JSON.parse(await readFile(
  new URL("./fixtures/phase-1-contracts/product-intent-profile.valid.json", import.meta.url),
  "utf8",
));
const execFileAsync = promisify(execFile);
const engine = path.resolve("packages/cli/bin/engine.js");

const ANSWERS = Object.freeze({
  intended_environment: "production",
  production_targets: ["https://task-graph.invalid/"],
  core_journeys: ["homepage loads"],
  provider_roles: [],
  support_layers: [],
});

async function completeAudit() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-task-graph-"));
  await writeFile(path.join(directory, "package.json"), JSON.stringify({
    name: "task-graph-web",
    scripts: {},
  }));
  return { directory, reportPackage: await auditDirectory(directory) };
}

async function auditDirectory(directory) {
  const initial = await runAudit(directory, "0.3.2");
  const confirmation = await runAudit(directory, "0.3.2", {
    resume_token: initial.interaction.resume_token,
    answers: ANSWERS,
  });
  const permission = await runAudit(directory, "0.3.2", {
    resume_token: confirmation.interaction.resume_token,
    confirmation: "confirm",
  });
  return runAudit(directory, "0.3.2", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });
}

function reportReference(report) {
  return {
    id: `report_${sha256(report).slice(7, 27)}`,
    schema_version: report.schema_version,
    digest: sha256(report),
  };
}

function architectureBundle(reportPackage, overrides = {}) {
  const architectureRecord = structuredClone(architectureFixture.record);
  architectureRecord.environment = "production";
  architectureRecord.bindings.source_report = reportReference(reportPackage.report);
  architectureRecord.confirmed_decisions = [
    {
      decision_id: "decision_identity",
      decision_revision: 1,
      capability_id: "identity_authentication",
      implementation_path: "unknown",
      confirmation: "explicit_user_confirmation",
      status: "investigate",
    },
    {
      decision_id: "decision_web_delivery",
      decision_revision: 1,
      capability_id: "managed_web_delivery",
      implementation_path: "application_native",
      confirmation: "explicit_user_confirmation",
      status: "adopt",
    },
  ];
  const capabilityGraph = structuredClone(capabilityFixture.graph);
  capabilityGraph.nodes.push({
    capability_id: "managed_web_delivery",
    environment: "production",
    release_scope: "current_release",
    requirement_state: "required",
    decision_state: "adopt",
    implementation_state: "absent",
    evidence_state: "unverified",
    implementation_path: "application_native",
  });
  capabilityGraph.edges.push({
    from: "identity_authentication",
    to: "managed_web_delivery",
    kind: "requires",
  });
  const architecturePackage = structuredClone(architectureFixture.package);
  architecturePackage.environment = "production";
  architecturePackage.records.architecture_record = {
    id: architectureRecord.record_id,
    schema_version: architectureRecord.schema_version,
    digest: sha256(architectureRecord),
  };
  architecturePackage.records.capability_graph = {
    id: capabilityGraph.graph_id,
    schema_version: capabilityGraph.schema_version,
    digest: sha256(capabilityGraph),
  };
  Object.assign(architecturePackage, overrides);
  return {
    package: architecturePackage,
    architecture_record: architectureRecord,
    capability_graph: capabilityGraph,
  };
}

function architectureInputs(reportPackage) {
  const productIntent = structuredClone(intentFixture);
  const capabilityGraph = structuredClone(capabilityFixture.graph);
  capabilityGraph.product_intent = {
    id: productIntent.profile_id,
    schema_version: productIntent.schema_version,
    digest: sha256(productIntent),
  };
  capabilityGraph.nodes.push({
    capability_id: "application_data",
    environment: "production",
    release_scope: "current_release",
    requirement_state: "required",
    decision_state: "investigate",
    implementation_state: "unknown",
    evidence_state: "unverified",
    implementation_path: "unknown",
  });
  return {
    report_package: reportPackage,
    product_intent: productIntent,
    catalog: structuredClone(capabilityFixture.catalog),
    capability_graph: capabilityGraph,
    integration_contracts: [structuredClone(capabilityFixture.integration)],
    provider_knowledge_refs: [],
  };
}

async function loadPersistedArchitecture(directory, architecture) {
  const packageRoot = path.join(
    directory,
    ".launchrally",
    "architecture",
    "packages",
    architecture.package.package_id,
  );
  const intentPath = path.join(
    directory,
    ".launchrally",
    "architecture",
    "shareable-intent",
    "sha256",
    `${sha256(architecture.product_intent).slice(7)}.json`,
  );
  const readJson = async (selectedPath) => JSON.parse(await readFile(selectedPath, "utf8"));
  const [
    architecturePackage,
    architectureRecord,
    capabilityGraph,
    dependencyIndex,
    productIntent,
  ] = await Promise.all([
    readJson(path.join(packageRoot, "package.json")),
    readJson(path.join(packageRoot, "architecture-record.json")),
    readJson(path.join(packageRoot, "capability-graph.json")),
    readJson(path.join(packageRoot, "dependency-index.json")),
    readJson(intentPath),
  ]);
  return {
    package: architecturePackage,
    architecture_record: architectureRecord,
    capability_graph: capabilityGraph,
    dependency_index: dependencyIndex,
    product_intent: productIntent,
    task_graph: null,
    previous_package: architecture.previous_package,
  };
}

async function initializeProjectToolchain(directory) {
  const launchrally = path.join(directory, ".launchrally");
  await mkdir(launchrally, { recursive: true });
  await writeFile(
    path.join(launchrally, ".gitignore"),
    "/reports/\n/evidence/\n/cache/\n/transactions/\n/locks/\n",
  );
  await writeExactToolchain(directory);
  await materializeExactToolchain(directory);
  await writeFile(
    path.join(directory, EXECUTION_AUTHORITY_DESCRIPTOR_PATH),
    `${JSON.stringify({
      contract: "launchrally.dev/execution-authority/v1",
      engine: {
        package: "@launchrally/cli",
        version: "0.3.2",
        entrypoint: "bin/engine.js",
      },
    })}\n`,
  );
}

async function writeManifest(directory, source) {
  const intent = source.report.scope.release_intent;
  const declared = (value) => ({ state: "declared", value: structuredClone(value) });
  await writeFile(
    path.join(directory, ".launchrally", "manifest.yaml"),
    `${JSON.stringify({
      schema_version: "launchrally.dev/manifest/v2",
      project: {
        name: declared(source.report.scope.project.name),
        type: declared(source.report.scope.project.type),
        package_manager: declared(source.report.scope.project.package_manager),
      },
      release: {
        intended_environment: declared(intent.intended_environment),
        production_targets: declared(intent.production_targets),
        core_journeys: declared(intent.core_journeys),
      },
      execution: {
        source_report_id: declared(source.report.report_id),
        assessment: declared(source.report.assessment),
        public_verification: declared(source.report.scope.public_verification),
      },
      support: { layers: declared(intent.support_layers) },
      providers: { roles: declared(intent.provider_roles) },
    }, null, 2)}\n`,
  );
}

function implementationOnlyArchitecture(reportPackage) {
  const bundle = architectureBundle(reportPackage);
  bundle.architecture_record.confirmed_decisions = bundle.architecture_record.confirmed_decisions
    .filter(({ decision_id: id }) => id === "decision_web_delivery");
  bundle.architecture_record.confirmed_decisions[0].capability_id = "ci_cd";
  bundle.capability_graph.edges = bundle.capability_graph.edges
    .filter(({ to }) => to !== "managed_web_delivery");
  bundle.package.records.architecture_record.digest = sha256(bundle.architecture_record);
  bundle.package.records.capability_graph.digest = sha256(bundle.capability_graph);
  return bundle;
}

function generateGraph(reportPackage, architecture, options = {}) {
  return generateTaskGraph(reportPackage, architecture, {
    cwd: reportPackage.report.scope.project_root,
    ...options,
  });
}

test("current Findings and Architecture Decisions produce one deterministic source-preserving Task Graph", async () => {
  const { reportPackage } = await completeAudit();
  const architecture = architectureBundle(reportPackage);

  const first = generateGraph(reportPackage, architecture);
  const second = generateGraph(reportPackage, architecture);

  assert.equal(assertValidTaskGraph(first), true);
  assert.deepEqual(second, first);
  assert.deepEqual(
    [...new Set(first.tasks.map(({ source }) => source))].sort(),
    ["architecture_decision", "finding", "implementation_work", "verification_gap"],
  );
  assert.ok(first.tasks.every(({ expected_target }) =>
    !/cloudflare|vercel|aws|gcp|azure/iu.test(expected_target)));
  const investigation = first.tasks.find(({ source_id }) => source_id === "decision_identity");
  const implementation = first.tasks.find(
    ({ source_id }) => source_id === "decision_web_delivery",
  );
  assert.equal(investigation.effect_class, "read_only");
  assert.equal(implementation.effect_class, "local_source");
  assert.deepEqual(implementation.prerequisites, [
    investigation.task_id,
    ...first.tasks.filter(({ source }) => source === "finding").map(({ task_id: id }) => id),
  ].sort());
  assert.equal(implementation.status, "blocked");
  assert.equal(first.ready_frontier.includes(implementation.task_id), false);
});

test("rally plan adds a Task Graph only when a current Architecture Package is supplied", async () => {
  const { directory, reportPackage } = await completeAudit();
  const legacy = runPlan(reportPackage, { cwd: directory });
  const architectureAware = runPlan(reportPackage, {
    cwd: directory,
    architecture_bundle: architectureBundle(reportPackage),
  });

  assert.equal(Object.hasOwn(legacy, "task_graph"), false);
  assert.equal(architectureAware.schema_version, legacy.schema_version);
  assert.equal(assertValidTaskGraph(architectureAware.task_graph), true);
  assert.deepEqual(architectureAware.items, legacy.items);
  assert.deepEqual(architectureAware.verification_gaps, legacy.verification_gaps);
  assert.throws(
    () => runPlan(reportPackage, {
      cwd: directory,
      task_updates: [{ task_id: "task_missing", status: "cancelled" }],
    }),
    (error) => error.code === "task_graph_architecture_required",
  );
});

test("persisted Architecture history leaves the full Verify Report current for Task Graph planning", async () => {
  const { directory } = await completeAudit();
  await initializeProjectToolchain(directory);
  const source = await auditDirectory(directory);
  await writeManifest(directory, source);
  const permission = await runVerify(directory, "0.3.2", {
    report_package: source,
    scope: "full",
  });
  const verification = await runVerify(directory, "0.3.2", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });
  const blueprintReview = runArchitectureDecisionEngine(
    directory,
    architectureInputs(verification),
    { review_date: "2026-08-22" },
  );
  assert.equal(blueprintReview.status, "needs_confirmation", JSON.stringify(blueprintReview));
  const decisionReview = runArchitectureDecisionEngine(directory, {}, {
    resume_token: blueprintReview.interaction.resume_token,
    blueprint_confirmation: "confirm",
  });
  const architect = runArchitectureDecisionEngine(directory, {}, {
    resume_token: decisionReview.interaction.resume_token,
    decision_responses: Object.fromEntries(
      decisionReview.pending_decision_ids.map((decisionId) => [decisionId, "confirm"]),
    ),
  });
  const architecture = architect.architecture_package;
  const preview = await persistArchitecturePackage(directory, architecture, {
    launcher_version: "0.3.2",
  });
  const persisted = await persistArchitecturePackage(directory, architecture, {
    launcher_version: "0.3.2",
    confirmation: "confirm",
    resume_token: preview.resume_token,
  });
  const persistedArchitecture = await loadPersistedArchitecture(directory, architecture);
  const reportPath = `.launchrally/reports/${verification.report.report_id}/record.json`;
  const localHistoryReport = await loadLocalHistoryReportPackage(directory, reportPath);

  const plan = runPlan(localHistoryReport, {
    cwd: directory,
    architecture_bundle: persistedArchitecture,
  });
  const dependencyCurrentness = evaluateArchitecturePackageCurrentness(
    persistedArchitecture,
    { changed_dependency_ids: [persistedArchitecture.dependency_index.edges[0].source_id] },
  );
  const staleArchitecture = structuredClone(persistedArchitecture);
  staleArchitecture.package.currentness = {
    state: dependencyCurrentness.state,
    invalidated_record_ids: dependencyCurrentness.invalidated_record_ids,
    reasons: dependencyCurrentness.reasons,
  };
  const staleArchitecturePlan = runPlan(localHistoryReport, {
    cwd: directory,
    architecture_bundle: staleArchitecture,
  });

  assert.equal(persisted.status, "completed");
  assert.equal(architect.status, "completed");
  assert.deepEqual(persistedArchitecture.package, architecture.package);
  assert.deepEqual(persistedArchitecture.architecture_record, architecture.architecture_record);
  assert.deepEqual(persistedArchitecture.capability_graph, architecture.capability_graph);
  assert.equal(plan.status, "completed", JSON.stringify(plan, null, 2));
  assert.equal(plan.source_report_id, verification.report.report_id);
  assert.equal(plan.task_graph.currentness.state, "current");
  assert.equal(assertValidTaskGraph(plan.task_graph), true);
  assert.equal(dependencyCurrentness.state, "partially_invalidated");
  assert.equal(staleArchitecturePlan.status, "completed");
  assert.equal(staleArchitecturePlan.task_graph.currentness.state, "stale");
  assert.deepEqual(staleArchitecturePlan.task_graph.ready_frontier, []);
});

test("the Agent CLI reads an immutable Architecture Package and returns the typed Task Graph", async () => {
  const { directory, reportPackage } = await completeAudit();
  const saved = await mkdtemp(path.join(os.tmpdir(), "launchrally-task-graph-inputs-"));
  const reportPath = path.join(saved, "report.json");
  const architecturePath = path.join(saved, "architecture.json");
  await writeFile(reportPath, JSON.stringify(reportPackage));
  await writeFile(architecturePath, JSON.stringify(architectureBundle(reportPackage)));

  const result = JSON.parse((await execFileAsync(process.execPath, [
    engine,
    "plan",
    "--json",
    "--cwd",
    directory,
    "--report",
    reportPath,
    "--architecture-package",
    architecturePath,
  ])).stdout);

  assert.equal(result.status, "completed");
  assert.equal(assertValidTaskGraph(result.task_graph), true);
  assert.ok(result.task_graph.ready_frontier.length > 0);

  const graphPath = path.join(saved, "task-graph.json");
  await writeFile(graphPath, JSON.stringify(result.task_graph));
  const investigation = result.task_graph.tasks.find(
    ({ source_id }) => source_id === "decision_identity",
  );
  const recomputed = JSON.parse((await execFileAsync(process.execPath, [
    engine,
    "plan",
    "--json",
    "--cwd",
    directory,
    "--report",
    reportPath,
    "--architecture-package",
    architecturePath,
    "--task-graph",
    graphPath,
    "--task-updates",
    JSON.stringify([{ task_id: investigation.task_id, status: "cancelled" }]),
  ])).stdout);
  assert.equal(recomputed.task_graph.revision, 2);
  assert.equal(recomputed.task_graph.tasks.find(
    ({ task_id }) => task_id === investigation.task_id,
  ).status, "cancelled");
});

test("reported success, cancellation, verification, and stale inputs recompute only a safe frontier", async () => {
  const { directory, reportPackage } = await completeAudit();
  const architecture = architectureBundle(reportPackage);
  const initial = generateGraph(reportPackage, architecture);
  const investigation = initial.tasks.find(({ source_id }) => source_id === "decision_identity");
  const implementation = initial.tasks.find(({ source_id }) => source_id === "decision_web_delivery");

  const reported = generateGraph(reportPackage, architecture, {
    previous_graph: initial,
    task_updates: [{ task_id: investigation.task_id, status: "reported_succeeded" }],
  });
  assert.equal(reported.tasks.find(({ task_id }) => task_id === implementation.task_id).status, "blocked");
  assert.equal(reported.ready_frontier.includes(implementation.task_id), false);
  assert.throws(
    () => generateGraph(reportPackage, architecture, {
      previous_graph: initial,
      task_updates: [{ task_id: investigation.task_id, status: "verified" }],
    }),
    (error) => error.code === "invalid_task_graph_update",
  );

  await writeFile(path.join(directory, "package.json"), JSON.stringify({
    name: "task-graph-web",
    scripts: { build: "vite build" },
  }));
  await writeFile(path.join(directory, "package-lock.json"), JSON.stringify({
    name: "task-graph-web",
    lockfileVersion: 3,
  }));
  const verifiedReport = await auditDirectory(directory);
  const incompleteManaged = generateGraph(
    verifiedReport,
    architectureBundle(verifiedReport),
  );
  const managedImplementation = incompleteManaged.tasks.find(
    ({ source }) => source === "implementation_work",
  );
  const currentLocalEvidence = verifiedReport.evidence_index.entries
    .filter(({ current, evidence_kind: kind }) => current && kind === "file")
    .map((entry) => ({
      digest: entry.digest,
      target: entry.target,
      collected_at: entry.collected_at,
      current: true,
    }));
  assert.throws(
    () => generateGraph(verifiedReport, architectureBundle(verifiedReport), {
      previous_graph: incompleteManaged,
      task_updates: [{
        task_id: managedImplementation.task_id,
        status: "verified",
        verification_evidence: currentLocalEvidence,
      }],
    }),
    (error) => error.code === "invalid_task_graph_update",
  );
  const verificationArchitecture = implementationOnlyArchitecture(reportPackage);
  const verificationInitial = generateGraph(reportPackage, verificationArchitecture);
  const finding = verificationInitial.tasks.find(({ source_id }) =>
    source_id === "web.baseline.build-command");
  const evidenceByDigest = new Map(verifiedReport.evidence_index.entries.map((entry) => [
    entry.digest,
    entry,
  ]));
  assert.deepEqual(
    verificationInitial.tasks.filter(({ source }) => source === "finding").map((task) => [
      task.source_id,
      verifiedReport.report.results.checks.find(({ check_id: id }) => id === task.source_id).status,
    ]),
    verificationInitial.tasks.filter(({ source }) => source === "finding").map((task) => [
      task.source_id,
      "passed",
    ]),
  );
  const verifiedUpdates = verificationInitial.tasks
    .filter(({ source }) => source === "finding")
    .map((task) => {
      const freshCheck = verifiedReport.report.results.checks.find(({ check_id: id }) =>
        id === task.source_id);
      return {
        task_id: task.task_id,
        status: "verified",
        verification_evidence: freshCheck.evidence.map(({ digest }) => {
          const entry = evidenceByDigest.get(digest);
          return {
            digest: entry.digest,
            target: entry.target,
            collected_at: entry.collected_at,
            current: true,
          };
        }),
      };
    });
  const verified = generateGraph(
    verifiedReport,
    implementationOnlyArchitecture(verifiedReport),
    {
      previous_graph: verificationInitial,
      task_updates: verifiedUpdates,
    },
  );
  const verifiedImplementation = verified.tasks.find(
    ({ source }) => source === "implementation_work",
  );
  assert.equal(verified.currentness.state, "current");
  assert.equal(verified.ready_frontier.includes(verifiedImplementation.task_id), true);
  assert.equal(verifiedImplementation.status, "not_started");
  assert.equal(verified.tasks.find(({ task_id }) => task_id === finding.task_id).status, "verified");
  assert.ok(verifiedUpdates.every(({ verification_evidence: evidence }) => evidence.length > 0));

  const implementationEvidence = verifiedReport.report.results.checks
    .filter(({ status }) => status === "passed")
    .flatMap(({ evidence }) => evidence)
    .flatMap(({ digest }) => {
      const entry = evidenceByDigest.get(digest);
      return verifiedImplementation.evidence_targets.includes(entry.target)
        ? [{
          digest: entry.digest,
          target: entry.target,
          collected_at: entry.collected_at,
          current: true,
        }]
        : [];
    });
  const completed = generateGraph(
    verifiedReport,
    implementationOnlyArchitecture(verifiedReport),
    {
      previous_graph: verified,
      task_updates: [{
        task_id: verifiedImplementation.task_id,
        status: "verified",
        verification_evidence: implementationEvidence,
      }],
    },
  );
  assert.equal(completed.tasks.find(
    ({ task_id }) => task_id === verifiedImplementation.task_id,
  ).status, "verified");
  assert.ok(implementationEvidence.length > 0);

  const reassessedArchitecture = implementationOnlyArchitecture(verifiedReport);
  reassessedArchitecture.architecture_record.confirmed_decisions[0].implementation_path = "managed";
  reassessedArchitecture.package.records.architecture_record.digest = sha256(
    reassessedArchitecture.architecture_record,
  );
  const reassessed = generateGraph(verifiedReport, reassessedArchitecture, {
    previous_graph: completed,
  });
  const reassessedImplementation = reassessed.tasks.find(
    ({ source }) => source === "implementation_work",
  );
  assert.equal(reassessedImplementation.effect_class, "provider_configuration");
  assert.notEqual(reassessedImplementation.status, "verified");

  const carried = generateGraph(verifiedReport, implementationOnlyArchitecture(verifiedReport), {
    previous_graph: completed,
  });
  assert.equal(carried.tasks.find(({ task_id }) => task_id === finding.task_id).status, "verified");

  const forged = structuredClone(initial);
  forged.tasks.find(({ task_id }) => task_id === finding.task_id).status = "verified";
  forged.tasks.find(({ task_id }) => task_id === finding.task_id).verification_evidence = [{
    digest: `sha256:${"8".repeat(64)}`,
    target: finding.evidence_targets[0],
    collected_at: "2026-08-13T00:00:00.000Z",
    current: true,
  }];
  forged.ready_frontier = computeTaskGraphReadyFrontier(forged.tasks);
  assertValidTaskGraph(forged);
  assert.throws(
    () => generateGraph(reportPackage, architecture, { previous_graph: forged }),
    (error) => error.code === "task_graph_previous_untrusted",
  );

  const cancelled = generateGraph(reportPackage, architecture, {
    previous_graph: initial,
    task_updates: [{ task_id: investigation.task_id, status: "cancelled" }],
  });
  assert.equal(cancelled.tasks.find(({ task_id }) => task_id === implementation.task_id).status, "blocked");

  const staleArchitecture = architectureBundle(reportPackage, {
    currentness: {
      state: "needs_reassessment",
      invalidated_record_ids: [architecture.architecture_record.record_id],
      reasons: ["source_report_changed"],
    },
  });
  const stale = generateGraph(reportPackage, staleArchitecture);
  assert.equal(stale.currentness.state, "stale");
  assert.deepEqual(stale.ready_frontier, []);
});

test("one generic Task maps to multiple managed Executors and an explicit manual path", async () => {
  const { reportPackage } = await completeAudit();
  const graph = generateGraph(reportPackage, architectureBundle(reportPackage));
  const implementation = graph.tasks.find(({ source }) => source === "implementation_work");
  const descriptor = structuredClone(handoffFixture.executor);
  descriptor.supported_task_types = [implementation.task_type];
  descriptor.environments = [implementation.environment];
  descriptor.allowed_effects = [...implementation.allowed_effects];
  descriptor.prohibited_effects = [...implementation.prohibited_effects];
  descriptor.result_schema = implementation.structured_result_schema;
  descriptor.trust.digest = computeExecutorDescriptorDigest(descriptor);
  const secondDescriptor = structuredClone(descriptor);
  secondDescriptor.descriptor_id = "executor_second_managed_path";
  secondDescriptor.executor_name = "Second managed executor";
  secondDescriptor.trust.digest = computeExecutorDescriptorDigest(secondDescriptor);

  const mapping = mapTaskGraphExecutors(graph, [descriptor, secondDescriptor]);
  const selected = mapping.tasks.find(({ task_id }) => task_id === implementation.task_id);
  assert.deepEqual(selected.managed_executor_ids, [
    descriptor.descriptor_id,
    secondDescriptor.descriptor_id,
  ]);
  assert.deepEqual(selected.manual_path, {
    available: true,
    kind: "manual_or_custom",
    required_capability: implementation.minimum_executor_capability,
  });

  const overAuthorized = structuredClone(descriptor);
  overAuthorized.descriptor_id = "executor_over_authorized";
  overAuthorized.allowed_effects.push("provider_configuration_write");
  overAuthorized.prohibited_effects = overAuthorized.prohibited_effects.filter(
    (effect) => effect !== "provider_configuration_write",
  );
  overAuthorized.trust.digest = computeExecutorDescriptorDigest(overAuthorized);
  assert.deepEqual(
    mapTaskGraphExecutors(graph, [overAuthorized]).tasks.find(
      ({ task_id }) => task_id === implementation.task_id,
    ).managed_executor_ids,
    [],
  );
});
