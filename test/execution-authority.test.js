import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertValidCliInteraction,
  assertValidExecutionAuthority,
} from "../packages/contracts/src/index.js";
import {
  EXECUTION_AUTHORITY_DESCRIPTOR_PATH,
  resolveExecutionAuthority,
} from "../packages/core/src/index.js";
import { writeExactToolchain } from "./helpers/exact-toolchain.js";

const execFileAsync = promisify(execFile);
const cli = path.resolve("packages/cli/bin/rally.js");
const currentVersion = JSON.parse(await readFile("package.json", "utf8")).version;

async function repositoryFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-authority-"));
  await mkdir(path.join(directory, ".git"));
  return directory;
}

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

async function writeConfirmedProject(repository, version = "0.3.2") {
  await mkdir(path.join(repository, ".launchrally"), { recursive: true });
  await writeFile(
    path.join(repository, ".launchrally", "manifest.yaml"),
    `${JSON.stringify(validManifest())}\n`,
  );
  await writeExactToolchain(repository, version);
  await writeFile(
    path.join(repository, EXECUTION_AUTHORITY_DESCRIPTOR_PATH),
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

async function writeLegacyProject(repository, version = "0.2.2") {
  await mkdir(path.join(repository, ".launchrally"), { recursive: true });
  await writeFile(
    path.join(repository, ".launchrally", "manifest.yaml"),
    `${JSON.stringify(validManifest())}\n`,
  );
  await writeExactToolchain(repository, version);
}

async function materializeEngine(repository, version = "0.3.2") {
  const lock = JSON.parse(await readFile(
    path.join(repository, ".launchrally/toolchain/package-lock.json"),
    "utf8",
  ));
  for (const [lockedPath, entry] of Object.entries(lock.packages)) {
    if (!lockedPath.startsWith("node_modules/")) continue;
    const name = lockedPath.slice("node_modules/".length);
    const packageDirectory = path.join(
      repository,
      ".launchrally",
      "toolchain",
      lockedPath,
    );
    await mkdir(packageDirectory, { recursive: true });
    const packageJson = {
      name,
      version: name === "@launchrally/cli" ? version : entry.version,
      type: "module",
      ...(entry.dependencies ? { dependencies: entry.dependencies } : {}),
      ...(name === "@launchrally/cli" ? {
        bin: { rally: "./bin/rally.js" },
        launchrally: {
          execution_authority: "launchrally.dev/execution-authority/v1",
          engine: "./bin/engine.js",
        },
      } : {}),
    };
    await writeFile(
      path.join(packageDirectory, "package.json"),
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
  }
  const cliDirectory = path.join(
    repository,
    ".launchrally/toolchain/node_modules/@launchrally/cli",
  );
  await mkdir(path.join(cliDirectory, "bin"), { recursive: true });
  await writeFile(path.join(cliDirectory, "bin", "rally.js"), "export {};\n");
  await writeFile(path.join(cliDirectory, "bin", "engine.js"), "export {};\n");
}

async function removeNativeEngineMarker(repository) {
  const cliPackagePath = path.join(
    repository,
    ".launchrally/toolchain/node_modules/@launchrally/cli/package.json",
  );
  const cliPackage = JSON.parse(await readFile(cliPackagePath, "utf8"));
  delete cliPackage.launchrally.engine;
  await writeFile(cliPackagePath, `${JSON.stringify(cliPackage, null, 2)}\n`);
}

async function writePreLauncherSplitProject(repository, version = "0.2.2") {
  await writeConfirmedProject(repository, version);
  await writeFile(
    path.join(repository, EXECUTION_AUTHORITY_DESCRIPTOR_PATH),
    `${JSON.stringify({
      contract: "launchrally.dev/execution-authority/v1",
      engine: {
        package: "@launchrally/cli",
        version,
        entrypoint: "bin/rally.js",
      },
    }, null, 2)}\n`,
  );
  await materializeEngine(repository, version);
  await removeNativeEngineMarker(repository);
}

test("an uninitialized repository uses the Launcher Engine", async () => {
  const repository = await repositoryFixture();

  const authority = await resolveExecutionAuthority({
    cwd: repository,
    launcher_version: "0.3.2",
  });

  assert.deepEqual(authority, {
    schema_version: "launchrally.dev/execution-authority/v1",
    state: "ready",
    source: "launcher",
    launcher_version: "0.3.2",
    engine: {
      package: "@launchrally/cli",
      version: "0.3.2",
      contract: "launchrally.dev/execution-authority/v1",
      compatibility: "native",
    },
    materialization: { state: "bundled" },
    reason: "launcher_selected",
    next_action: { operation: "none" },
  });
  assert.equal(assertValidExecutionAuthority(authority), true);
});

test("a partial LaunchRally project fails closed instead of using the Launcher Engine", async () => {
  const repository = await repositoryFixture();
  await mkdir(path.join(repository, ".launchrally"));

  const authority = await resolveExecutionAuthority({
    cwd: repository,
    launcher_version: "0.3.2",
  });

  assert.deepEqual(authority, {
    schema_version: "launchrally.dev/execution-authority/v1",
    state: "invalid_toolchain",
    source: "project_toolchain",
    launcher_version: "0.3.2",
    engine: {
      package: "@launchrally/cli",
      version: null,
      contract: null,
      compatibility: "incompatible",
    },
    materialization: { state: "invalid" },
    reason: "partial_project_state",
    next_action: { operation: "inspect_toolchain" },
  });
});

test("a valid project pin outranks a newer Launcher and requests explicit restore", async () => {
  const repository = await repositoryFixture();
  await writeConfirmedProject(repository, "0.3.2");

  const authority = await resolveExecutionAuthority({
    cwd: repository,
    launcher_version: "0.4.0",
  });

  assert.deepEqual(authority, {
    schema_version: "launchrally.dev/execution-authority/v1",
    state: "needs_toolchain_restore",
    source: "project_toolchain",
    launcher_version: "0.4.0",
    engine: {
      package: "@launchrally/cli",
      version: "0.3.2",
      contract: "launchrally.dev/execution-authority/v1",
      compatibility: "native",
    },
    materialization: { state: "missing" },
    reason: "materialization_missing",
    next_action: { operation: "toolchain_restore" },
  });
});

test("process cwd discovers a ready project Engine from a repository subdirectory", async () => {
  const repository = await repositoryFixture();
  const subdirectory = path.join(repository, "packages", "web");
  await mkdir(subdirectory, { recursive: true });
  await writeConfirmedProject(repository, "0.3.2");
  await materializeEngine(repository, "0.3.2");

  const authority = await resolveExecutionAuthority({
    launcher_version: "0.2.2",
    process_cwd: subdirectory,
  });

  assert.equal(authority.state, "ready");
  assert.equal(authority.source, "project_toolchain");
  assert.equal(authority.engine.version, "0.3.2");
  assert.equal(authority.materialization.state, "ready");
  assert.equal(authority.reason, "project_engine_validated");
  assert.equal(authority.selection.operation_cwd, subdirectory);
  const canonicalRepository = await realpath(repository);
  assert.equal(authority.selection.project_root, canonicalRepository);
  assert.equal(
    authority.selection.engine_entrypoint,
    path.join(
      canonicalRepository,
      ".launchrally/toolchain/node_modules/@launchrally/cli/bin/engine.js",
    ),
  );
  assert.equal(JSON.stringify(authority).includes(repository), false);
});

test("an incomplete installed dependency closure requires explicit restore", async () => {
  const repository = await repositoryFixture();
  await writeConfirmedProject(repository, "0.3.2");
  await materializeEngine(repository, "0.3.2");
  await rm(path.join(
    repository,
    ".launchrally/toolchain/node_modules/@launchrally/core",
  ), { recursive: true });

  const authority = await resolveExecutionAuthority({
    cwd: repository,
    launcher_version: "0.3.2",
  });

  assert.equal(authority.state, "needs_toolchain_restore");
  assert.equal(authority.materialization.state, "missing");
  assert.equal(authority.reason, "materialization_incomplete");
});

test("the allowlisted 0.2.2 legacy layout has explicit restore authority", async () => {
  const repository = await repositoryFixture();
  await writeLegacyProject(repository, "0.2.2");

  const authority = await resolveExecutionAuthority({
    cwd: repository,
    launcher_version: "0.3.2",
  });

  assert.equal(authority.state, "needs_toolchain_restore");
  assert.equal(authority.source, "project_toolchain");
  assert.equal(authority.engine.version, "0.2.2");
  assert.equal(authority.engine.compatibility, "legacy_adapter");
  assert.equal(authority.reason, "legacy_materialization_missing");
  assert.deepEqual(authority.next_action, { operation: "toolchain_restore" });
});

test("an existing v1 rally Engine descriptor remains a validated compatibility path", async () => {
  const repository = await repositoryFixture();
  await writePreLauncherSplitProject(repository);

  const authority = await resolveExecutionAuthority({
    cwd: repository,
    launcher_version: "0.3.2",
  });

  assert.equal(authority.state, "ready");
  assert.equal(authority.engine.compatibility, "legacy_adapter");
  assert.equal(authority.reason, "legacy_project_engine_validated");
  assert.equal(
    authority.selection.engine_entrypoint,
    path.join(
      await realpath(repository),
      ".launchrally/toolchain/node_modules/@launchrally/cli/bin/rally.js",
    ),
  );
});

test("a non-allowlisted v1 rally entrypoint cannot recurse through a native Launcher", async () => {
  const repository = await repositoryFixture();
  await writePreLauncherSplitProject(repository, "0.3.2");

  const authority = await resolveExecutionAuthority({
    cwd: repository,
    launcher_version: "0.2.2",
  });

  assert.equal(authority.state, "invalid_toolchain");
  assert.equal(authority.reason, "partial_project_state");
  assert.equal(authority.selection, undefined);
});

test("an allowlisted rally descriptor rejects a split Launcher materialization", async () => {
  const repository = await repositoryFixture();
  await writePreLauncherSplitProject(repository);
  const cliPackagePath = path.join(
    repository,
    ".launchrally/toolchain/node_modules/@launchrally/cli/package.json",
  );
  const cliPackage = JSON.parse(await readFile(cliPackagePath, "utf8"));
  cliPackage.launchrally.engine = "./bin/engine.js";
  await writeFile(cliPackagePath, `${JSON.stringify(cliPackage, null, 2)}\n`);

  const authority = await resolveExecutionAuthority({
    cwd: repository,
    launcher_version: "0.2.2",
  });

  assert.equal(authority.state, "invalid_toolchain");
  assert.equal(authority.reason, "invalid_engine_materialization");
  assert.equal(authority.selection, undefined);
});

test("a recognizable unsupported Engine contract requires explicit migration", async () => {
  const repository = await repositoryFixture();
  await writeConfirmedProject(repository, "0.3.2");
  await writeFile(
    path.join(repository, EXECUTION_AUTHORITY_DESCRIPTOR_PATH),
    `${JSON.stringify({
      contract: "launchrally.dev/execution-authority/v0",
      engine: {
        package: "@launchrally/cli",
        version: "0.3.2",
        entrypoint: "bin/engine.js",
      },
    })}\n`,
  );

  const authority = await resolveExecutionAuthority({
    cwd: repository,
    launcher_version: "0.4.0",
  });

  assert.deepEqual(authority, {
    schema_version: "launchrally.dev/execution-authority/v1",
    state: "needs_toolchain_migration",
    source: "project_toolchain",
    launcher_version: "0.4.0",
    engine: {
      package: "@launchrally/cli",
      version: "0.3.2",
      contract: "launchrally.dev/execution-authority/v0",
      compatibility: "migration_required",
    },
    materialization: { state: "migration_required" },
    reason: "unsupported_engine_contract",
    next_action: { operation: "toolchain_migrate" },
  });
});

test("structured version reports the effective Engine and separate Launcher authority", async () => {
  const repository = await repositoryFixture();

  const result = JSON.parse((await execFileAsync(process.execPath, [
    cli,
    "--version",
    "--json",
    "--cwd",
    repository,
  ])).stdout);

  assert.equal(result.contract, "launchrally.dev/cli/v2");
  assert.equal(result.status, "completed");
  assert.equal(result.operation, "version");
  assert.equal(result.cli_version, currentVersion);
  assert.equal(result.launcher_version, currentVersion);
  assert.equal(result.authority.schema_version, "launchrally.dev/execution-authority/v1");
  assert.equal(result.authority.source, "launcher");
  assert.equal(result.authority.materialization.state, "bundled");
});

test("a nested repository cannot inherit authority from its parent repository", async () => {
  const repository = await repositoryFixture();
  await writeConfirmedProject(repository, "0.3.2");
  await materializeEngine(repository, "0.3.2");
  const nested = path.join(repository, "examples", "standalone");
  await mkdir(path.join(nested, ".git"), { recursive: true });

  const authority = await resolveExecutionAuthority({
    cwd: nested,
    launcher_version: "0.2.2",
  });

  assert.equal(authority.source, "launcher");
  assert.equal(authority.engine.version, "0.2.2");
});

test("unknown legacy layouts stop instead of falling back", async () => {
  const repository = await repositoryFixture();
  await writeLegacyProject(repository, "0.2.1");

  const authority = await resolveExecutionAuthority({
    cwd: repository,
    launcher_version: "0.3.2",
  });

  assert.equal(authority.state, "invalid_toolchain");
  assert.equal(authority.reason, "unknown_legacy_toolchain");
  assert.equal(authority.engine.version, "0.2.1");
});

test("the legacy adapter validates an executable 0.2.2 materialization", async () => {
  const repository = await repositoryFixture();
  await writeLegacyProject(repository, "0.2.2");
  await materializeEngine(repository, "0.2.2");
  await removeNativeEngineMarker(repository);

  const authority = await resolveExecutionAuthority({
    cwd: repository,
    launcher_version: "0.3.2",
  });

  assert.equal(authority.state, "ready");
  assert.equal(authority.engine.compatibility, "legacy_adapter");
  assert.equal(authority.reason, "legacy_project_engine_validated");
});

test("toolchain lock corruption invalidates project authority", async () => {
  const repository = await repositoryFixture();
  await writeConfirmedProject(repository, "0.3.2");
  const lockPath = path.join(repository, ".launchrally/toolchain/package-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.packages["node_modules/@launchrally/cli"].integrity = "sha512-invalid";
  await writeFile(lockPath, `${JSON.stringify(lock)}\n`);

  const authority = await resolveExecutionAuthority({
    cwd: repository,
    launcher_version: "0.3.2",
  });

  assert.equal(authority.state, "invalid_toolchain");
  assert.equal(authority.reason, "invalid_toolchain_lock");
});

test("transaction recovery and inconsistent installed identity fail closed", async () => {
  const recoveringRepository = await repositoryFixture();
  await writeConfirmedProject(recoveringRepository, "0.3.2");
  await mkdir(path.join(
    recoveringRepository,
    ".launchrally",
    ".init-transaction",
  ));
  const recovering = await resolveExecutionAuthority({
    cwd: recoveringRepository,
    launcher_version: "0.3.2",
  });
  assert.equal(recovering.state, "invalid_toolchain");
  assert.equal(recovering.reason, "transaction_recovery_required");

  const inconsistentRepository = await repositoryFixture();
  await writeConfirmedProject(inconsistentRepository, "0.3.2");
  await materializeEngine(inconsistentRepository, "0.4.0");
  const inconsistent = await resolveExecutionAuthority({
    cwd: inconsistentRepository,
    launcher_version: "0.3.2",
  });
  assert.equal(inconsistent.state, "invalid_toolchain");
  assert.equal(inconsistent.reason, "invalid_engine_materialization");
});

test("symlinked authority files and path-escaping toolchains fail closed", async () => {
  const descriptorRepository = await repositoryFixture();
  await writeConfirmedProject(descriptorRepository, "0.3.2");
  const outside = await mkdtemp(path.join(os.tmpdir(), "launchrally-authority-outside-"));
  const outsideDescriptor = path.join(outside, "authority.json");
  await writeFile(outsideDescriptor, "{}\n");
  const descriptorPath = path.join(
    descriptorRepository,
    EXECUTION_AUTHORITY_DESCRIPTOR_PATH,
  );
  await rm(descriptorPath);
  await symlink(outsideDescriptor, descriptorPath);

  const descriptorAuthority = await resolveExecutionAuthority({
    cwd: descriptorRepository,
    launcher_version: "0.3.2",
  });
  assert.equal(descriptorAuthority.state, "invalid_toolchain");
  assert.equal(descriptorAuthority.reason, "unsafe_project_path");

  const toolchainRepository = await repositoryFixture();
  await mkdir(path.join(toolchainRepository, ".launchrally"));
  await writeFile(
    path.join(toolchainRepository, ".launchrally", "manifest.yaml"),
    `${JSON.stringify(validManifest())}\n`,
  );
  await symlink(outside, path.join(toolchainRepository, ".launchrally", "toolchain"));

  const toolchainAuthority = await resolveExecutionAuthority({
    cwd: toolchainRepository,
    launcher_version: "0.3.2",
  });
  assert.equal(toolchainAuthority.state, "invalid_toolchain");
  assert.equal(toolchainAuthority.reason, "unsafe_project_path");
});

test("version failure states are structured, non-zero, and omit cli_version", async () => {
  const restoreRepository = await repositoryFixture();
  await writeConfirmedProject(restoreRepository, "0.3.2");
  let restoreFailure;
  await assert.rejects(
    execFileAsync(process.execPath, [
      cli,
      "--version",
      "--json",
      "--cwd",
      restoreRepository,
    ]),
    (error) => {
      restoreFailure = error;
      return error.code === 1;
    },
  );
  const restore = JSON.parse(restoreFailure.stdout);
  assert.equal(restore.status, "unavailable");
  assert.equal(restore.authority.state, "needs_toolchain_restore");
  assert.equal(Object.hasOwn(restore, "cli_version"), false);
  assert.equal(assertValidCliInteraction(restore), true);

  const migrationRepository = await repositoryFixture();
  await writeConfirmedProject(migrationRepository, "0.3.2");
  await writeFile(
    path.join(migrationRepository, EXECUTION_AUTHORITY_DESCRIPTOR_PATH),
    `${JSON.stringify({
      contract: "launchrally.dev/execution-authority/v0",
      engine: {
        package: "@launchrally/cli",
        version: "0.3.2",
        entrypoint: "bin/engine.js",
      },
    })}\n`,
  );
  let migrationFailure;
  await assert.rejects(
    execFileAsync(process.execPath, [
      cli,
      "--version",
      "--json",
      "--cwd",
      migrationRepository,
    ]),
    (error) => {
      migrationFailure = error;
      return error.code === 1;
    },
  );
  const migration = JSON.parse(migrationFailure.stdout);
  assert.equal(migration.status, "unavailable");
  assert.equal(migration.authority.state, "needs_toolchain_migration");
  assert.equal(Object.hasOwn(migration, "cli_version"), false);
  assert.equal(assertValidCliInteraction(migration), true);

  const invalidRepository = await repositoryFixture();
  await mkdir(path.join(invalidRepository, ".launchrally"));
  let invalidFailure;
  await assert.rejects(
    execFileAsync(process.execPath, [
      cli,
      "--version",
      "--json",
      "--cwd",
      invalidRepository,
    ]),
    (error) => {
      invalidFailure = error;
      return error.code === 1;
    },
  );
  const invalid = JSON.parse(invalidFailure.stdout);
  assert.equal(invalid.status, "execution_error");
  assert.equal(invalid.authority.state, "invalid_toolchain");
  assert.equal(Object.hasOwn(invalid, "cli_version"), false);
  assert.equal(assertValidCliInteraction(invalid), true);
});
