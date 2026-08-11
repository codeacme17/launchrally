import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { TOOLCHAIN_LIFECYCLE_CONTRACT } from "@launchrally/contracts";

import {
  resolveExecutionAuthority,
  validateToolchainDirectory,
} from "./execution-authority.js";
import { acquireOwnedLock } from "./exclusive-lock.js";
import {
  emptyToolchainLockfileContent,
  isOfflineResolutionMiss,
  npmExecFileCommand,
  toolchainAuthorityContent,
  toolchainInstallArguments,
  toolchainPackageContent,
} from "./initialization.js";

const execFileAsync = promisify(execFile);
const TRANSACTION_PATH = ".launchrally/.toolchain-transaction";
const STATE_SCHEMA = "launchrally.dev/toolchain-lifecycle-state/v1";
const REGISTRY_PERMISSION_CAPABILITY = Symbol("npm_registry_read");
const REGISTRY_STAGING_CAPABILITY = Symbol("npm_registry_staging");
const EXACT_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;

async function storeState(state) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-toolchain-state-"));
  const secret = randomBytes(32).toString("base64url");
  const content = `${JSON.stringify(state)}\n`;
  const checksum = createHash("sha256").update(content).digest("base64url");
  await writeFile(path.join(directory, `${secret}.json`), content, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return `lrtc_${path.basename(directory).slice("launchrally-toolchain-state-".length)}_${secret}_${checksum}`;
}

async function loadState(token) {
  const match = typeof token === "string"
    ? token.match(/^lrtc_([A-Za-z0-9]{6}|[A-Za-z0-9]{12})_([A-Za-z0-9_-]{43})_([A-Za-z0-9_-]{43})$/u)
    : null;
  if (!match) return null;
  const statePath = path.join(
    os.tmpdir(),
    `launchrally-toolchain-state-${match[1]}`,
    `${match[2]}.json`,
  );
  try {
    const content = await readFile(statePath, "utf8");
    if (createHash("sha256").update(content).digest("base64url") !== match[3]) return null;
    const state = JSON.parse(content);
    return state?.schema_version === STATE_SCHEMA ? { state, statePath } : null;
  } catch {
    return null;
  }
}

async function discardState(statePath, cleanupPath = null) {
  if (statePath) await rm(path.dirname(statePath), { recursive: true, force: true });
  if (cleanupPath && isOwnedPreparationPath(cleanupPath)) {
    await rm(cleanupPath, { recursive: true, force: true });
  }
}

function isOwnedPreparationPath(candidate) {
  if (typeof candidate !== "string") return false;
  const selected = path.resolve(candidate);
  return path.dirname(selected) === path.resolve(os.tmpdir())
    && [
      "launchrally-toolchain-prepare-",
      "launchrally-dependency-plan-",
    ].some((prefix) => path.basename(selected).startsWith(prefix));
}

async function cleanStoredLifecycleStates(root) {
  const candidates = await readdir(os.tmpdir(), { withFileTypes: true });
  for (const candidate of candidates) {
    if (
      !candidate.isDirectory()
      || ![
        "launchrally-toolchain-state-",
        "launchrally-init-preview-",
      ].some((prefix) => candidate.name.startsWith(prefix))
    ) {
      continue;
    }
    const directory = path.join(os.tmpdir(), candidate.name);
    let state;
    let statePath;
    try {
      const files = await readdir(directory);
      const stateFile = files.find((file) => file.endsWith(".json"));
      if (!stateFile) continue;
      statePath = path.join(directory, stateFile);
      state = JSON.parse(await readFile(statePath, "utf8"));
    } catch {
      // Ignore unrelated or malformed temporary directories.
      continue;
    }
    if (
      ![STATE_SCHEMA, "launchrally.dev/init-interaction/v2"].includes(state?.schema_version)
      || state.root !== root
    ) continue;
    await discardState(statePath, state.cleanup_path);
  }
}

function registryPermission(operation, version, temporaryTarget, resumeToken) {
  const npmArguments = operation === "restore"
    ? [
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
    ]
    : toolchainInstallArguments(version, true);
  return {
    contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
    status: "needs_permission",
    operation: `toolchain_${operation}`,
    interaction: {
      schema_version: STATE_SCHEMA,
      resume_token: resumeToken,
    },
    request: {
      type: "permission",
      permissions: [{
        id: "npm_registry_read",
        boundary: "public_network",
        source: "https://registry.npmjs.org",
        package: "@launchrally/cli",
        version,
        temporary_target: temporaryTarget,
        commands: [{ executable: "npm", arguments: npmArguments, shell: false }],
      }],
    },
  };
}

async function optionalStat(candidate) {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function sameFile(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

async function runLifecycleLocked(root, operation, callback) {
  let release;
  try {
    if (!await optionalStat(path.join(root, ".launchrally"))) return await callback();
    release = await acquireOwnedLock(
      path.join(root, ".launchrally", "locks"),
      "toolchain-lifecycle",
    );
    return await callback();
  } catch (error) {
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "execution_error",
      operation: `toolchain_${operation}`,
      error: error?.code === "owned_lock_busy"
        ? "toolchain_lifecycle_busy"
        : error?.code === "invalid_owned_lock"
          ? "invalid_toolchain_lifecycle_lock"
          : error?.code ?? "toolchain_lifecycle_failed",
      message: "The Project Toolchain lifecycle lock could not be acquired safely.",
      recoverable: true,
    };
  } finally {
    await release?.();
  }
}

async function recoverToolchainTransaction(root) {
  const transaction = path.join(root, TRANSACTION_PATH);
  const stat = await optionalStat(transaction);
  if (!stat) return { recovered: false };
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    const error = new Error("The Project Toolchain transaction path is unsafe.");
    error.code = "invalid_toolchain_transaction";
    throw error;
  }
  let journal;
  try {
    journal = JSON.parse(await readFile(path.join(transaction, "transaction.json"), "utf8"));
  } catch {
    const error = new Error("The Project Toolchain transaction journal is invalid.");
    error.code = "invalid_toolchain_transaction";
    throw error;
  }
  if (
    journal?.schema_version !== "launchrally.dev/toolchain-transaction/v1"
    || journal.phase !== "prepared"
    || !["migrate", "restore"].includes(journal.operation)
    || typeof journal.had_previous !== "boolean"
    || !EXACT_VERSION.test(journal.previous_version ?? "")
    || !EXACT_VERSION.test(journal.version ?? "")
    || JSON.stringify(Object.keys(journal).sort()) !== JSON.stringify([
      "had_previous",
      "operation",
      "phase",
      "previous_version",
      "schema_version",
      "version",
    ])
  ) {
    const error = new Error("The Project Toolchain transaction journal is invalid.");
    error.code = "invalid_toolchain_transaction";
    throw error;
  }
  const toolchain = path.join(root, ".launchrally", "toolchain");
  const target = journal.operation === "restore"
    ? path.join(toolchain, "node_modules")
    : toolchain;
  const previous = path.join(transaction, "old");
  const next = path.join(transaction, "new");
  const [targetStat, previousStat, nextStat] = await Promise.all([
    optionalStat(target),
    optionalStat(previous),
    optionalStat(next),
  ]);
  if (previousStat) {
    if (!previousStat.isDirectory() || previousStat.isSymbolicLink()) {
      const error = new Error("The prior Project Toolchain transaction state is unsafe.");
      error.code = "invalid_toolchain_transaction";
      throw error;
    }
    if (targetStat && !nextStat) {
      const adopted = await validateToolchainDirectory(toolchain);
      if (!adopted.valid || adopted.version !== journal.version) {
        const error = new Error("The adopted Project Toolchain transaction state is invalid.");
        error.code = "invalid_toolchain_transaction";
        throw error;
      }
      if (journal.operation === "migrate") {
        await markCurrentReportNonCurrent(
          root,
          journal.previous_version,
          journal.version,
        );
      }
      await rm(transaction, { recursive: true, force: true });
      return { recovered: true, action: "completed_adoption" };
    }
    if (!targetStat && nextStat) {
      await rename(previous, target);
      await rm(transaction, { recursive: true, force: true });
      return { recovered: true, action: "rolled_back" };
    }
    const error = new Error("The Project Toolchain transaction state is inconsistent.");
    error.code = "invalid_toolchain_transaction";
    throw error;
  }
  if (targetStat && nextStat && journal.had_previous) {
    await rm(transaction, { recursive: true, force: true });
    return { recovered: true, action: "discarded_prepared" };
  }
  if (!journal.had_previous && nextStat) {
    if (targetStat) {
      const error = new Error("The Project Toolchain transaction target appeared unexpectedly.");
      error.code = "invalid_toolchain_transaction";
      throw error;
    }
    await rm(transaction, { recursive: true, force: true });
    return { recovered: true, action: "discarded_prepared" };
  }
  if (!journal.had_previous && targetStat && !nextStat) {
    await rm(transaction, { recursive: true, force: true });
    return { recovered: true, action: "completed_adoption" };
  }
  const error = new Error("The Project Toolchain transaction cannot be recovered safely.");
  error.code = "invalid_toolchain_transaction";
  throw error;
}

async function defaultPrepareToolchain(request) {
  const stagingRoot = request.staging_path
    ?? await mkdtemp(path.join(os.tmpdir(), "launchrally-toolchain-prepare-"));
  const toolchainPath = path.join(stagingRoot, "toolchain");
  try {
    await mkdir(toolchainPath, { recursive: request.staging_path !== undefined });
    await writeFile(path.join(toolchainPath, "package.json"), request.package_json, "utf8");
    await writeFile(path.join(toolchainPath, "package-lock.json"), request.lockfile, "utf8");
    if (request.authority_descriptor !== null) {
      await writeFile(
        path.join(toolchainPath, "authority.json"),
        request.authority_descriptor,
        "utf8",
      );
    }
    const npmArguments = request.operation === "migrate"
      ? toolchainInstallArguments(request.version, request.registry_allowed)
      : [
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        ...(request.registry_allowed
          ? ["--registry=https://registry.npmjs.org"]
          : ["--offline"]),
      ];
    const npmCommand = npmExecFileCommand(npmArguments);
    await execFileAsync(npmCommand.executable, npmCommand.arguments, {
      cwd: toolchainPath,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      shell: npmCommand.shell,
    });
    return { toolchain_path: toolchainPath, cleanup_path: stagingRoot };
  } catch (error) {
    error.temporary_target = toolchainPath;
    if (!request.registry_allowed && isOfflineResolutionMiss(error)) {
      error.code = "registry_permission_required";
      error.cleanup_path = stagingRoot;
    } else {
      await rm(stagingRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

async function adoptToolchain(root, stagedToolchain, {
  after_adopt: afterAdopt,
  materialization_only: materializationOnly = false,
  previous_version: previousVersion,
} = {}) {
  const launchRally = path.join(root, ".launchrally");
  const toolchain = path.join(launchRally, "toolchain");
  const target = materializationOnly ? path.join(toolchain, "node_modules") : toolchain;
  const stagedTarget = materializationOnly
    ? path.join(stagedToolchain, "node_modules")
    : stagedToolchain;
  const transaction = path.join(root, TRANSACTION_PATH);
  const next = path.join(transaction, "new");
  const previous = path.join(transaction, "old");
  if (await optionalStat(transaction)) {
    const error = new Error("A Project Toolchain transaction requires recovery.");
    error.code = "toolchain_recovery_required";
    throw error;
  }
  const validation = await validateToolchainDirectory(stagedToolchain);
  if (!validation.valid) {
    const error = new Error("The prepared Project Toolchain is invalid.");
    error.code = "invalid_prepared_toolchain";
    throw error;
  }
  let movedPrevious = false;
  let adoptedNext = false;
  let transactionCreated = false;
  let adoptedStat = null;
  let rollbackAfterAdopt = null;
  const previousStat = await optionalStat(target);
  try {
    await mkdir(transaction, { recursive: false });
    transactionCreated = true;
    await cp(stagedTarget, next, { recursive: true, errorOnExist: true });
    await writeFile(
      path.join(transaction, "transaction.json"),
      `${JSON.stringify({
        schema_version: "launchrally.dev/toolchain-transaction/v1",
        phase: "prepared",
        operation: materializationOnly ? "restore" : "migrate",
        had_previous: previousStat !== null,
        previous_version: previousVersion ?? validation.version,
        version: validation.version,
      })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    if (previousStat) {
      await rename(target, previous);
      movedPrevious = true;
    }
    await rename(next, target);
    adoptedNext = true;
    adoptedStat = await lstat(target);
    const adopted = await validateToolchainDirectory(toolchain);
    if (!adopted.valid) {
      const error = new Error("The adopted Project Toolchain failed validation.");
      error.code = "invalid_adopted_toolchain";
      throw error;
    }
    rollbackAfterAdopt = await afterAdopt?.();
    await rm(transaction, { recursive: true, force: true });
    return adopted;
  } catch (error) {
    let rolledBack = true;
    if (rollbackAfterAdopt) {
      try {
        await rollbackAfterAdopt();
      } catch {
        rolledBack = false;
      }
    }
    if (adoptedNext) {
      try {
        const current = await lstat(target);
        if (!sameFile(current, adoptedStat)) rolledBack = false;
        else await rm(target, { recursive: true, force: true });
      } catch (rollbackError) {
        if (rollbackError?.code !== "ENOENT") rolledBack = false;
      }
    }
    if (movedPrevious) {
      try {
        await rename(previous, target);
      } catch {
        rolledBack = false;
      }
    }
    if (transactionCreated && rolledBack) {
      await rm(transaction, { recursive: true, force: true }).catch(() => {});
    }
    if (!rolledBack) error.code = "toolchain_recovery_required";
    throw error;
  }
}

async function restoreToolchain(root, launcherVersion, options, dependencies) {
  try {
    await recoverToolchainTransaction(root);
  } catch (error) {
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "execution_error",
      operation: "toolchain_restore",
      error: error.code,
      message: "The pending Project Toolchain transaction could not be recovered safely.",
    };
  }
  const authority = await resolveExecutionAuthority({
    cwd: root,
    launcher_version: launcherVersion,
  });
  if (authority.source !== "project_toolchain") {
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "unavailable",
      operation: "toolchain_restore",
      error: "project_toolchain_not_initialized",
      authority,
      message: "Restore requires an initialized Project Toolchain.",
    };
  }
  if (authority.state === "ready") {
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "completed",
      operation: "toolchain_restore",
      outcome: "already_ready",
      authority,
    };
  }
  if (authority.state !== "needs_toolchain_restore") {
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "execution_error",
      operation: "toolchain_restore",
      error: authority.state,
      authority,
      message: "Restore refuses to replace invalid or migration-required authority.",
    };
  }
  const toolchain = path.join(root, ".launchrally", "toolchain");
  const request = {
    operation: "restore",
    root,
    version: authority.engine.version,
    package_json: await readFile(path.join(toolchain, "package.json"), "utf8"),
    lockfile: await readFile(path.join(toolchain, "package-lock.json"), "utf8"),
    authority_descriptor: await readFile(path.join(toolchain, "authority.json"), "utf8")
      .catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error)),
    registry_allowed: options[REGISTRY_PERMISSION_CAPABILITY] === true,
    staging_path: options[REGISTRY_STAGING_CAPABILITY],
  };
  const prepare = dependencies.prepare_toolchain ?? defaultPrepareToolchain;
  let prepared;
  try {
    prepared = await prepare(request);
    await adoptToolchain(root, prepared.toolchain_path, {
      materialization_only: true,
      previous_version: authority.engine.version,
    });
  } catch (error) {
    if (error?.code === "registry_permission_required" && !request.registry_allowed) {
      const state = {
        schema_version: STATE_SCHEMA,
        kind: "registry_permission",
        operation: "restore",
        root,
        version: authority.engine.version,
        temporary_target: error.temporary_target,
        cleanup_path: error.cleanup_path
          ?? (error.temporary_target ? path.dirname(error.temporary_target) : null),
      };
      if (!state.temporary_target) {
        return {
          contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
          status: "execution_error",
          operation: "toolchain_restore",
          error: "invalid_registry_permission_boundary",
          authority,
          message: "The offline miss did not identify an exact temporary target.",
        };
      }
      return registryPermission(
        "restore",
        state.version,
        state.temporary_target,
        await (dependencies.store_state ?? storeState)(state),
      );
    }
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "execution_error",
      operation: "toolchain_restore",
      error: error?.code ?? "toolchain_restore_failed",
      authority,
      message: "The exact Project Toolchain could not be restored; the prior authority was preserved.",
      recoverable: true,
    };
  } finally {
    if (prepared?.cleanup_path) {
      await rm(prepared.cleanup_path, { recursive: true, force: true }).catch(() => {});
    }
  }
  const restoredAuthority = await resolveExecutionAuthority({
    cwd: root,
    launcher_version: launcherVersion,
  });
  return {
    contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
    status: "completed",
    operation: "toolchain_restore",
    outcome: "restored",
    authority: restoredAuthority,
  };
}

function digest(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function materializationSummary(prepared) {
  if (prepared.materialization) return {
    ...prepared.materialization,
    target: ".launchrally/toolchain/node_modules",
    ignored: true,
    authoritative: false,
  };
  const lock = JSON.parse(await readFile(
    path.join(prepared.toolchain_path, "package-lock.json"),
    "utf8",
  ));
  const packages = Object.entries(lock.packages ?? {})
    .filter(([lockedPath]) => lockedPath.startsWith("node_modules/"));
  const integrity = packages
    .map(([lockedPath, entry]) => `${lockedPath}:${entry.integrity ?? ""}`)
    .sort()
    .join("\n");
  return {
    package_count: packages.length,
    integrity_digest: digest(integrity),
    target: ".launchrally/toolchain/node_modules",
    ignored: true,
    authoritative: false,
  };
}

async function authoritativePreview(root, stagedToolchain) {
  const changes = [];
  for (const name of ["package.json", "package-lock.json", "authority.json"]) {
    const target = path.join(root, ".launchrally", "toolchain", name);
    const staged = path.join(stagedToolchain, name);
    const before = await readFile(target, "utf8").catch((error) =>
      error?.code === "ENOENT" ? null : Promise.reject(error));
    const after = await readFile(staged, "utf8").catch((error) =>
      error?.code === "ENOENT" ? null : Promise.reject(error));
    if (before === after) continue;
    changes.push({
      path: `.launchrally/toolchain/${name}`,
      operation: before === null ? "create" : after === null ? "delete" : "update",
      before,
      after,
      before_digest: before === null ? null : digest(before),
      after_digest: after === null ? null : digest(after),
    });
  }
  return changes;
}

async function authoritativePreviewIsCurrent(root, changes) {
  for (const change of changes) {
    const current = await readFile(path.join(root, change.path), "utf8").catch((error) =>
      error?.code === "ENOENT" ? null : Promise.reject(error));
    if (current !== change.before) return false;
  }
  return true;
}

async function markCurrentReportNonCurrent(root, previousVersion, currentVersion) {
  const target = path.join(root, ".launchrally", "cache", "current-report.json");
  let pointer;
  let originalContent;
  try {
    originalContent = await readFile(target, "utf8");
    pointer = JSON.parse(originalContent);
  } catch (error) {
    if (error?.code === "ENOENT") return async () => {};
    throw error;
  }
  const temporary = `${target}.tmp-${randomBytes(16).toString("hex")}`;
  try {
    await writeFile(temporary, `${JSON.stringify({
      ...pointer,
      current: false,
      currentness: {
        status: "non_current",
        reasons: [{
          reason_code: "execution_authority_changed",
          previous_version: previousVersion,
          current_version: currentVersion,
        }],
      },
    })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  const adopted = await lstat(target);
  return async () => {
    const current = await lstat(target);
    if (!sameFile(current, adopted)) {
      const error = new Error("The current Report pointer changed during rollback.");
      error.code = "toolchain_recovery_required";
      throw error;
    }
    const rollbackTemporary = `${target}.rollback-${randomBytes(16).toString("hex")}`;
    try {
      await writeFile(rollbackTemporary, originalContent, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(rollbackTemporary, target);
    } catch (error) {
      await rm(rollbackTemporary, { force: true }).catch(() => {});
      throw error;
    }
  };
}

async function migrateToolchain(root, launcherVersion, options, dependencies) {
  const targetVersion = options.to;
  if (!EXACT_VERSION.test(targetVersion ?? "")) {
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "execution_error",
      operation: "toolchain_migrate",
      error: "exact_version_required",
      message: "Migrate requires --to with an exact SemVer.",
    };
  }
  if (![launcherVersion, "0.2.2"].includes(targetVersion)) {
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "execution_error",
      operation: "toolchain_migrate",
      error: "unsupported_toolchain_version",
      message: "The Launcher does not support the requested exact Engine version.",
    };
  }
  try {
    await recoverToolchainTransaction(root);
  } catch (error) {
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "execution_error",
      operation: "toolchain_migrate",
      error: error.code,
      message: "The pending Project Toolchain transaction could not be recovered safely.",
    };
  }
  const authority = await resolveExecutionAuthority({
    cwd: root,
    launcher_version: launcherVersion,
  });
  if (authority.source !== "project_toolchain") {
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "unavailable",
      operation: "toolchain_migrate",
      error: "project_toolchain_not_initialized",
      authority,
      message: "Migrate requires an initialized Project Toolchain.",
    };
  }
  if (authority.state === "invalid_toolchain") {
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "execution_error",
      operation: "toolchain_migrate",
      error: authority.state,
      authority,
      message: "Migrate refuses invalid Project Toolchain authority.",
    };
  }
  if (authority.engine.version === targetVersion) {
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "completed",
      operation: "toolchain_migrate",
      outcome: "already_pinned",
      authority,
    };
  }
  const request = {
    operation: "migrate",
    root,
    version: targetVersion,
    package_json: toolchainPackageContent(targetVersion),
    lockfile: emptyToolchainLockfileContent(),
    authority_descriptor: targetVersion === "0.2.2"
      ? null
      : toolchainAuthorityContent(targetVersion),
    registry_allowed: options[REGISTRY_PERMISSION_CAPABILITY] === true,
    staging_path: options[REGISTRY_STAGING_CAPABILITY],
  };
  const prepare = dependencies.prepare_toolchain ?? defaultPrepareToolchain;
  let prepared;
  try {
    prepared = await prepare(request);
    const validation = await validateToolchainDirectory(prepared.toolchain_path);
    if (!validation.valid || validation.version !== targetVersion) {
      const error = new Error("The prepared migration does not match --to.");
      error.code = "invalid_prepared_toolchain";
      throw error;
    }
  } catch (error) {
    if (error?.code === "registry_permission_required" && !request.registry_allowed) {
      const state = {
        schema_version: STATE_SCHEMA,
        kind: "registry_permission",
        operation: "migrate",
        root,
        version: targetVersion,
        temporary_target: error.temporary_target,
        cleanup_path: error.cleanup_path
          ?? (error.temporary_target ? path.dirname(error.temporary_target) : null),
      };
      if (!state.temporary_target) {
        return {
          contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
          status: "execution_error",
          operation: "toolchain_migrate",
          error: "invalid_registry_permission_boundary",
          authority,
          message: "The offline miss did not identify an exact temporary target.",
        };
      }
      return registryPermission(
        "migrate",
        targetVersion,
        state.temporary_target,
        await (dependencies.store_state ?? storeState)(state),
      );
    }
    if (prepared?.cleanup_path) {
      await rm(prepared.cleanup_path, { recursive: true, force: true }).catch(() => {});
    }
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "execution_error",
      operation: "toolchain_migrate",
      error: error?.code ?? "toolchain_migration_prepare_failed",
      authority,
      message: "The requested exact Project Toolchain could not be prepared.",
      recoverable: true,
    };
  }
  const changes = await authoritativePreview(root, prepared.toolchain_path);
  const state = {
    schema_version: STATE_SCHEMA,
    kind: "migration_confirmation",
    operation: "migrate",
    root,
    from_version: authority.engine.version,
    to_version: targetVersion,
    toolchain_path: prepared.toolchain_path,
    cleanup_path: prepared.cleanup_path ?? null,
    changes,
  };
  return {
    contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
    status: "needs_confirmation",
    operation: "toolchain_migrate",
    preview: {
      from_version: authority.engine.version,
      to_version: targetVersion,
      changes,
      materialization: await materializationSummary(prepared),
    },
    interaction: {
      schema_version: STATE_SCHEMA,
      resume_token: await (dependencies.store_state ?? storeState)(state),
    },
    request: {
      type: "confirmation",
      prompt: `Replace the complete Project Toolchain pin with @launchrally/cli@${targetVersion}?`,
      choices: ["confirm", "decline"],
    },
  };
}

async function resumeLifecycle(root, launcherVersion, options, dependencies) {
  const stored = await (dependencies.load_state ?? loadState)(options.resume_token);
  if (!stored) {
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "execution_error",
      operation: `toolchain_${options.operation ?? "unknown"}`,
      error: "invalid_resume_token",
      message: "The Project Toolchain lifecycle token is invalid or corrupted.",
    };
  }
  const { state, statePath } = stored;
  if (
    state.root !== root
    || state.operation !== options.operation
    || !["registry_permission", "migration_confirmation"].includes(state.kind)
  ) {
    await discardState(statePath, state.cleanup_path);
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "execution_error",
      operation: `toolchain_${options.operation ?? "unknown"}`,
      error: "resume_scope_mismatch",
      message: "The lifecycle token belongs to a different repository or operation.",
    };
  }
  if (state.kind === "registry_permission") {
    const decision = options.permission_decisions?.npm_registry_read;
    if (decision === "denied") {
      await discardState(statePath, state.cleanup_path);
      return {
        contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
        status: "execution_error",
        operation: `toolchain_${state.operation}`,
        error: "registry_permission_denied",
        message: "The npm registry read was denied; project authority was unchanged.",
        recoverable: true,
      };
    }
    if (decision !== "approved") {
      return {
        contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
        status: "execution_error",
        operation: `toolchain_${state.operation}`,
        error: "invalid_permission_decision",
        message: "The npm registry decision must be approved or denied.",
      };
    }
    await discardState(statePath);
    const resumedOptions = {
      ...options,
      resume_token: undefined,
      [REGISTRY_PERMISSION_CAPABILITY]: true,
      [REGISTRY_STAGING_CAPABILITY]: state.cleanup_path,
      ...(state.operation === "migrate" ? { to: state.version } : {}),
    };
    let result;
    try {
      result = state.operation === "restore"
        ? await restoreToolchain(root, launcherVersion, resumedOptions, dependencies)
        : await migrateToolchain(root, launcherVersion, resumedOptions, dependencies);
      return result;
    } finally {
      if (result?.status !== "needs_confirmation") {
        await discardState(null, state.cleanup_path);
      }
    }
  }
  if (state.to_version !== options.to || !EXACT_VERSION.test(state.to_version)) {
    await discardState(statePath, state.cleanup_path);
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "execution_error",
      operation: "toolchain_migrate",
      error: "resume_scope_mismatch",
      message: "The migration token does not match --to.",
    };
  }
  if (options.confirmation === "decline") {
    await discardState(statePath, state.cleanup_path);
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "completed",
      operation: "toolchain_migrate",
      outcome: "migration_declined",
      changes_applied: [],
    };
  }
  if (options.confirmation !== "confirm") {
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "execution_error",
      operation: "toolchain_migrate",
      error: "invalid_confirmation",
      message: "The migration confirmation must be confirm or decline.",
    };
  }
  const current = await resolveExecutionAuthority({
    cwd: root,
    launcher_version: launcherVersion,
  });
  if (
    current.engine.version !== state.from_version
    || current.state === "invalid_toolchain"
    || !Array.isArray(state.changes)
    || !await authoritativePreviewIsCurrent(root, state.changes)
  ) {
    await discardState(statePath, state.cleanup_path);
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "execution_error",
      operation: "toolchain_migrate",
      error: "preview_stale",
      authority: current,
      message: "Project authority changed after the migration preview.",
    };
  }
  try {
    await adoptToolchain(root, state.toolchain_path, {
      previous_version: state.from_version,
      after_adopt: () => markCurrentReportNonCurrent(
        root,
        state.from_version,
        state.to_version,
      ),
    });
  } catch (error) {
    await discardState(statePath, state.cleanup_path);
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "execution_error",
      operation: "toolchain_migrate",
      error: error?.code ?? "toolchain_migration_failed",
      message: "Migration failed and prior project authority was preserved.",
      recoverable: true,
    };
  }
  await discardState(statePath, state.cleanup_path);
  const authority = await resolveExecutionAuthority({
    cwd: root,
    launcher_version: launcherVersion,
  });
  return {
    contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
    status: "completed",
    operation: "toolchain_migrate",
    outcome: "migrated",
    authority,
    next_action: {
      operation: "verify",
      scope: "full",
      reason: "execution_authority_changed",
    },
  };
}

async function cleanToolchain(root, launcherVersion) {
  try {
    await recoverToolchainTransaction(root);
  } catch (error) {
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "execution_error",
      operation: "toolchain_clean",
      error: error.code,
      message: "The pending Project Toolchain transaction could not be recovered safely.",
    };
  }
  const authority = await resolveExecutionAuthority({
    cwd: root,
    launcher_version: launcherVersion,
  });
  if (authority.source !== "project_toolchain") {
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "unavailable",
      operation: "toolchain_clean",
      error: "project_toolchain_not_initialized",
      authority,
      message: "Clean requires an initialized Project Toolchain.",
    };
  }
  if (authority.state === "invalid_toolchain") {
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "execution_error",
      operation: "toolchain_clean",
      error: authority.state,
      authority,
      message: "Clean refuses invalid Project Toolchain authority.",
    };
  }
  await rm(path.join(root, ".launchrally", "toolchain", "node_modules"), {
    recursive: true,
    force: true,
  });
  await rm(path.join(root, TRANSACTION_PATH), { recursive: true, force: true });
  await cleanStoredLifecycleStates(root);
  const cleanedAuthority = await resolveExecutionAuthority({
    cwd: root,
    launcher_version: launcherVersion,
  });
  return {
    contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
    status: "completed",
    operation: "toolchain_clean",
    outcome: "cleaned",
    authority: cleanedAuthority,
  };
}

function lifecycleStatus(authority) {
  if (authority.source === "launcher") {
    return {
      status: "unavailable",
      error: "project_toolchain_not_initialized",
      message: "No initialized Project Toolchain owns this repository.",
    };
  }
  if (authority.state === "ready") {
    return {
      status: "completed",
      outcome: "ready",
      message: "The exact project Engine is materialized and executable.",
    };
  }
  if (["needs_toolchain_restore", "needs_toolchain_migration"].includes(authority.state)) {
    return {
      status: "unavailable",
      error: authority.state,
      message: "The Project Toolchain requires the explicit action reported by Execution Authority.",
    };
  }
  return {
    status: "execution_error",
    error: authority.state,
    message: "The Project Toolchain is invalid and no fallback Engine was selected.",
  };
}

export async function runToolchainLifecycle(cwd, launcherVersion, options = {}, dependencies = {}) {
  const operation = options.operation;
  const root = path.resolve(cwd);
  if (options.resume_token) {
    return runLifecycleLocked(root, operation, () =>
      resumeLifecycle(root, launcherVersion, options, dependencies));
  }
  if (operation === "restore") {
    return runLifecycleLocked(root, operation, () =>
      restoreToolchain(root, launcherVersion, options, dependencies));
  }
  if (operation === "migrate") {
    return runLifecycleLocked(root, operation, () =>
      migrateToolchain(root, launcherVersion, options, dependencies));
  }
  if (operation === "clean") {
    return runLifecycleLocked(root, operation, () => cleanToolchain(root, launcherVersion));
  }
  if (operation !== "status") {
    return {
      contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
      status: "execution_error",
      operation: "toolchain_unknown",
      error: "unknown_toolchain_operation",
      message: "Unknown Project Toolchain lifecycle operation.",
    };
  }
  const authority = await resolveExecutionAuthority({
    cwd: root,
    launcher_version: launcherVersion,
  });
  return {
    contract: TOOLCHAIN_LIFECYCLE_CONTRACT,
    operation: "toolchain_status",
    authority,
    ...lifecycleStatus(authority),
  };
}
