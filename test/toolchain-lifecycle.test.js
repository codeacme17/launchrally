import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { assertValidToolchainLifecycle } from "../packages/contracts/src/index.js";
import { runToolchainLifecycle } from "../packages/core/src/index.js";
import {
  materializeExactToolchain,
  writeExactToolchain,
} from "./helpers/exact-toolchain.js";

const execFileAsync = promisify(execFile);
const cli = path.resolve("packages/cli/bin/rally.js");

function validManifest() {
  const unknown = (reason) => ({ state: "unknown", reason });
  return {
    schema_version: "launchrally.dev/manifest/v2",
    project: {
      name: unknown("fixture"),
      type: unknown("fixture"),
      package_manager: unknown("fixture"),
    },
    release: {
      intended_environment: unknown("fixture"),
      production_targets: unknown("fixture"),
      core_journeys: unknown("fixture"),
    },
    execution: {
      source_report_id: unknown("fixture"),
      assessment: unknown("fixture"),
      public_verification: unknown("fixture"),
    },
    support: { layers: unknown("fixture") },
    providers: { roles: unknown("fixture") },
  };
}

async function repositoryFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-lifecycle-"));
  await mkdir(path.join(directory, ".git"));
  return directory;
}

async function writeProject(repository, version = "0.2.2") {
  await mkdir(path.join(repository, ".launchrally"), { recursive: true });
  await writeFile(
    path.join(repository, ".launchrally", "manifest.yaml"),
    `${JSON.stringify(validManifest())}\n`,
  );
  await writeExactToolchain(repository, version);
  await writeFile(
    path.join(repository, ".launchrally", "toolchain", "authority.json"),
    `${JSON.stringify({
      contract: "launchrally.dev/execution-authority/v1",
      engine: {
        package: "@launchrally/cli",
        version,
        entrypoint: "bin/engine.js",
      },
    }, null, 2)}\n`,
  );
}

async function preparedToolchain(version) {
  const staging = await repositoryFixture();
  await mkdir(path.join(staging, ".launchrally"), { recursive: true });
  await writeExactToolchain(staging, version);
  await writeFile(
    path.join(staging, ".launchrally", "toolchain", "authority.json"),
    `${JSON.stringify({
      contract: "launchrally.dev/execution-authority/v1",
      engine: {
        package: "@launchrally/cli",
        version,
        entrypoint: "bin/engine.js",
      },
    }, null, 2)}\n`,
  );
  await materializeExactToolchain(staging, version);
  return path.join(staging, ".launchrally", "toolchain");
}

test("toolchain status reports the exact missing project materialization without writing", async () => {
  const repository = await repositoryFixture();
  await writeProject(repository);
  const before = await readdir(path.join(repository, ".launchrally"));

  const result = await runToolchainLifecycle(repository, "0.2.2", {
    operation: "status",
  });

  assert.equal(result.contract, "launchrally.dev/toolchain-lifecycle/v1");
  assert.equal(result.status, "unavailable");
  assert.equal(result.operation, "toolchain_status");
  assert.equal(result.authority.state, "needs_toolchain_restore");
  assert.equal(result.authority.engine.version, "0.2.2");
  assert.deepEqual(await readdir(path.join(repository, ".launchrally")), before);
  assert.equal(assertValidToolchainLifecycle(result), true);
});

test("the CLI exposes toolchain status as a public bootstrap command", async () => {
  const repository = await repositoryFixture();
  await writeProject(repository);

  await assert.rejects(
    execFileAsync(process.execPath, [
      cli,
      "toolchain",
      "status",
      "--json",
      "--cwd",
      repository,
    ]),
    (error) => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.operation, "toolchain_status");
      assert.equal(result.authority.state, "needs_toolchain_restore");
      return true;
    },
  );
});

test("toolchain restore rebuilds the established pin offline without changing authority files", async () => {
  const repository = await repositoryFixture();
  await writeProject(repository);
  const packagePath = path.join(repository, ".launchrally", "toolchain", "package.json");
  const lockPath = path.join(repository, ".launchrally", "toolchain", "package-lock.json");
  const authorityPath = path.join(repository, ".launchrally", "toolchain", "authority.json");
  const before = await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(lockPath, "utf8"),
    readFile(authorityPath, "utf8"),
  ]);
  const beforeStats = await Promise.all([
    lstat(packagePath),
    lstat(lockPath),
    lstat(authorityPath),
  ]);
  const attempts = [];

  const restored = await runToolchainLifecycle(
    repository,
    "0.2.2",
    { operation: "restore", registry_allowed: true },
    {
      prepare_toolchain: async (request) => {
        attempts.push(request);
        return { toolchain_path: await preparedToolchain(request.version) };
      },
    },
  );

  assert.equal(restored.status, "completed", JSON.stringify(restored));
  assert.equal(restored.outcome, "restored");
  assert.equal(restored.authority.state, "ready");
  assert.equal(restored.authority.engine.version, "0.2.2");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].registry_allowed, false);
  assert.equal(attempts[0].operation, "restore");
  assert.deepEqual(await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(lockPath, "utf8"),
    readFile(authorityPath, "utf8"),
  ]), before);
  const afterStats = await Promise.all([
    lstat(packagePath),
    lstat(lockPath),
    lstat(authorityPath),
  ]);
  assert.deepEqual(
    afterStats.map(({ dev, ino }) => ({ dev, ino })),
    beforeStats.map(({ dev, ino }) => ({ dev, ino })),
  );
});

test("toolchain restore preserves the supported legacy 0.2.2 pin without auto-migration", async () => {
  const repository = await repositoryFixture();
  await writeProject(repository, "0.2.2");
  const authorityPath = path.join(repository, ".launchrally", "toolchain", "authority.json");
  await rm(authorityPath);
  const legacyPrepared = await preparedToolchain("0.2.2");
  await rm(path.join(legacyPrepared, "authority.json"));
  const legacyCliPackagePath = path.join(
    legacyPrepared,
    "node_modules/@launchrally/cli/package.json",
  );
  const legacyCliPackage = JSON.parse(await readFile(legacyCliPackagePath, "utf8"));
  delete legacyCliPackage.launchrally.engine;
  await writeFile(
    legacyCliPackagePath,
    `${JSON.stringify(legacyCliPackage, null, 2)}\n`,
  );

  const restored = await runToolchainLifecycle(
    repository,
    "0.3.0",
    { operation: "restore" },
    { prepare_toolchain: async (request) => {
      assert.equal(request.authority_descriptor, null);
      return { toolchain_path: legacyPrepared };
    } },
  );

  assert.equal(restored.outcome, "restored");
  assert.equal(restored.authority.engine.version, "0.2.2");
  assert.equal(restored.authority.engine.compatibility, "legacy_adapter");
  await assert.rejects(lstat(authorityPath), { code: "ENOENT" });
});

test("toolchain clean removes only rebuildable lifecycle state", async () => {
  const repository = await repositoryFixture();
  await writeProject(repository);
  await materializeExactToolchain(repository, "0.2.2");
  const manifestPath = path.join(repository, ".launchrally", "manifest.yaml");
  const packagePath = path.join(repository, ".launchrally", "toolchain", "package.json");
  const before = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(packagePath, "utf8"),
  ]);

  const cleaned = await runToolchainLifecycle(repository, "0.2.2", {
    operation: "clean",
  });
  const status = await runToolchainLifecycle(repository, "0.2.2", {
    operation: "status",
  });

  assert.equal(cleaned.status, "completed");
  assert.equal(cleaned.outcome, "cleaned");
  assert.equal(status.authority.state, "needs_toolchain_restore");
  assert.deepEqual(await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(packagePath, "utf8"),
  ]), before);
});

test("toolchain restore requests one bounded registry read only after an offline miss", async () => {
  const repository = await repositoryFixture();
  await writeProject(repository);
  const attempts = [];
  const prepare = async (request) => {
    attempts.push(request.registry_allowed);
    if (!request.registry_allowed) {
      const error = new Error("offline cache miss");
      error.code = "registry_permission_required";
      error.temporary_target = "/tmp/launchrally-toolchain-prepare-example/toolchain";
      throw error;
    }
    return { toolchain_path: await preparedToolchain(request.version) };
  };

  const permission = await runToolchainLifecycle(
    repository,
    "0.2.2",
    { operation: "restore" },
    { prepare_toolchain: prepare },
  );

  assert.equal(permission.status, "needs_permission");
  assert.deepEqual(attempts, [false]);
  assert.deepEqual(permission.request.permissions[0], {
    id: "npm_registry_read",
    boundary: "public_network",
    source: "https://registry.npmjs.org",
    package: "@launchrally/cli",
    version: "0.2.2",
    temporary_target: "/tmp/launchrally-toolchain-prepare-example/toolchain",
    commands: [{
      executable: "npm",
      arguments: [
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmjs.org",
      ],
      shell: false,
    }],
  });

  const restored = await runToolchainLifecycle(
    repository,
    "0.2.2",
    {
      operation: "restore",
      resume_token: permission.interaction.resume_token,
      permission_decisions: { npm_registry_read: "approved" },
    },
    { prepare_toolchain: prepare },
  );

  assert.equal(restored.outcome, "restored");
  assert.deepEqual(attempts, [false, true]);
});

test("toolchain migrate atomically replaces authority and preserves project history", async () => {
  const repository = await repositoryFixture();
  await writeProject(repository, "0.2.2");
  await materializeExactToolchain(repository, "0.2.2");
  const manifestPath = path.join(repository, ".launchrally", "manifest.yaml");
  const reportPath = path.join(repository, ".launchrally", "reports", "report-one", "record.json");
  const evidencePath = path.join(repository, ".launchrally", "evidence", "sha256", `${"a".repeat(64)}.json`);
  const cachePath = path.join(repository, ".launchrally", "cache", "current-report.json");
  await mkdir(path.dirname(reportPath), { recursive: true });
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(reportPath, "immutable report\n");
  await writeFile(evidencePath, "immutable evidence\n");
  await writeFile(cachePath, `${JSON.stringify({
    schema_version: "launchrally.dev/local-history-pointer/v1",
    report_id: "report-one",
    record_digest: `sha256:${"b".repeat(64)}`,
  })}\n`);
  const preservedBefore = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(reportPath, "utf8"),
    readFile(evidencePath, "utf8"),
  ]);
  const prepare = async (request) => ({
    toolchain_path: await preparedToolchain(request.version),
    materialization: {
      package_count: 9,
      integrity_digest: `sha256:${"c".repeat(64)}`,
    },
  });

  const preview = await runToolchainLifecycle(
    repository,
    "0.3.0",
    { operation: "migrate", to: "0.3.0" },
    { prepare_toolchain: prepare },
  );

  assert.equal(preview.status, "needs_confirmation");
  assert.equal(preview.preview.from_version, "0.2.2");
  assert.equal(preview.preview.to_version, "0.3.0");
  assert.deepEqual(preview.preview.materialization, {
    package_count: 9,
    integrity_digest: `sha256:${"c".repeat(64)}`,
    target: ".launchrally/toolchain/node_modules",
    ignored: true,
    authoritative: false,
  });
  assert.deepEqual(await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(reportPath, "utf8"),
    readFile(evidencePath, "utf8"),
  ]), preservedBefore);

  const migrated = await runToolchainLifecycle(
    repository,
    "0.3.0",
    {
      operation: "migrate",
      to: "0.3.0",
      resume_token: preview.interaction.resume_token,
      confirmation: "confirm",
    },
    { prepare_toolchain: prepare },
  );

  assert.equal(migrated.status, "completed");
  assert.equal(migrated.outcome, "migrated");
  assert.equal(migrated.authority.state, "ready");
  assert.equal(migrated.authority.engine.version, "0.3.0");
  assert.deepEqual(migrated.next_action, {
    operation: "verify",
    scope: "full",
    reason: "execution_authority_changed",
  });
  assert.deepEqual(await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(reportPath, "utf8"),
    readFile(evidencePath, "utf8"),
  ]), preservedBefore);
  assert.deepEqual(JSON.parse(await readFile(cachePath, "utf8")).currentness, {
    status: "non_current",
    reasons: [{
      reason_code: "execution_authority_changed",
      previous_version: "0.2.2",
      current_version: "0.3.0",
    }],
  });
});

test("toolchain migrate rejects ranges and unsupported exact versions before preparation", async () => {
  const repository = await repositoryFixture();
  await writeProject(repository, "0.2.2");
  let preparations = 0;
  const dependencies = {
    prepare_toolchain: async () => {
      preparations += 1;
      return { toolchain_path: await preparedToolchain("0.3.0") };
    },
  };

  const range = await runToolchainLifecycle(
    repository,
    "0.3.0",
    { operation: "migrate", to: "^0.3.0" },
    dependencies,
  );
  const unsupported = await runToolchainLifecycle(
    repository,
    "0.3.0",
    { operation: "migrate", to: "8.8.8" },
    dependencies,
  );

  assert.equal(range.error, "exact_version_required");
  assert.equal(unsupported.error, "unsupported_toolchain_version");
  assert.equal(preparations, 0);
});

test("a lifecycle retry rolls back an interrupted mixed-version transaction", async () => {
  const repository = await repositoryFixture();
  await writeProject(repository, "0.2.2");
  await materializeExactToolchain(repository, "0.2.2");
  const transaction = path.join(repository, ".launchrally", ".toolchain-transaction");
  const toolchain = path.join(repository, ".launchrally", "toolchain");
  await mkdir(transaction);
  await writeFile(path.join(transaction, "transaction.json"), `${JSON.stringify({
    schema_version: "launchrally.dev/toolchain-transaction/v1",
    phase: "prepared",
    operation: "migrate",
    had_previous: true,
    previous_version: "0.2.2",
    version: "0.3.0",
  })}\n`);
  await rename(toolchain, path.join(transaction, "old"));
  await cp(await preparedToolchain("0.3.0"), path.join(transaction, "new"), {
    recursive: true,
  });

  const recovered = await runToolchainLifecycle(repository, "0.3.0", {
    operation: "restore",
  });

  assert.equal(recovered.status, "completed");
  assert.equal(recovered.outcome, "already_ready");
  assert.equal(recovered.authority.engine.version, "0.2.2");
  await assert.rejects(lstat(transaction), { code: "ENOENT" });
});

test("the lifecycle contract rejects extra fields and mismatched request variants", async () => {
  const repository = await repositoryFixture();
  await writeProject(repository);
  const status = await runToolchainLifecycle(repository, "0.2.2", {
    operation: "status",
  });

  assert.throws(
    () => assertValidToolchainLifecycle({ ...status, unexpected: true }),
    { code: "invalid_toolchain_lifecycle" },
  );
  assert.throws(
    () => assertValidToolchainLifecycle({
      contract: "launchrally.dev/toolchain-lifecycle/v1",
      status: "needs_confirmation",
      operation: "toolchain_migrate",
      interaction: {
        schema_version: "launchrally.dev/toolchain-lifecycle-state/v1",
        resume_token: "opaque",
      },
      request: {
        type: "permission",
        permissions: [],
      },
    }),
    { code: "invalid_toolchain_lifecycle" },
  );
  assert.throws(
    () => assertValidToolchainLifecycle({
      contract: "launchrally.dev/toolchain-lifecycle/v1",
      status: "completed",
      operation: "toolchain_unknown",
      outcome: "migrated",
    }),
    { code: "invalid_toolchain_lifecycle" },
  );
  assert.throws(
    () => assertValidToolchainLifecycle({
      contract: "launchrally.dev/toolchain-lifecycle/v1",
      status: "completed",
      operation: "toolchain_migrate",
      outcome: "migrated",
      authority: status.authority,
    }),
    { code: "invalid_toolchain_lifecycle" },
  );
});

test("denying lifecycle registry permission removes the exact disclosed temporary target", async () => {
  const repository = await repositoryFixture();
  await writeProject(repository);
  const staging = await mkdtemp(path.join(os.tmpdir(), "launchrally-toolchain-prepare-denied-"));
  const temporaryTarget = path.join(staging, "toolchain");
  await mkdir(temporaryTarget);
  const prepare = async (request) => {
    assert.equal(request.registry_allowed, false);
    const error = new Error("offline cache miss");
    error.code = "registry_permission_required";
    error.temporary_target = temporaryTarget;
    error.cleanup_path = staging;
    throw error;
  };
  const permission = await runToolchainLifecycle(
    repository,
    "0.2.2",
    { operation: "restore" },
    { prepare_toolchain: prepare },
  );

  const denied = await runToolchainLifecycle(repository, "0.2.2", {
    operation: "restore",
    resume_token: permission.interaction.resume_token,
    permission_decisions: { npm_registry_read: "denied" },
  });

  assert.equal(denied.error, "registry_permission_denied");
  await assert.rejects(lstat(staging), { code: "ENOENT" });
  assert.equal((await runToolchainLifecycle(repository, "0.2.2", {
    operation: "status",
  })).authority.state, "needs_toolchain_restore");
});

test("migration confirmation rejects an authoritative file changed after preview", async () => {
  const repository = await repositoryFixture();
  await writeProject(repository, "0.2.2");
  await materializeExactToolchain(repository, "0.2.2");
  const packagePath = path.join(repository, ".launchrally", "toolchain", "package.json");
  const original = await readFile(packagePath, "utf8");
  const preview = await runToolchainLifecycle(
    repository,
    "0.3.0",
    { operation: "migrate", to: "0.3.0" },
    { prepare_toolchain: async () => ({
      toolchain_path: await preparedToolchain("0.3.0"),
    }) },
  );
  await writeFile(packagePath, ` ${original}`);

  const stale = await runToolchainLifecycle(repository, "0.3.0", {
    operation: "migrate",
    to: "0.3.0",
    resume_token: preview.interaction.resume_token,
    confirmation: "confirm",
  });

  assert.equal(stale.error, "preview_stale");
  assert.equal((await readFile(packagePath, "utf8")), ` ${original}`);
});

test("an invalid lifecycle transaction journal fails closed without changing authority", async () => {
  const repository = await repositoryFixture();
  await writeProject(repository, "0.2.2");
  await materializeExactToolchain(repository, "0.2.2");
  const packagePath = path.join(repository, ".launchrally", "toolchain", "package.json");
  const before = await readFile(packagePath, "utf8");
  const transaction = path.join(repository, ".launchrally", ".toolchain-transaction");
  await mkdir(transaction);
  await writeFile(path.join(transaction, "transaction.json"), "{}\n");

  const result = await runToolchainLifecycle(repository, "0.2.2", {
    operation: "clean",
  });

  assert.equal(result.error, "invalid_toolchain_transaction");
  assert.equal(await readFile(packagePath, "utf8"), before);
});

test("restore refuses a symlinked prepared toolchain without changing project authority", async () => {
  const repository = await repositoryFixture();
  await writeProject(repository, "0.2.2");
  const packagePath = path.join(repository, ".launchrally", "toolchain", "package.json");
  const before = await readFile(packagePath, "utf8");
  const prepared = await preparedToolchain("0.2.2");
  const staging = await mkdtemp(path.join(os.tmpdir(), "launchrally-symlinked-prepare-"));
  const linked = path.join(staging, "toolchain");
  await symlink(prepared, linked, "dir");

  const result = await runToolchainLifecycle(
    repository,
    "0.2.2",
    { operation: "restore" },
    { prepare_toolchain: async () => ({ toolchain_path: linked, cleanup_path: staging }) },
  );

  assert.equal(result.error, "invalid_prepared_toolchain");
  assert.equal(await readFile(packagePath, "utf8"), before);
});

test("a post-adoption report update failure rolls migration back to the complete old authority", async () => {
  const repository = await repositoryFixture();
  await writeProject(repository, "0.2.2");
  await materializeExactToolchain(repository, "0.2.2");
  const cachePath = path.join(repository, ".launchrally", "cache", "current-report.json");
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, "not-json\n");
  const preview = await runToolchainLifecycle(
    repository,
    "0.3.0",
    { operation: "migrate", to: "0.3.0" },
    { prepare_toolchain: async () => ({
      toolchain_path: await preparedToolchain("0.3.0"),
    }) },
  );

  const result = await runToolchainLifecycle(repository, "0.3.0", {
    operation: "migrate",
    to: "0.3.0",
    resume_token: preview.interaction.resume_token,
    confirmation: "confirm",
  });
  const authority = await runToolchainLifecycle(repository, "0.3.0", {
    operation: "status",
  });

  assert.equal(result.status, "execution_error");
  assert.equal(authority.authority.engine.version, "0.2.2");
  assert.equal(authority.authority.state, "ready");
  assert.equal(await readFile(cachePath, "utf8"), "not-json\n");
});

test("clean discards abandoned lifecycle previews and their prepared materialization", async () => {
  const repository = await repositoryFixture();
  await writeProject(repository, "0.2.2");
  await materializeExactToolchain(repository, "0.2.2");
  const cleanupPath = await mkdtemp(
    path.join(os.tmpdir(), "launchrally-toolchain-prepare-clean-"),
  );
  const stagedToolchain = path.join(cleanupPath, "toolchain");
  await cp(await preparedToolchain("0.3.0"), stagedToolchain, { recursive: true });
  const preview = await runToolchainLifecycle(
    repository,
    "0.3.0",
    { operation: "migrate", to: "0.3.0" },
    { prepare_toolchain: async () => ({
      toolchain_path: stagedToolchain,
      cleanup_path: cleanupPath,
    }) },
  );

  const cleaned = await runToolchainLifecycle(repository, "0.3.0", {
    operation: "clean",
  });
  const resumed = await runToolchainLifecycle(repository, "0.3.0", {
    operation: "migrate",
    to: "0.3.0",
    resume_token: preview.interaction.resume_token,
    confirmation: "confirm",
  });

  assert.equal(cleaned.outcome, "cleaned");
  assert.equal(resumed.error, "invalid_resume_token");
  await assert.rejects(lstat(cleanupPath), { code: "ENOENT" });
});

test("migration supports already-pinned, invalid-confirmation, and explicit-decline results", async () => {
  const repository = await repositoryFixture();
  await writeProject(repository, "0.2.2");
  await materializeExactToolchain(repository, "0.2.2");
  const alreadyPinned = await runToolchainLifecycle(repository, "0.2.2", {
    operation: "migrate",
    to: "0.2.2",
  });
  const preview = await runToolchainLifecycle(
    repository,
    "0.3.0",
    { operation: "migrate", to: "0.3.0" },
    { prepare_toolchain: async () => ({
      toolchain_path: await preparedToolchain("0.3.0"),
    }) },
  );
  const invalid = await runToolchainLifecycle(repository, "0.3.0", {
    operation: "migrate",
    to: "0.3.0",
    resume_token: preview.interaction.resume_token,
    confirmation: "later",
  });
  const declined = await runToolchainLifecycle(repository, "0.3.0", {
    operation: "migrate",
    to: "0.3.0",
    resume_token: preview.interaction.resume_token,
    confirmation: "decline",
  });

  assert.equal(alreadyPinned.outcome, "already_pinned");
  assert.equal(invalid.error, "invalid_confirmation");
  assert.equal(declined.outcome, "migration_declined");
  assert.deepEqual(declined.changes_applied, []);
  assert.equal(assertValidToolchainLifecycle(alreadyPinned), true);
  assert.equal(assertValidToolchainLifecycle(declined), true);
});

test("permission resume rejects an invalid decision without consuming the denial option", async () => {
  const repository = await repositoryFixture();
  await writeProject(repository);
  const staging = await mkdtemp(path.join(os.tmpdir(), "launchrally-toolchain-prepare-decision-"));
  const temporaryTarget = path.join(staging, "toolchain");
  await mkdir(temporaryTarget);
  const permission = await runToolchainLifecycle(
    repository,
    "0.2.2",
    { operation: "restore" },
    { prepare_toolchain: async () => {
      const error = new Error("offline cache miss");
      error.code = "registry_permission_required";
      error.temporary_target = temporaryTarget;
      error.cleanup_path = staging;
      throw error;
    } },
  );
  const invalid = await runToolchainLifecycle(repository, "0.2.2", {
    operation: "restore",
    resume_token: permission.interaction.resume_token,
    permission_decisions: { npm_registry_read: "later" },
  });
  const denied = await runToolchainLifecycle(repository, "0.2.2", {
    operation: "restore",
    resume_token: permission.interaction.resume_token,
    permission_decisions: { npm_registry_read: "denied" },
  });

  assert.equal(invalid.error, "invalid_permission_decision");
  assert.equal(denied.error, "registry_permission_denied");
});

test("unknown lifecycle operations and owned-lock failures are structured", async () => {
  const unknown = await runToolchainLifecycle(await repositoryFixture(), "0.2.2", {
    operation: "replace",
  });
  assert.equal(unknown.operation, "toolchain_unknown");
  assert.equal(unknown.error, "unknown_toolchain_operation");

  const invalidRepository = await repositoryFixture();
  await writeProject(invalidRepository);
  const invalidLocks = path.join(invalidRepository, ".launchrally", "locks");
  await mkdir(invalidLocks, { recursive: true });
  await writeFile(path.join(invalidLocks, "toolchain-lifecycle.lock"), "invalid\n");
  const invalid = await runToolchainLifecycle(invalidRepository, "0.2.2", {
    operation: "clean",
  });
  assert.equal(invalid.error, "invalid_toolchain_lifecycle_lock");

  const busyRepository = await repositoryFixture();
  await writeProject(busyRepository);
  const busyLocks = path.join(busyRepository, ".launchrally", "locks");
  await mkdir(busyLocks, { recursive: true });
  await writeFile(path.join(busyLocks, "toolchain-lifecycle.lock"), `${JSON.stringify({
    schema_version: "launchrally.dev/owned-lock/v1",
    name: "toolchain-lifecycle",
    token: "12345678-1234-4123-8123-123456789abc",
    owner_pid: process.pid,
  })}\n`);
  const busy = await runToolchainLifecycle(busyRepository, "0.2.2", {
    operation: "clean",
  });
  assert.equal(busy.error, "toolchain_lifecycle_busy");
});

test("recovery completes an adopted migration and its Report invalidation after interruption", async () => {
  const repository = await repositoryFixture();
  await writeProject(repository, "0.2.2");
  await materializeExactToolchain(repository, "0.2.2");
  const cachePath = path.join(repository, ".launchrally", "cache", "current-report.json");
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify({
    schema_version: "launchrally.dev/local-history-pointer/v1",
    report_id: "report-one",
    current: true,
  })}\n`);
  const transaction = path.join(repository, ".launchrally", ".toolchain-transaction");
  const toolchain = path.join(repository, ".launchrally", "toolchain");
  await mkdir(transaction);
  await writeFile(path.join(transaction, "transaction.json"), `${JSON.stringify({
    schema_version: "launchrally.dev/toolchain-transaction/v1",
    phase: "prepared",
    operation: "migrate",
    had_previous: true,
    previous_version: "0.2.2",
    version: "0.3.0",
  })}\n`);
  await rename(toolchain, path.join(transaction, "old"));
  await cp(await preparedToolchain("0.3.0"), toolchain, { recursive: true });

  const recovered = await runToolchainLifecycle(repository, "0.3.0", {
    operation: "restore",
  });

  assert.equal(recovered.outcome, "already_ready");
  assert.equal(recovered.authority.engine.version, "0.3.0");
  assert.equal(JSON.parse(await readFile(cachePath, "utf8")).currentness.status, "non_current");
  await assert.rejects(lstat(transaction), { code: "ENOENT" });
});

test("an approved restore cleans retained preparation if another invocation restored first", async () => {
  const repository = await repositoryFixture();
  await writeProject(repository);
  const staging = await mkdtemp(path.join(os.tmpdir(), "launchrally-toolchain-prepare-race-"));
  const temporaryTarget = path.join(staging, "toolchain");
  await mkdir(temporaryTarget);
  const permission = await runToolchainLifecycle(
    repository,
    "0.2.2",
    { operation: "restore" },
    { prepare_toolchain: async () => {
      const error = new Error("offline cache miss");
      error.code = "registry_permission_required";
      error.temporary_target = temporaryTarget;
      error.cleanup_path = staging;
      throw error;
    } },
  );
  await materializeExactToolchain(repository, "0.2.2");

  const restored = await runToolchainLifecycle(repository, "0.2.2", {
    operation: "restore",
    resume_token: permission.interaction.resume_token,
    permission_decisions: { npm_registry_read: "approved" },
  });

  assert.equal(restored.outcome, "already_ready");
  await assert.rejects(lstat(staging), { code: "ENOENT" });
});
