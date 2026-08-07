import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  CLI_INTERACTION_CONTRACT,
  INIT_INTERACTION_SCHEMA,
  MANIFEST_SCHEMA,
  assertSupportedManifestVersion,
  assertSupportedReportVersion,
  assertValidLegacyManifest,
  assertValidManifest,
  assertValidReportPackage,
} from "@launchrally/contracts";

import {
  LEGACY_MANIFEST_RELATIVE_PATH,
  MANIFEST_RELATIVE_PATH,
  parseManifest,
  serializeManifest,
} from "./manifest.js";
import { createNeedsRefreshResult } from "./interaction-result.js";

export const CLI_DEPENDENCY = "@launchrally/cli";
const APPROVED_PATHS = new Set([
  ".launchrally/.gitignore",
  LEGACY_MANIFEST_RELATIVE_PATH,
  MANIFEST_RELATIVE_PATH,
  "bun.lock",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const execFileAsync = promisify(execFile);
const RECOVERY_RELATIVE_PATH = ".launchrally/.init-transaction/recovery.json";

function digest(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function storeState(state) {
  const previewDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrally-init-preview-"));
  const directoryToken = path.basename(previewDirectory).slice("launchrally-init-preview-".length);
  const fileToken = randomBytes(32).toString("base64url");
  const token = `lrinit_${directoryToken}_${fileToken}`;
  await writeFile(
    path.join(previewDirectory, `${fileToken}.json`),
    `${JSON.stringify(state)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return token;
}

async function loadState(token) {
  if (typeof token !== "string") return null;
  const match = token.match(/^lrinit_([A-Za-z0-9]{6})_([A-Za-z0-9_-]{43})$/u);
  if (!match) return null;
  const statePath = path.join(
    os.tmpdir(),
    `launchrally-init-preview-${match[1]}`,
    `${match[2]}.json`,
  );
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    return state?.schema_version === INIT_INTERACTION_SCHEMA ? { state, statePath } : null;
  } catch {
    return null;
  }
}

async function discardState(statePath) {
  if (statePath) await rm(path.dirname(statePath), { recursive: true, force: true });
}

function declared(value) {
  return { state: "declared", value: structuredClone(value) };
}

function declaredOrUnknown(value, reason) {
  return value === null || value === undefined
    ? { state: "unknown", reason }
    : declared(value);
}

function declaredOrNotApplicable(values, reason, sourceReportId, field) {
  return values.length > 0
    ? declared(values)
    : {
      state: "not_applicable",
      reason,
      evidence: [{ source_report_id: sourceReportId, field }],
    };
}

function createManifest(report) {
  const release = report.scope.release_intent;
  return {
    schema_version: MANIFEST_SCHEMA,
    project: {
      name: declared(report.scope.project.name),
      type: declared(report.scope.project.type),
      package_manager: declared(report.scope.project.package_manager),
    },
    release: {
      intended_environment: release.confirmed
        ? declaredOrUnknown(
          release.intended_environment,
          "The first Report did not confirm an intended environment.",
        )
        : {
          state: "unknown",
          reason: "The first Report did not confirm an intended environment.",
        },
      production_targets: release.confirmed
        ? declared(release.production_targets)
        : { state: "unknown", reason: "The first Report did not confirm production targets." },
      core_journeys: release.confirmed
        ? declared(release.core_journeys)
        : { state: "unknown", reason: "The first Report did not confirm core journeys." },
    },
    execution: {
      source_report_id: declared(report.report_id),
      assessment: declaredOrUnknown(
        report.assessment,
        "The source Report is non-current and has no current Launch Assessment.",
      ),
      public_verification: declared({
        decision: report.scope.public_verification.decision,
        targets: report.scope.public_verification.targets,
      }),
    },
    support: {
      layers: release.confirmed
        ? declaredOrNotApplicable(
          release.support_layers,
          "No support layers were declared for this release.",
          report.report_id,
          "scope.release_intent.support_layers",
        )
        : {
          state: "unknown",
          reason: "The first Report did not confirm support-layer intent.",
        },
    },
    providers: {
      roles: release.confirmed
        ? declaredOrNotApplicable(
          release.provider_roles,
          "No Provider roles were declared for this release.",
          report.report_id,
          "scope.release_intent.provider_roles",
        )
        : {
          state: "unknown",
          reason: "The first Report did not confirm Provider intent.",
        },
    },
  };
}

function legacyEvidenceMismatch(message) {
  const error = new Error(message);
  error.code = "legacy_manifest_evidence_mismatch";
  throw error;
}

function migratedIntentState(state, report, field, reportValues) {
  if (state?.state !== "not_applicable") return structuredClone(state);
  if (
    report.scope.release_intent.confirmed !== true
    || !Array.isArray(reportValues)
    || reportValues.length !== 0
  ) {
    legacyEvidenceMismatch(
      `The legacy not-applicable state for ${field} conflicts with the supplied Report.`,
    );
  }
  return {
    ...structuredClone(state),
    evidence: [{ source_report_id: report.report_id, field }],
  };
}

function migrateLegacyManifest(legacy, report) {
  const legacySource = legacy.execution?.source_report_id;
  if (
    legacySource?.state !== "declared"
    || typeof legacySource.value !== "string"
    || legacySource.value !== report.report_id
  ) {
    legacyEvidenceMismatch(
      "The legacy Manifest source Report does not match the supplied Report.",
    );
  }
  const manifest = structuredClone(legacy);
  manifest.schema_version = MANIFEST_SCHEMA;
  manifest.support.layers = migratedIntentState(
    legacy.support.layers,
    report,
    "scope.release_intent.support_layers",
    report.scope.release_intent.support_layers,
  );
  manifest.providers.roles = migratedIntentState(
    legacy.providers.roles,
    report,
    "scope.release_intent.provider_roles",
    report.scope.release_intent.provider_roles,
  );
  assertValidManifest(manifest);
  return manifest;
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertSafeRelativePath(root, relativePath) {
  if (!APPROVED_PATHS.has(relativePath) && relativePath !== RECOVERY_RELATIVE_PATH) {
    const error = new Error("Initialization path is not approved.");
    error.code = "unsafe_project_path";
    throw error;
  }
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        const error = new Error(`Initialization refuses symlinked path: ${relativePath}`);
        error.code = "unsafe_project_path";
        throw error;
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

async function assertSafeChangePaths(root, changes) {
  for (const change of changes) await assertSafeRelativePath(root, change.path);
}

function contentLines(content) {
  if (content === null || content === "") return [];
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function exactDiff(relativePath, before, after) {
  const beforeLines = contentLines(before);
  const afterLines = contentLines(after);
  return [
    `--- ${before === null ? "/dev/null" : `a/${relativePath}`}`,
    `+++ ${after === null ? "/dev/null" : `b/${relativePath}`}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

async function exists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function lockfileFor(root, packageManager) {
  const standard = {
    npm: "package-lock.json",
    pnpm: "pnpm-lock.yaml",
    yarn: "yarn.lock",
  }[packageManager];
  if (standard) return { path: standard, binary: false };
  if (packageManager !== "bun") return null;
  if (await exists(path.join(root, "bun.lock"))) return { path: "bun.lock", binary: false };
  if (await exists(path.join(root, "bun.lockb"))) return { path: "bun.lockb", binary: true };
  return { path: "bun.lock", binary: false };
}

function unquote(value) {
  return value.trim().replace(/^(?:['"])(.*)(?:['"])$/u, "$1");
}

function pnpmLocksExactDependency(lockfile, dependency, version) {
  const lines = lockfile.split("\n");
  const importer = lines.findIndex((line) => /^ {2}(?:\.|['"]\.['"]):\s*$/u.test(line));
  if (importer < 0) return false;
  const devDependencies = lines.findIndex(
    (line, index) => index > importer && /^ {4}devDependencies:\s*$/u.test(line),
  );
  if (devDependencies < 0) return false;
  const escapedDependency = dependency.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const dependencyLine = lines.findIndex((line, index) =>
    index > devDependencies
      && new RegExp(`^ {6}['"]?${escapedDependency}['"]?:\\s*$`, "u").test(line));
  if (dependencyLine < 0) return false;
  const block = [];
  for (let index = dependencyLine + 1; index < lines.length; index += 1) {
    if (/^ {0,6}\S/u.test(lines[index])) break;
    block.push(lines[index]);
  }
  const values = Object.fromEntries(block.flatMap((line) => {
    const match = line.match(/^ {8}(specifier|version):\s*(.+?)\s*$/u);
    return match ? [[match[1], unquote(match[2])]] : [];
  }));
  return values.specifier === version && values.version === version;
}

function yarnLocksExactDependency(lockfile, dependency, version) {
  const escapedDependency = dependency.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const header = new RegExp(
    `^['"]?${escapedDependency}@(npm:)?${version.replaceAll(".", "\\.")}['"]?:\\s*$`,
    "u",
  );
  const lines = lockfile.split("\n");
  const entry = lines.findIndex((line) => header.test(line));
  if (entry < 0) return false;
  for (let index = entry + 1; index < lines.length && /^\s/u.test(lines[index]); index += 1) {
    const match = lines[index].match(/^\s+version(?::|\s)\s*['"]?([^'"\s]+)['"]?\s*$/u);
    if (match) return match[1] === version;
  }
  return false;
}

function bunLocksExactDependency(lockfile, dependency, version) {
  const escapedDependency = dependency.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const escapedVersion = version.replaceAll(".", "\\.");
  return new RegExp(
    `['"]${escapedDependency}['"]\\s*:\\s*\\[\\s*['"]${escapedDependency}@${escapedVersion}['"]`,
    "u",
  ).test(lockfile);
}

function alreadyExact({ packageManager, packageJson, lockfile, dependency, version }) {
  let parsedPackage;
  try {
    parsedPackage = JSON.parse(packageJson);
  } catch {
    return false;
  }
  if (parsedPackage.devDependencies?.[dependency] !== version) return false;
  if (packageManager === "pnpm") return pnpmLocksExactDependency(lockfile, dependency, version);
  if (packageManager === "yarn") return yarnLocksExactDependency(lockfile, dependency, version);
  if (packageManager === "bun") return bunLocksExactDependency(lockfile, dependency, version);
  try {
    const parsedLock = JSON.parse(lockfile);
    return parsedLock.packages?.[""]?.devDependencies?.[dependency] === version
      && parsedLock.packages?.[`node_modules/${dependency}`]?.version === version;
  } catch {
    return false;
  }
}

async function defaultPrepareDependencyChanges({
  package_manager: packageManager,
  package_json: packageJson,
  lockfile,
  dependency,
  version,
}) {
  if (alreadyExact({
    packageManager,
    packageJson,
    lockfile: lockfile.content,
    dependency,
    version,
  })) {
    return [
      { path: "package.json", content: packageJson },
      { path: lockfile.path, content: lockfile.content },
    ];
  }
  const commands = {
    npm: ["npm", [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--save-dev",
      "--save-exact",
      "--no-audit",
      "--no-fund",
      `${dependency}@${version}`,
    ]],
    pnpm: ["pnpm", [
      "add",
      "--lockfile-only",
      "--ignore-scripts",
      "--save-dev",
      "--save-exact",
      `${dependency}@${version}`,
    ]],
    yarn: ["yarn", ["add", "--ignore-scripts", "--dev", "--exact", `${dependency}@${version}`]],
    bun: ["bun", ["add", "--lockfile-only", "--dev", "--exact", `${dependency}@${version}`]],
  };
  const command = commands[packageManager];
  if (!command) throw new Error("unsupported_package_manager");
  const staging = await mkdtemp(path.join(os.tmpdir(), "launchrally-dependency-plan-"));
  try {
    await writeFile(path.join(staging, "package.json"), packageJson, "utf8");
    await writeFile(path.join(staging, lockfile.path), lockfile.content, "utf8");
    await execFileAsync(command[0], command[1], {
      cwd: staging,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    return [
      { path: "package.json", content: await readFile(path.join(staging, "package.json"), "utf8") },
      { path: lockfile.path, content: await readFile(path.join(staging, lockfile.path), "utf8") },
    ];
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function previewChange(root, relativePath, after) {
  const before = await readOptional(path.join(root, relativePath));
  return {
    path: relativePath,
    operation: after === null ? "delete" : before === null ? "create" : "update",
    before,
    after,
    before_digest: before === null ? null : digest(before),
    after_digest: after === null ? null : digest(after),
    diff: exactDiff(relativePath, before, after),
  };
}

async function previewIsCurrent(root, changes) {
  for (const change of changes) {
    const content = await readOptional(path.join(root, change.path));
    const currentDigest = content === null ? null : digest(content);
    if (currentDigest !== change.before_digest) return false;
  }
  return true;
}

function fileOperationAdapter(fileOperations = {}) {
  return {
    mkdir,
    write_file: (target, content) => writeFile(target, content, "utf8"),
    remove_file: (target) => rm(target, { force: true }),
    remove_dir: rmdir,
    ...fileOperations,
  };
}

async function removeRecoveryJournal(root) {
  await rm(path.join(root, ".launchrally", ".init-transaction"), {
    recursive: true,
    force: true,
  });
  try {
    await rmdir(path.join(root, ".launchrally"));
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY"].includes(error?.code)) throw error;
  }
}

async function rollbackChanges(root, changes, operations, guardCurrent = false) {
  try {
    if (guardCurrent) {
      await assertSafeChangePaths(root, changes);
      for (const change of changes) {
        const current = await readOptional(path.join(root, change.path));
        const currentDigest = current === null ? null : digest(current);
        if (![change.before_digest, change.after_digest].includes(currentDigest)) {
          return { reverted: false, conflict: true };
        }
      }
    }
    for (const change of [...changes].reverse()) {
      const target = path.join(root, change.path);
      if (guardCurrent) {
        const current = await readOptional(target);
        const currentDigest = current === null ? null : digest(current);
        if (currentDigest === change.before_digest) continue;
      }
      if (change.before === null) {
        await operations.remove_file(target);
      } else {
        await operations.mkdir(path.dirname(target), { recursive: true });
        await operations.write_file(target, change.before);
      }
    }
    return { reverted: true, conflict: false };
  } catch {
    return { reverted: false, conflict: false };
  }
}

async function applyChanges(root, changes, fileOperations = {}) {
  const operations = fileOperationAdapter(fileOperations);
  const manifestPath = MANIFEST_RELATIVE_PATH;
  const ordered = [
    ...changes.filter((change) => change.path !== manifestPath),
    ...changes.filter((change) => change.path === manifestPath),
  ];
  const attempted = [];
  const recoveryPath = path.join(root, RECOVERY_RELATIVE_PATH);
  try {
    await assertSafeRelativePath(root, RECOVERY_RELATIVE_PATH);
    await assertSafeChangePaths(root, changes);
    await mkdir(path.dirname(recoveryPath), { recursive: true });
    await writeFile(
      recoveryPath,
      `${JSON.stringify({
        schema_version: INIT_INTERACTION_SCHEMA,
        root,
        changes,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    for (const change of ordered) {
      const target = path.join(root, change.path);
      attempted.push(change);
      if (change.after === null) {
        await operations.remove_file(target);
      } else {
        await operations.mkdir(path.dirname(target), { recursive: true });
        await operations.write_file(target, change.after);
      }
    }
    await removeRecoveryJournal(root);
    return { applied: true, reverted: false };
  } catch {
    const rollback = await rollbackChanges(root, attempted, operations);
    if (rollback.reverted) {
      await removeRecoveryJournal(root);
      return { applied: false, reverted: true };
    }
    return { applied: false, reverted: false };
  }
}

async function recoverPendingInitialization(root) {
  const recoveryPath = path.join(root, RECOVERY_RELATIVE_PATH);
  try {
    await assertSafeRelativePath(root, RECOVERY_RELATIVE_PATH);
  } catch (error) {
    if (error?.code === "unsafe_project_path") return "unsafe_path";
    throw error;
  }
  const content = await readOptional(recoveryPath);
  if (content === null) return null;
  let journal;
  try {
    journal = JSON.parse(content);
  } catch {
    return false;
  }
  if (
    journal?.schema_version !== INIT_INTERACTION_SCHEMA
    || journal.root !== root
    || !Array.isArray(journal.changes)
    || journal.changes.some((change) => !APPROVED_PATHS.has(change.path))
  ) {
    return false;
  }
  const rollback = await rollbackChanges(
    root,
    journal.changes,
    fileOperationAdapter(),
    true,
  );
  if (rollback.conflict) return "conflict";
  if (!rollback.reverted) return false;
  await removeRecoveryJournal(root);
  return true;
}

function unavailable() {
  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "unavailable",
    operation: "init",
    reason: "complete_report_required",
    message: "Run a complete Audit and supply its saved JSON output before initialization.",
  };
}

function initializationError(error, message, extra = {}) {
  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "execution_error",
    operation: "init",
    error,
    message,
    ...extra,
  };
}

export async function runInit(cwd, version, options = {}, dependencies = {}) {
  const root = path.resolve(cwd);
  const recovered = await recoverPendingInitialization(root);
  if (recovered === true) {
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "completed",
      operation: "init",
      outcome: "initialization_recovered",
      changes_applied: [],
    };
  }
  if (recovered === false) {
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "execution_error",
      operation: "init",
      error: "invalid_recovery_journal",
      message: "The interrupted initialization recovery journal is invalid and was not applied.",
      recoverable: true,
    };
  }
  if (recovered === "conflict") {
    return initializationError(
      "initialization_recovery_conflict",
      "Recovery stopped because a project file changed after interruption; user edits were preserved.",
      { recoverable: true },
    );
  }
  if (recovered === "unsafe_path") {
    return initializationError(
      "unsafe_project_path",
      "Initialization refuses a symlinked project path that could escape the repository.",
    );
  }
  if (!options.report_package && !options.resume_token) return unavailable();
  if (options.resume_token) {
    const stored = await loadState(options.resume_token);
    if (!stored) {
      return {
        contract: CLI_INTERACTION_CONTRACT,
        status: "execution_error",
        operation: "init",
        error: "invalid_resume_token",
        message: "The initialization preview token is invalid or corrupted.",
      };
    }
    const { state, statePath } = stored;
    if (state.root !== root) {
      await discardState(statePath);
      return {
        contract: CLI_INTERACTION_CONTRACT,
        status: "execution_error",
        operation: "init",
        error: "resume_scope_mismatch",
        message: "The initialization preview belongs to a different repository root.",
      };
    }
    if (
      !Array.isArray(state.changes)
      || state.changes.some((change) => !APPROVED_PATHS.has(change.path))
    ) {
      await discardState(statePath);
      return {
        contract: CLI_INTERACTION_CONTRACT,
        status: "execution_error",
        operation: "init",
        error: "invalid_resume_token",
        message: "The initialization preview token contains an invalid change plan.",
      };
    }
    try {
      await assertSafeRelativePath(root, RECOVERY_RELATIVE_PATH);
      await assertSafeChangePaths(root, state.changes);
    } catch (error) {
      await discardState(statePath);
      if (error?.code === "unsafe_project_path") {
        return initializationError(
          "unsafe_project_path",
          "Initialization refuses a symlinked project path that could escape the repository.",
        );
      }
      throw error;
    }
    if (options.confirmation === "decline") {
      await discardState(statePath);
      return {
        contract: CLI_INTERACTION_CONTRACT,
        status: "completed",
        operation: "init",
        outcome: "initialization_declined",
        changes_applied: [],
      };
    }
    if (options.confirmation !== "confirm") {
      return {
        contract: CLI_INTERACTION_CONTRACT,
        status: "execution_error",
        operation: "init",
        error: "invalid_confirmation",
        message: "The initialization confirmation decision is invalid.",
      };
    }
    if (!await previewIsCurrent(state.root, state.changes)) {
      await discardState(statePath);
      return {
        contract: CLI_INTERACTION_CONTRACT,
        status: "execution_error",
        operation: "init",
        error: "preview_stale",
        message: "A previewed file changed before confirmation; no initialization changes were applied.",
      };
    }
    const applied = await applyChanges(
      state.root,
      state.changes,
      dependencies.file_operations,
    );
    await discardState(statePath);
    if (!applied.applied) {
      return applied.reverted
        ? {
          contract: CLI_INTERACTION_CONTRACT,
          status: "execution_error",
          operation: "init",
          error: "initialization_failed_reverted",
          message: "Initialization failed and every attempted change was reverted.",
          recoverable: true,
          changes_applied: [],
        }
        : {
          contract: CLI_INTERACTION_CONTRACT,
          status: "execution_error",
          operation: "init",
          error: "initialization_recovery_required",
          message: "Initialization and automatic rollback both failed; rerun init to recover.",
          recoverable: true,
          changes_applied: [],
        };
    }
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "completed",
      operation: "init",
      outcome: state.mode === "migration" ? "migrated" : "initialized",
      source_report_id: state.source_report_id,
      changes_applied: state.changes.map((change) => change.path),
    };
  }

  const source = options.report_package;
  if (!source?.report || typeof source.report.schema_version !== "string") {
    return initializationError(
      "invalid_report_package",
      "The saved Audit JSON is incomplete or invalid; nothing was changed.",
    );
  }
  try {
    assertSupportedReportVersion(source.report);
  } catch (error) {
    return initializationError(
      error?.code ?? "invalid_report_package",
      error?.code === "unsupported_report_version"
        ? "The saved Report uses an unsupported future major version."
        : "The saved Audit JSON is incomplete or invalid; nothing was changed.",
    );
  }
  try {
    assertValidReportPackage(source);
  } catch {
    return initializationError(
      "invalid_report_package",
      "The saved Audit JSON is incomplete or invalid; nothing was changed.",
    );
  }
  if (path.resolve(source.report.scope.project_root) !== root) {
    return initializationError(
      "report_scope_mismatch",
      "The saved Report belongs to a different repository root; nothing was changed.",
    );
  }
  if (!source.report.policy.current) {
    return createNeedsRefreshResult(
      "init",
      source.report.report_id,
      "Initialization requires a current Report; run full Verify first.",
    );
  }
  try {
    await assertSafeRelativePath(root, MANIFEST_RELATIVE_PATH);
    await assertSafeRelativePath(root, LEGACY_MANIFEST_RELATIVE_PATH);
    await assertSafeRelativePath(root, ".launchrally/.gitignore");
    await assertSafeRelativePath(root, "package.json");
  } catch (error) {
    if (error?.code === "unsafe_project_path") {
      return initializationError(
        "unsafe_project_path",
        "Initialization refuses a symlinked project path that could escape the repository.",
      );
    }
    throw error;
  }
  const manifestPath = path.join(root, MANIFEST_RELATIVE_PATH);
  const legacyManifestPath = path.join(root, LEGACY_MANIFEST_RELATIVE_PATH);
  const existingManifestContent = await readOptional(manifestPath);
  const legacyManifestContent = await readOptional(legacyManifestPath);
  if (existingManifestContent !== null && legacyManifestContent !== null) {
    return initializationError(
      "ambiguous_manifest",
      "Both the canonical YAML Manifest and legacy JSON Manifest exist; neither was changed.",
    );
  }
  let legacyManifest = null;
  let existingManifest = null;
  if (existingManifestContent !== null) {
    try {
      existingManifest = parseManifest(existingManifestContent);
      assertSupportedManifestVersion(existingManifest);
      assertValidManifest(existingManifest);
    } catch (error) {
      return {
        contract: CLI_INTERACTION_CONTRACT,
        status: "execution_error",
        operation: "init",
        error: error?.code ?? "invalid_manifest",
        message: error?.code === "unsupported_manifest_version"
          ? "The existing Launch Manifest uses an unsupported future major version."
          : "The existing Launch Manifest is invalid and was not changed.",
      };
    }
  }
  if (legacyManifestContent !== null) {
    try {
      legacyManifest = JSON.parse(legacyManifestContent);
      if (legacyManifest?.schema_version !== "launchrally.dev/manifest/v1") {
        assertSupportedManifestVersion(legacyManifest);
      }
      assertValidLegacyManifest(legacyManifest);
    } catch (error) {
      return {
        contract: CLI_INTERACTION_CONTRACT,
        status: "execution_error",
        operation: "init",
        error: error?.code ?? "invalid_manifest",
        message: error?.code === "unsupported_manifest_version"
          ? "The legacy Launch Manifest uses an unsupported future major version."
          : "The legacy Launch Manifest is invalid and was not changed.",
      };
    }
  }
  const mode = legacyManifestContent !== null
    ? "migration"
    : existingManifestContent === null ? "initialization" : "update";
  let manifest;
  try {
    manifest = legacyManifest
      ? migrateLegacyManifest(legacyManifest, source.report)
      : existingManifest ?? createManifest(source.report);
  } catch (error) {
    return initializationError(
      error?.code ?? "invalid_manifest",
      error?.code === "legacy_manifest_evidence_mismatch"
        ? "The legacy Manifest cannot be evidenced by the supplied Report; nothing was changed."
        : "The Launch Manifest is invalid and was not changed.",
    );
  }
  const packageJson = await readFile(path.join(root, "package.json"), "utf8");
  const lockfile = await lockfileFor(root, source.report.scope.project.package_manager);
  if (!lockfile) {
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "execution_error",
      operation: "init",
      error: "unsupported_package_manager",
      message: "Initialization cannot prepare an exact lockfile change for this package manager.",
    };
  }
  if (lockfile.binary) {
    return initializationError(
      "unsupported_binary_lockfile",
      "Legacy bun.lockb cannot be previewed safely; migrate it to bun.lock, rerun Audit, and retry init.",
      { recoverable: true },
    );
  }
  const lockfilePath = lockfile.path;
  try {
    await assertSafeRelativePath(root, lockfilePath);
  } catch (error) {
    if (error?.code === "unsafe_project_path") {
      return initializationError(
        "unsafe_project_path",
        "Initialization refuses a symlinked project path that could escape the repository.",
      );
    }
    throw error;
  }
  const lockfileContent = await readFile(path.join(root, lockfilePath), "utf8");
  const prepareDependencyChanges = dependencies.prepare_dependency_changes
    ?? defaultPrepareDependencyChanges;
  let dependencyChanges;
  try {
    dependencyChanges = await prepareDependencyChanges({
      cwd: root,
      package_manager: source.report.scope.project.package_manager,
      package_json: packageJson,
      lockfile: { path: lockfilePath, content: lockfileContent },
      dependency: CLI_DEPENDENCY,
      version,
    });
  } catch {
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "execution_error",
      operation: "init",
      error: "dependency_plan_failed",
      message: "The exact CLI dependency and lockfile preview could not be prepared; nothing was changed.",
      recoverable: true,
    };
  }
  const dependencyPaths = Array.isArray(dependencyChanges)
    ? dependencyChanges.map((change) => change.path).sort()
    : [];
  const exactDependencyPaths = ["package.json", lockfilePath].sort();
  const plannedPackage = dependencyChanges.find((change) => change.path === "package.json");
  const plannedLockfile = dependencyChanges.find((change) => change.path === lockfilePath);
  if (
    !Array.isArray(dependencyChanges)
    || JSON.stringify(dependencyPaths) !== JSON.stringify(exactDependencyPaths)
    || dependencyChanges.some((change) => typeof change.content !== "string")
    || !alreadyExact({
      packageManager: source.report.scope.project.package_manager,
      packageJson: plannedPackage?.content,
      lockfile: plannedLockfile?.content,
      dependency: CLI_DEPENDENCY,
      version,
    })
  ) {
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "execution_error",
      operation: "init",
      error: "invalid_dependency_plan",
      message: "The dependency planner did not produce only the exact CLI devDependency and lockfile change.",
      recoverable: true,
    };
  }
  const plannedContents = new Map(dependencyChanges.map((change) => [change.path, change.content]));
  plannedContents.set(
    ".launchrally/.gitignore",
    "/reports/\n/evidence/\n/.init-transaction/\n",
  );
  plannedContents.set(
    MANIFEST_RELATIVE_PATH,
    serializeManifest(manifest),
  );
  if (legacyManifestContent !== null) {
    plannedContents.set(LEGACY_MANIFEST_RELATIVE_PATH, null);
  }
  const previewedChanges = await Promise.all(
    [...plannedContents.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([relativePath, content]) => previewChange(root, relativePath, content)),
  );
  const changes = previewedChanges.filter((change) => change.before !== change.after);
  if (changes.length === 0) {
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "completed",
      operation: "init",
      outcome: "already_initialized",
      source_report_id: source.report.report_id,
      changes_applied: [],
    };
  }
  const state = {
    schema_version: INIT_INTERACTION_SCHEMA,
    root,
    source_report_id: source.report.report_id,
    mode,
    manifest,
    changes,
  };
  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "needs_confirmation",
    operation: "init",
    source_report_id: source.report.report_id,
    mode,
    manifest,
    preview: { changes },
    interaction: {
      schema_version: INIT_INTERACTION_SCHEMA,
      resume_token: await storeState(state),
    },
    request: {
      type: "confirmation",
      prompt: "Apply exactly these local initialization changes?",
      choices: ["confirm", "decline"],
    },
  };
}
