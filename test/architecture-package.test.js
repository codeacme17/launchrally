import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertValidArchitecturePackage,
  assertValidArchitectureRecord,
} from "../packages/contracts/src/index.js";
import {
  EXECUTION_AUTHORITY_DESCRIPTOR_PATH,
  createArchitecturePackageBundle,
  evaluateArchitecturePackageCurrentness,
  persistArchitecturePackage,
  previewArchitecturePackagePersistence,
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
const intentFixture = JSON.parse(await readFile(
  new URL("./fixtures/phase-1-contracts/product-intent-profile.valid.json", import.meta.url),
  "utf8",
));
const taskGraphFixture = JSON.parse(await readFile(
  new URL("./fixtures/phase-1-contracts/handoff.valid.json", import.meta.url),
  "utf8",
)).task_graph;
const execFileAsync = promisify(execFile);
const cli = path.resolve("packages/cli/bin/rally.js");
const engine = path.resolve("packages/cli/bin/engine.js");

function validManifest() {
  const unknown = { state: "unknown", reason: "fixture" };
  return {
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
  };
}

async function initialize(directory) {
  const launchrally = path.join(directory, ".launchrally");
  await mkdir(launchrally, { recursive: true });
  await writeFile(
    path.join(launchrally, "manifest.yaml"),
    `${JSON.stringify(validManifest())}\n`,
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
  return launchrally;
}

function source(overrides = {}) {
  const blueprint = structuredClone(architectureFixture.blueprint);
  const productIntent = structuredClone(intentFixture);
  const graph = structuredClone(capabilityFixture.graph);
  blueprint.product_intent = {
    id: productIntent.profile_id,
    schema_version: productIntent.schema_version,
    digest: sha256(productIntent),
  };
  blueprint.capability_graph = {
    id: graph.graph_id,
    schema_version: graph.schema_version,
    digest: sha256(graph),
  };
  return {
    blueprint,
    product_intent: productIntent,
    catalog: structuredClone(capabilityFixture.catalog),
    capability_graph: graph,
    integration_contracts: [structuredClone(capabilityFixture.integration)],
    provider_knowledge_refs: [],
    decision_results: [{ decision_id: "decision_identity", response: "confirm" }],
    task_graph: null,
    dependencies: [{
      source_id: "decision_identity",
      dependent_semantics: ["architecture_record"],
      evidence_ids: ["evidence_identity_configuration"],
    }],
    interaction_id: "interaction_architect_01",
    ...overrides,
  };
}

function bundle(now = "2026-08-13T00:00:00.000Z", overrides = {}) {
  return createArchitecturePackageBundle(source(overrides), { now });
}

test("confirmed decisions create separate immutable versioned Architecture Package semantics", () => {
  const first = bundle();
  const second = bundle("2026-08-13T00:00:01.000Z", { previous_package: first.package });

  assert.equal(assertValidArchitectureRecord(first.architecture_record), true);
  assert.equal(assertValidArchitecturePackage(first.package), true);
  assert.equal(first.architecture_record.bindings.constraints_digest.startsWith("sha256:"), true);
  assert.deepEqual(first.architecture_record.confirmed_decisions[0], {
    decision_id: "decision_identity",
    decision_revision: 1,
    capability_id: "identity_authentication",
    implementation_path: "unknown",
    confirmation: "explicit_user_confirmation",
    status: "investigate",
  });
  assert.equal(
    first.architecture_record.bindings.source_report.digest,
    architectureFixture.blueprint.source_report.digest,
  );
  assert.equal(first.architecture_record.bindings.capability_catalog.digest, capabilityFixture.catalog.digest);
  assert.equal(first.product_intent.schema_version, "launchrally.dev/product-intent-profile/v1");
  assert.equal(first.capability_graph.schema_version, "launchrally.dev/capability-graph/v1");
  assert.equal(Object.hasOwn(first, "blueprint"), false);
  assert.equal(first.task_graph, null);
  assert.notEqual(second.architecture_record.record_id, first.architecture_record.record_id);
  assert.equal(second.package.revision, 2);
  assert.equal(second.dependency_index.edges[0].dependent_record_ids.length, 1);
  const withTaskGraph = bundle("2026-08-13T00:00:02.000Z", {
    task_graph: taskGraphFixture,
    dependencies: [{
      source_id: "decision_identity",
      dependent_semantics: ["architecture_record", "task_graph"],
      evidence_ids: ["evidence_identity_configuration"],
    }],
  });
  assert.equal(withTaskGraph.task_graph.architecture_record.id, withTaskGraph.architecture_record.record_id);
  assert.equal(withTaskGraph.package.records.task_graph.id, withTaskGraph.task_graph.graph_id);
  assert.throws(
    () => createArchitecturePackageBundle(source({
      decision_results: [],
    }), { now: "2026-08-13T00:00:00.000Z" }),
    (error) => error.code === "invalid_architecture_decisions",
  );
  const mismatchedCatalog = source();
  mismatchedCatalog.capability_graph.catalog = {
    id: "catalog_unrelated",
    schema_version: "launchrally.dev/capability-catalog/v1",
    digest: `sha256:${"6".repeat(64)}`,
  };
  mismatchedCatalog.blueprint.capability_graph.digest = sha256(
    mismatchedCatalog.capability_graph,
  );
  assert.throws(
    () => createArchitecturePackageBundle(mismatchedCatalog, {
      now: "2026-08-13T00:00:00.000Z",
    }),
    (error) => error.code === "architecture_binding_mismatch",
  );
});

test("currentness invalidates only declared decision dependencies and reassesses stale inputs", () => {
  const value = bundle();
  const partial = evaluateArchitecturePackageCurrentness(value, {
    changed_dependency_ids: ["decision_identity"],
  });
  assert.deepEqual(partial, {
    state: "partially_invalidated",
    invalidated_record_ids: [value.architecture_record.record_id],
    invalidated_evidence_ids: ["evidence_identity_configuration"],
    reasons: ["declared_dependency_changed:decision_identity"],
  });

  const stale = evaluateArchitecturePackageCurrentness(value, {
    source_report: { ...value.architecture_record.bindings.source_report, digest: `sha256:${"9".repeat(64)}` },
  });
  assert.equal(stale.state, "needs_reassessment");
  assert.deepEqual(stale.reasons, ["source_report_changed"]);
  assert.equal(evaluateArchitecturePackageCurrentness(value, {
    constraints_digest: `sha256:${"7".repeat(64)}`,
  }).state, "needs_reassessment");
});

test("pre-Init architecture is output-only unless an explicit output path is selected", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-architecture-output-"));
  const value = bundle();
  const preview = await previewArchitecturePackagePersistence(directory, value);
  assert.equal(preview.mode, "output_only");
  assert.deepEqual(preview.files, []);

  const output = path.join(directory, "reviewed-architecture.json");
  const persisted = await persistArchitecturePackage(directory, value, { output_path: output });
  assert.equal(persisted.status, "completed");
  assert.equal(persisted.mode, "selected_output");
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), value);
  await assert.rejects(
    persistArchitecturePackage(directory, value, { output_path: output }),
    (error) => error.code === "architecture_output_exists",
  );
});

test("public CLI persists a reviewed pre-Init package only to the selected output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-architecture-cli-"));
  await writeFile(path.join(directory, "package.json"), "{\"name\":\"architecture-cli\"}\n");
  const packagePath = path.join(directory, "package-bundle.json");
  const outputPath = path.join(directory, "reviewed-output.json");
  await writeFile(packagePath, `${JSON.stringify(bundle())}\n`);
  const { stdout } = await execFileAsync(process.execPath, [
    cli,
    "architecture-package",
    "--json",
    "--cwd",
    directory,
    "--package",
    packagePath,
    "--output",
    outputPath,
  ]);
  const result = JSON.parse(stdout);
  assert.equal(result.status, "completed");
  assert.equal(result.mode, "selected_output");
  assert.equal(result.persisted, true);
  assert.equal(JSON.parse(await readFile(outputPath, "utf8")).package.package_id, bundle().package.package_id);
});

test("an invalid Init marker remains output-only", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-architecture-marker-"));
  await mkdir(path.join(directory, ".launchrally"));
  await writeFile(
    path.join(directory, ".launchrally/manifest.yaml"),
    "schema_version: launchrally.dev/manifest/v2\n",
  );
  assert.equal((await previewArchitecturePackagePersistence(directory, bundle())).mode, "output_only");
});

test("public Engine previews and confirms initialized immutable history", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-architecture-cli-history-"));
  await initialize(directory);
  const packagePath = path.join(directory, "package-bundle.json");
  const value = bundle();
  await writeFile(packagePath, `${JSON.stringify(value)}\n`);
  const preview = JSON.parse((await execFileAsync(process.execPath, [
    engine,
    "architecture-package",
    "--json",
    "--cwd",
    directory,
    "--package",
    packagePath,
  ])).stdout);
  assert.equal(preview.status, "needs_confirmation");
  const committed = JSON.parse((await execFileAsync(process.execPath, [
    engine,
    "architecture-package",
    "--json",
    "--cwd",
    directory,
    "--package",
    packagePath,
    "--resume",
    preview.resume_token,
    "--confirm",
    "confirm",
  ])).stdout);
  assert.equal(committed.status, "completed");
  assert.equal(JSON.parse(await readFile(
    path.join(directory, ".launchrally/architecture/current.json"),
    "utf8",
  )).package_id, value.package.package_id);
});

test("initialized history previews and atomically appends without replacing the prior package", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-architecture-history-"));
  const launchrally = await initialize(directory);
  const manifestBefore = await readFile(path.join(launchrally, "manifest.yaml"), "utf8");

  const first = bundle();
  const preview = await previewArchitecturePackagePersistence(directory, first);
  assert.equal(preview.mode, "local_history");
  assert.equal(preview.requires_confirmation, true);
  const firstPreview = await persistArchitecturePackage(directory, first);
  assert.equal(firstPreview.status, "needs_confirmation");
  const substituted = bundle("2026-08-13T00:00:00.500Z");
  await assert.rejects(
    persistArchitecturePackage(directory, substituted, {
      confirmation: "confirm",
      resume_token: firstPreview.resume_token,
    }),
    (error) => error.code === "invalid_architecture_persistence_preview",
  );
  const committed = await persistArchitecturePackage(directory, first, {
    confirmation: "confirm",
    resume_token: firstPreview.resume_token,
  });
  assert.equal(committed.status, "completed");
  assert.equal(await readFile(path.join(launchrally, "manifest.yaml"), "utf8"), manifestBefore);

  const pointerPath = path.join(directory, ".launchrally/architecture/current.json");
  const previousPointer = await readFile(pointerPath, "utf8");
  const second = bundle("2026-08-13T00:00:01.000Z", { previous_package: first.package });
  const secondPreview = await persistArchitecturePackage(directory, second);
  await assert.rejects(
    persistArchitecturePackage(directory, second, {
      confirmation: "confirm",
      resume_token: secondPreview.resume_token,
      file_operations: {
        async before_pointer_commit() {
          const error = new Error("simulated interruption");
          error.code = "simulated_interruption";
          throw error;
        },
      },
    }),
    (error) => error.code === "simulated_interruption",
  );
  assert.equal(await readFile(pointerPath, "utf8"), previousPointer);
  const secondRecoveryPreview = await persistArchitecturePackage(directory, second);
  assert.equal((await persistArchitecturePackage(directory, second, {
    confirmation: "confirm",
    resume_token: secondRecoveryPreview.resume_token,
  })).status, "completed");

  const third = bundle("2026-08-13T00:00:02.000Z", { previous_package: second.package });
  const orphanDirectory = path.join(
    directory,
    ".launchrally/architecture/packages",
    third.package.package_id,
  );
  await mkdir(orphanDirectory, { recursive: true });
  await writeFile(
    path.join(orphanDirectory, "package.json"),
    `${JSON.stringify(third.package)}\n`,
  );
  const interrupted = path.join(
    directory,
    ".launchrally/architecture/transactions/architecture-00000000-0000-4000-8000-000000000000",
  );
  await mkdir(interrupted, { recursive: true });
  await writeFile(path.join(interrupted, "transaction.json"), `${JSON.stringify({
    schema_version: "launchrally.dev/architecture-transaction/v1",
    package_id: third.package.package_id,
    package_digest: sha256(third.package),
    intent_digest: sha256(third.product_intent),
    intent_created: false,
    owner_pid: 2147483647,
  })}\n`);
  const pointerBeforeRecovery = await readFile(pointerPath, "utf8");
  const thirdPreview = await persistArchitecturePackage(directory, third);
  assert.equal((await persistArchitecturePackage(directory, third, {
    confirmation: "confirm",
    resume_token: thirdPreview.resume_token,
  })).status, "completed");
  assert.notEqual(await readFile(pointerPath, "utf8"), pointerBeforeRecovery);
  assert.deepEqual(JSON.parse(await readFile(path.join(
    directory,
    `.launchrally/architecture/shareable-intent/sha256/${sha256(third.product_intent).slice(7)}.json`,
  ), "utf8")), third.product_intent);
  await assert.rejects(
    readFile(path.join(
      directory,
      ".launchrally/architecture/packages",
      third.package.package_id,
      "product-intent.json",
    )),
    (error) => error.code === "ENOENT",
  );
});

test("secret-like identifiers cannot enter immutable Architecture history", async () => {
  assert.throws(
    () => bundle("2026-08-13T00:00:00.000Z", {
      provider_knowledge_refs: [{
        id: "stripe_sk_live_abcd1234",
        schema_version: "launchrally.dev/provider-knowledge/v1",
        digest: `sha256:${"8".repeat(64)}`,
      }],
    }),
    (error) => error.code === "invalid_architecture_record",
  );
  assert.throws(
    () => bundle("2026-08-13T00:00:00.000Z", {
      provider_knowledge_refs: [{
        id: `knowledge_${"8".repeat(16)}`,
        schema_version: "launchrally.dev/report/v1",
        digest: `sha256:${"8".repeat(64)}`,
      }],
    }),
    (error) => error.code === "invalid_architecture_record",
  );
  const unsafe = source();
  unsafe.blueprint.decisions[0].rationale = ["authorization=Bearer-secret-value"];
  const secretSafeBundle = createArchitecturePackageBundle(unsafe, {
    now: "2026-08-13T00:00:00.000Z",
  });
  assert.equal(JSON.stringify(secretSafeBundle).includes("Bearer-secret-value"), false);
  await assert.rejects(
    previewArchitecturePackagePersistence(".", {
      ...secretSafeBundle,
      private_notes: "ordinary private repository content",
    }),
    (error) => error.code === "invalid_architecture_package_bundle",
  );
});

test("confirmation rechecks the current pointer after acquiring the history lock", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-architecture-race-"));
  await initialize(directory);
  const value = bundle();
  const preview = await persistArchitecturePackage(directory, value);
  const pointerPath = path.join(directory, ".launchrally/architecture/current.json");
  await assert.rejects(
    persistArchitecturePackage(directory, value, {
      confirmation: "confirm",
      resume_token: preview.resume_token,
      file_operations: {
        async after_history_lock() {
          await mkdir(path.dirname(pointerPath), { recursive: true });
          await writeFile(pointerPath, `${JSON.stringify({
            schema_version: "launchrally.dev/architecture-package-pointer/v1",
            package_id: "architecture_package_concurrent",
            package_digest: `sha256:${"6".repeat(64)}`,
          })}\n`);
        },
      },
    }),
    (error) => error.code === "architecture_current_pointer_changed",
  );
  assert.equal(JSON.parse(await readFile(pointerPath, "utf8")).package_id,
    "architecture_package_concurrent");
});

test("shareable Product Intent refuses redirected history paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-architecture-link-"));
  await initialize(directory);
  const outside = await mkdtemp(path.join(os.tmpdir(), "launchrally-architecture-outside-"));
  const architectureRoot = path.join(directory, ".launchrally/architecture");
  await mkdir(architectureRoot, { recursive: true });
  await symlink(outside, path.join(architectureRoot, "shareable-intent"), "dir");
  const value = bundle();
  const preview = await persistArchitecturePackage(directory, value);
  await assert.rejects(
    persistArchitecturePackage(directory, value, {
      confirmation: "confirm",
      resume_token: preview.resume_token,
    }),
    (error) => error.code === "unsafe_architecture_history_path",
  );
});

test("transaction recovery refuses redirected history parents", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-architecture-recovery-link-"));
  await initialize(directory);
  const outside = await mkdtemp(path.join(os.tmpdir(), "launchrally-architecture-recovery-outside-"));
  const architectureRoot = path.join(directory, ".launchrally/architecture");
  await mkdir(architectureRoot, { recursive: true });
  await symlink(outside, path.join(architectureRoot, "transactions"), "dir");
  const value = bundle();
  const preview = await persistArchitecturePackage(directory, value);
  await assert.rejects(
    persistArchitecturePackage(directory, value, {
      confirmation: "confirm",
      resume_token: preview.resume_token,
    }),
    (error) => error.code === "unsafe_architecture_history_path",
  );
});

test("transaction recovery refuses redirected journal and package children", async (context) => {
  await context.test("symlinked journal", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-architecture-journal-link-"));
    await initialize(directory);
    const outside = path.join(await mkdtemp(path.join(os.tmpdir(), "launchrally-journal-outside-")), "transaction.json");
    await writeFile(outside, "{}\n");
    const transaction = path.join(
      directory,
      ".launchrally/architecture/transactions/architecture-00000000-0000-4000-8000-000000000001",
    );
    await mkdir(transaction, { recursive: true });
    await symlink(outside, path.join(transaction, "transaction.json"));
    const value = bundle();
    const preview = await persistArchitecturePackage(directory, value);
    await assert.rejects(
      persistArchitecturePackage(directory, value, {
        confirmation: "confirm",
        resume_token: preview.resume_token,
      }),
      (error) => error.code === "unsafe_architecture_history_path",
    );
  });

  await context.test("symlinked packages parent", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-architecture-packages-link-"));
    await initialize(directory);
    const outside = await mkdtemp(path.join(os.tmpdir(), "launchrally-packages-outside-"));
    const architectureRoot = path.join(directory, ".launchrally/architecture");
    const transaction = path.join(
      architectureRoot,
      "transactions/architecture-00000000-0000-4000-8000-000000000002",
    );
    await mkdir(transaction, { recursive: true });
    await writeFile(path.join(transaction, "transaction.json"), `${JSON.stringify({
      schema_version: "launchrally.dev/architecture-transaction/v1",
      package_id: "architecture_package_interrupted",
      package_digest: `sha256:${"4".repeat(64)}`,
      intent_digest: `sha256:${"5".repeat(64)}`,
      intent_created: false,
      owner_pid: 2147483647,
    })}\n`);
    await symlink(outside, path.join(architectureRoot, "packages"), "dir");
    const value = bundle();
    const preview = await persistArchitecturePackage(directory, value);
    await assert.rejects(
      persistArchitecturePackage(directory, value, {
        confirmation: "confirm",
        resume_token: preview.resume_token,
      }),
      (error) => error.code === "unsafe_architecture_history_path",
    );
  });
});
