import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
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
import { acquireOwnedLock } from "./exclusive-lock.js";
import {
  createHistoryFiles,
  committedLocalHistoryStatus,
  isImmutableHistoryPath,
  isLocalHistoryPath,
  persistLocalHistory,
} from "./local-history.js";
import { evaluateReportCurrentness } from "./report-currentness.js";

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

function isApprovedPath(relativePath) {
  return APPROVED_PATHS.has(relativePath) || isLocalHistoryPath(relativePath);
}

function digest(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function storeState(state) {
  const previewDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrally-init-preview-"));
  const directoryToken = path.basename(previewDirectory).slice("launchrally-init-preview-".length);
  const fileToken = randomBytes(32).toString("base64url");
  const content = `${JSON.stringify(state)}\n`;
  const stateDigest = createHash("sha256").update(content).digest("base64url");
  const token = `lrinit_${directoryToken}_${fileToken}_${stateDigest}`;
  await writeFile(
    path.join(previewDirectory, `${fileToken}.json`),
    content,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return token;
}

async function loadState(token) {
  if (typeof token !== "string") return null;
  const match = token.match(
    /^lrinit_([A-Za-z0-9]{6})_([A-Za-z0-9_-]{43})_([A-Za-z0-9_-]{43})$/u,
  );
  if (!match) return null;
  const statePath = path.join(
    os.tmpdir(),
    `launchrally-init-preview-${match[1]}`,
    `${match[2]}.json`,
  );
  try {
    const content = await readFile(statePath, "utf8");
    if (createHash("sha256").update(content).digest("base64url") !== match[3]) return null;
    const state = JSON.parse(content);
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
  if (!isApprovedPath(relativePath) && relativePath !== RECOVERY_RELATIVE_PATH) {
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

async function preexistingHistoryIsCurrent(root, state) {
  for (const entry of state.history_preexisting) {
    await assertSafeRelativePath(root, entry.path);
    const content = await readOptional(path.join(root, entry.path));
    if (content === null || digest(content) !== entry.digest) return false;
  }
  const historyPlan = createHistoryFiles(state.report_package, { include_cache: false });
  const reportWasPreexisting = historyPlan.files
    .filter(({ path: historyPath }) => historyPath.includes("/reports/"))
    .every((file) => state.history_preexisting.some((entry) => entry.path === file.path));
  if (!reportWasPreexisting) return true;
  return await committedLocalHistoryStatus(
    root,
    state.report_package.report.report_id,
    historyPlan.record_digest,
  ) === "valid";
}

function previewChangeIsValid(change) {
  if (!change || typeof change !== "object" || Array.isArray(change)) return false;
  const expectedOperation = change.after === null
    ? "delete"
    : change.before === null ? "create" : "update";
  return JSON.stringify(Object.keys(change).sort()) === JSON.stringify([
    "after",
    "after_digest",
    "before",
    "before_digest",
    "diff",
    "operation",
    "path",
  ])
    && isApprovedPath(change.path)
    && (change.before === null || typeof change.before === "string")
    && (change.after === null || typeof change.after === "string")
    && change.before_digest === (change.before === null ? null : digest(change.before))
    && change.after_digest === (change.after === null ? null : digest(change.after))
    && change.operation === expectedOperation
    && change.diff === exactDiff(change.path, change.before, change.after);
}

function storedPreviewIsBound(state) {
  try {
    if (
      JSON.stringify(Object.keys(state).sort()) !== JSON.stringify([
        "changes",
        "history_preexisting",
        "manifest",
        "mode",
        "report_package",
        "root",
        "schema_version",
        "source_report_id",
      ])
      || !state.report_package
      || state.source_report_id !== state.report_package.report?.report_id
      || !Array.isArray(state.changes)
      || !Array.isArray(state.history_preexisting)
      || !["initialization", "migration", "update"].includes(state.mode)
    ) return false;
    if (
      state.changes.some((change) => !previewChangeIsValid(change))
      || new Set(state.changes.map(({ path: relative }) => relative)).size !== state.changes.length
    ) return false;
    const expectedApplyChanges = state.changes.filter(
      (change) => !isLocalHistoryPath(change.path),
    );
    const expectedHistoryFiles = createHistoryFiles(
      state.report_package,
      { include_cache: false },
    ).files;
    const expectedHistoryByPath = new Map(expectedHistoryFiles.map((file) => [file.path, file]));
    const historyChanges = state.changes.filter((change) => isLocalHistoryPath(change.path));
    for (const change of historyChanges) {
      const file = expectedHistoryByPath.get(change.path);
      if (
        !file
        || change.after !== file.content
        || change.after_digest !== digest(file.content)
      ) return false;
    }
    if (state.history_preexisting.some((candidate) => {
      const file = expectedHistoryByPath.get(candidate.path);
      return JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(["digest", "path"])
        || !file
        || candidate.digest !== digest(file.content);
    })) return false;
    const boundHistoryPaths = [
      ...historyChanges.map(({ path: relative }) => relative),
      ...state.history_preexisting.map(({ path: relative }) => relative),
    ];
    if (
      new Set(boundHistoryPaths).size !== expectedHistoryFiles.length
      || expectedHistoryFiles.some((file) => !boundHistoryPaths.includes(file.path))
    ) return false;
    const manifestChange = expectedApplyChanges.find(
      (change) => change.path === MANIFEST_RELATIVE_PATH,
    );
    return !manifestChange || manifestChange.after === serializeManifest(state.manifest);
  } catch {
    return false;
  }
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

async function cleanupEmptyChangeDirectories(root, changes) {
  const launchrallyRoot = path.join(root, ".launchrally");
  const directories = [...new Set(changes
    .filter((change) => change.before === null && change.path.startsWith(".launchrally/"))
    .map((change) => path.dirname(path.join(root, change.path))))]
    .sort((left, right) => right.length - left.length);
  for (const directory of directories) {
    let current = directory;
    while (current.startsWith(`${launchrallyRoot}${path.sep}`)) {
      try {
        await rmdir(current);
      } catch (error) {
        if (!["ENOENT", "ENOTEMPTY"].includes(error?.code)) throw error;
        break;
      }
      current = path.dirname(current);
    }
  }
}

async function applyChanges(
  root,
  changes,
  fileOperations = {},
  deferCleanup = false,
  journalContext = null,
) {
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
        phase: "applying",
        history: journalContext,
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
    if (!deferCleanup) await removeRecoveryJournal(root);
    return { applied: true, reverted: false };
  } catch {
    const rollback = await rollbackChanges(root, attempted, operations, true);
    if (rollback.reverted) {
      await cleanupEmptyChangeDirectories(root, attempted);
      await removeRecoveryJournal(root);
      return { applied: false, reverted: true };
    }
    return { applied: false, reverted: false, conflict: rollback.conflict };
  }
}

async function markInitializationPhase(root, phase) {
  const recoveryPath = path.join(root, RECOVERY_RELATIVE_PATH);
  const journal = JSON.parse(await readFile(recoveryPath, "utf8"));
  const temporary = `${recoveryPath}.tmp-${randomBytes(16).toString("hex")}`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ ...journal, phase })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await rename(temporary, recoveryPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function markInitializationHistoryCommitted(root) {
  return markInitializationPhase(root, "history_committed");
}

async function initializationHistoryIsCommitted(root, history) {
  try {
    return await committedLocalHistoryStatus(
      root,
      history.report_id,
      history.record_digest,
    );
  } catch {
    return "invalid";
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
    !journal
    || JSON.stringify(Object.keys(journal).sort()) !== JSON.stringify([
      "changes",
      "history",
      "phase",
      "root",
      "schema_version",
    ])
    || journal?.schema_version !== INIT_INTERACTION_SCHEMA
    || journal.root !== root
    || !Array.isArray(journal.changes)
    || journal.changes.some((change) => !previewChangeIsValid(change))
    || new Set(journal.changes.map(({ path: relative }) => relative)).size
      !== journal.changes.length
    || !["applying", "history_committing", "history_committed"].includes(journal.phase)
    || !journal.history
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(journal.history.report_id)
    || !/^sha256:[a-f0-9]{64}$/u.test(journal.history.record_digest)
    || typeof journal.history.source_report_id !== "string"
    || !["initialization", "migration", "update"].includes(journal.history.mode)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
      .test(journal.history.commit_token)
    || typeof journal.history.report_preexisting !== "boolean"
    || !Array.isArray(journal.history.history_preexisting)
    || JSON.stringify(Object.keys(journal.history).sort()) !== JSON.stringify([
      "commit_token",
      "history_preexisting",
      "mode",
      "record_digest",
      "report_id",
      "report_preexisting",
      "source_report_id",
    ])
    || journal.history.history_preexisting.some((candidate) =>
      JSON.stringify(Object.keys(candidate ?? {}).sort()) !== JSON.stringify(["digest", "path"])
      || !isLocalHistoryPath(candidate.path)
      || !/^sha256:[a-f0-9]{64}$/u.test(candidate.digest))
    || new Set(journal.history.history_preexisting.map(({ path: historyPath }) => historyPath)).size
      !== journal.history.history_preexisting.length
  ) {
    return false;
  }
  const reportHistoryPaths = [
    "evidence-index.json",
    "record.json",
    "record.sha256",
    "view.md",
  ].map((name) => `.launchrally/reports/${journal.history.report_id}/${name}`);
  if (
    journal.history.report_preexisting !== reportHistoryPaths.every((historyPath) =>
      journal.history.history_preexisting.some(({ path: recordedPath }) =>
        recordedPath === historyPath))
  ) return false;
  const historyState = await initializationHistoryIsCommitted(root, journal.history);
  if (
    journal.phase === "history_committed" && historyState !== "valid"
    || journal.phase === "history_committing" && historyState === "invalid"
  ) return false;
  if (
    ["history_committing", "history_committed"].includes(journal.phase)
    && historyState === "valid"
  ) {
    for (const change of journal.changes) {
      const current = await readOptional(path.join(root, change.path));
      if ((current === null ? null : digest(current)) !== change.after_digest) return "conflict";
    }
    await removeRecoveryJournal(root);
    return {
      action: "finalized",
      source_report_id: journal.history.source_report_id,
      mode: journal.history.mode,
      history_commit: journal.history.report_preexisting ? "reused" : "created",
      changes_applied: journal.changes.map((change) => change.path),
    };
  }
  const rollback = await rollbackChanges(
    root,
    journal.changes,
    fileOperationAdapter(),
    true,
  );
  if (rollback.conflict) return "conflict";
  if (!rollback.reverted) return false;
  await cleanupEmptyChangeDirectories(root, journal.changes);
  await removeRecoveryJournal(root);
  return { action: "rolled_back" };
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

async function runInitLocked(cwd, version, options = {}, dependencies = {}) {
  const root = path.resolve(cwd);
  const recovered = await recoverPendingInitialization(root);
  if (recovered?.action === "rolled_back") {
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "completed",
      operation: "init",
      outcome: "initialization_recovered",
      changes_applied: [],
    };
  }
  if (recovered?.action === "finalized") {
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "completed",
      operation: "init",
      outcome: recovered.mode === "migration" ? "migrated" : "initialized",
      recovery: "committed_history_finalized",
      history_commit: recovered.history_commit,
      source_report_id: recovered.source_report_id,
      changes_applied: recovered.changes_applied,
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
    const stored = await (dependencies.load_state ?? loadState)(options.resume_token);
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
      || state.changes.some((change) => !isApprovedPath(change.path))
      || !storedPreviewIsBound(state)
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
      for (const entry of state.history_preexisting) {
        await assertSafeRelativePath(root, entry.path);
      }
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
    if (
      !await previewIsCurrent(state.root, state.changes)
      || !await preexistingHistoryIsCurrent(state.root, state)
    ) {
      await discardState(statePath);
      return {
        contract: CLI_INTERACTION_CONTRACT,
        status: "execution_error",
        operation: "init",
        error: "preview_stale",
        message: "A previewed file changed before confirmation; no initialization changes were applied.",
      };
    }
    const appliedChanges = state.changes.filter(
      (change) => !isLocalHistoryPath(change.path),
    );
    const historyPlan = createHistoryFiles(
      state.report_package,
      { include_cache: false },
    );
    const journalContext = {
      report_id: state.report_package.report.report_id,
      record_digest: historyPlan.record_digest,
      source_report_id: state.source_report_id,
      mode: state.mode,
      commit_token: randomUUID(),
      history_preexisting: state.history_preexisting,
      report_preexisting: historyPlan.files
        .filter(({ path: relative }) => relative.includes("/reports/"))
        .every((file) => state.history_preexisting.some((item) => item.path === file.path)),
    };
    const applied = await applyChanges(
      state.root,
      appliedChanges,
      dependencies.file_operations,
      true,
      journalContext,
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
    let historyCommitted = false;
    try {
      await (dependencies.mark_history_committing
        ?? ((target) => markInitializationPhase(target, "history_committing")))(state.root);
      await (dependencies.persist_history ?? persistLocalHistory)(
        state.root,
        state.report_package,
        {
          include_cache: false,
          ...(dependencies.history_file_operations
            ? { file_operations: dependencies.history_file_operations }
            : {}),
        },
      );
      historyCommitted = true;
      await (dependencies.mark_history_committed ?? markInitializationHistoryCommitted)(
        state.root,
      );
      await removeRecoveryJournal(state.root);
    } catch (error) {
      if (historyCommitted) {
        return initializationError(
          "initialization_recovery_required",
          "Immutable history was committed, but initialization journal cleanup failed; rerun init to recover safely.",
          { recoverable: true, changes_applied: [] },
        );
      }
      const rollback = await rollbackChanges(
        state.root,
        appliedChanges,
        fileOperationAdapter(dependencies.file_operations),
        true,
      );
      if (rollback.reverted) {
        try {
          await cleanupEmptyChangeDirectories(state.root, appliedChanges);
          await removeRecoveryJournal(state.root);
        } catch {
          return initializationError(
            "initialization_recovery_required",
            "History persistence failed and rollback journal cleanup must be recovered by rerunning init.",
            { recoverable: true, changes_applied: [] },
          );
        }
        return initializationError(
          error?.code ?? "history_persistence_failed",
          "Initialization could not commit immutable local history and all project changes were reverted.",
          { recoverable: true, changes_applied: [] },
        );
      }
      return initializationError(
        "initialization_recovery_required",
        "History persistence and automatic rollback both failed; rerun init to recover.",
        { recoverable: true, changes_applied: [] },
      );
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
  let sourceHistoryPlan;
  try {
    sourceHistoryPlan = createHistoryFiles(source, { include_cache: false });
  } catch (error) {
    return initializationError(
      error?.code ?? "invalid_report_package",
      "The saved Audit history is inconsistent or unsafe; nothing was changed.",
    );
  }
  let existingHistoryState;
  try {
    for (const file of sourceHistoryPlan.files) {
      await assertSafeRelativePath(root, file.path);
    }
    existingHistoryState = await committedLocalHistoryStatus(
      root,
      source.report.report_id,
      sourceHistoryPlan.record_digest,
    );
  } catch (error) {
    return initializationError(
      error?.code ?? "history_preflight_failed",
      "Existing local history could not be validated; nothing was changed.",
      { recoverable: true },
    );
  }
  if (existingHistoryState === "invalid") {
    return initializationError(
      "history_collision",
      "Existing Report history is partial, tampered, or missing referenced Evidence; nothing was changed.",
      { recoverable: true },
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
  const currentness = evaluateReportCurrentness(source, {
    cwd: root,
    allow_legacy_manifest: legacyManifest !== null,
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  if (!currentness.current) {
    return createNeedsRefreshResult(
      "init",
      source.report.report_id,
      "Initialization requires a current Report; run full Verify first.",
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
    "/reports/\n/evidence/\n/cache/\n/transactions/\n/locks/\n/.init-transaction/\n",
  );
  plannedContents.set(
    MANIFEST_RELATIVE_PATH,
    serializeManifest(manifest),
  );
  if (legacyManifestContent !== null) {
    plannedContents.set(LEGACY_MANIFEST_RELATIVE_PATH, null);
  }
  for (const historyFile of sourceHistoryPlan.files) {
    plannedContents.set(historyFile.path, historyFile.content);
  }
  const previewedChanges = await Promise.all(
    [...plannedContents.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([relativePath, content]) => previewChange(root, relativePath, content)),
  );
  if (previewedChanges.some((change) =>
    isImmutableHistoryPath(change.path)
    && change.before !== null
    && change.before !== change.after)) {
    return initializationError(
      "history_collision",
      "Existing immutable Report or Evidence history differs from the supplied Audit; nothing was changed.",
      { recoverable: true },
    );
  }
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
    history_preexisting: previewedChanges
      .filter((change) => isLocalHistoryPath(change.path) && change.before === change.after)
      .map((change) => ({ path: change.path, digest: change.after_digest })),
    report_package: structuredClone(source),
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
      resume_token: await (dependencies.store_state ?? storeState)(state),
    },
    request: {
      type: "confirmation",
      prompt: "Apply exactly these local initialization changes?",
      choices: ["confirm", "decline"],
    },
  };
}

export async function runInit(cwd, version, options = {}, dependencies = {}) {
  const root = path.resolve(cwd);
  let lockScope;
  try {
    lockScope = await realpath(root);
  } catch (error) {
    return initializationError(
      error?.code ?? "invalid_repository_scope",
      "The explicit initialization repository root is unavailable.",
    );
  }
  const lockKey = createHash("sha256").update(lockScope).digest("hex");
  const temporaryRoot = await realpath(os.tmpdir());
  let release;
  try {
    release = await acquireOwnedLock(
      path.join(temporaryRoot, `launchrally-init-${lockKey}`),
      "init",
      dependencies.init_lock_operations,
    );
  } catch (error) {
    return initializationError(
      error?.code === "owned_lock_busy" ? "initialization_busy" : "invalid_initialization_lock",
      error?.code === "owned_lock_busy"
        ? "Another initialization or recovery operation is active for this repository."
        : "The initialization ownership lock is invalid and was preserved.",
      { recoverable: true },
    );
  }
  try {
    return await runInitLocked(cwd, version, options, dependencies);
  } finally {
    await release();
  }
}
