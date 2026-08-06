import { execFile } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  CLI_INTERACTION_CONTRACT,
  EVIDENCE_INDEX_SCHEMA,
  INIT_INTERACTION_SCHEMA,
  MANIFEST_SCHEMA,
  REPORT_VIEW_SCHEMA,
  assertSupportedManifestVersion,
  assertSupportedReportVersion,
} from "@launchrally/contracts";

export const CLI_DEPENDENCY = "@launchrally/cli";
const APPROVED_PATHS = new Set([
  ".launchrally/.gitignore",
  ".launchrally/launch-manifest.json",
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

function encodeState(state) {
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  const checksum = createHash("sha256").update(payload).digest("base64url");
  return `${payload}.${checksum}`;
}

function decodeState(token) {
  if (typeof token !== "string") return null;
  const [payload, suppliedChecksum, extra] = token.split(".");
  if (!payload || !suppliedChecksum || extra !== undefined) return null;
  const expected = createHash("sha256").update(payload).digest();
  let actual;
  try {
    actual = Buffer.from(suppliedChecksum, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return state?.schema_version === INIT_INTERACTION_SCHEMA ? state : null;
  } catch {
    return null;
  }
}

function declared(value) {
  return { state: "declared", value: structuredClone(value) };
}

function declaredOrUnknown(value, reason) {
  return value === null || value === undefined
    ? { state: "unknown", reason }
    : declared(value);
}

function declaredOrNotApplicable(values, reason) {
  return values.length > 0
    ? declared(values)
    : { state: "not_applicable", reason };
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
        )
        : {
          state: "unknown",
          reason: "The first Report did not confirm Provider intent.",
        },
    },
  };
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
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
    `+++ b/${relativePath}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function lockfileFor(packageManager) {
  return {
    npm: "package-lock.json",
    pnpm: "pnpm-lock.yaml",
    yarn: "yarn.lock",
    bun: "bun.lock",
  }[packageManager];
}

function alreadyExact({ packageManager, packageJson, lockfile, dependency, version }) {
  let parsedPackage;
  try {
    parsedPackage = JSON.parse(packageJson);
  } catch {
    return false;
  }
  if (parsedPackage.devDependencies?.[dependency] !== version) return false;
  if (packageManager !== "npm") {
    return lockfile.includes(dependency) && lockfile.includes(version);
  }
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
    operation: before === null ? "create" : "update",
    before,
    after,
    before_digest: before === null ? null : digest(before),
    after_digest: digest(after),
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

async function rollbackChanges(root, changes, operations) {
  try {
    for (const change of [...changes].reverse()) {
      const target = path.join(root, change.path);
      if (change.before === null) {
        await operations.remove_file(target);
      } else {
        await operations.mkdir(path.dirname(target), { recursive: true });
        await operations.write_file(target, change.before);
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function applyChanges(root, changes, fileOperations = {}) {
  const operations = fileOperationAdapter(fileOperations);
  const manifestPath = ".launchrally/launch-manifest.json";
  const ordered = [
    ...changes.filter((change) => change.path !== manifestPath),
    ...changes.filter((change) => change.path === manifestPath),
  ];
  const attempted = [];
  const recoveryPath = path.join(root, RECOVERY_RELATIVE_PATH);
  try {
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
      await operations.mkdir(path.dirname(target), { recursive: true });
      await operations.write_file(target, change.after);
    }
    await removeRecoveryJournal(root);
    return { applied: true, reverted: false };
  } catch {
    const reverted = await rollbackChanges(root, attempted, operations);
    if (reverted) {
      await removeRecoveryJournal(root);
      return { applied: false, reverted: true };
    }
    return { applied: false, reverted: false };
  }
}

async function recoverPendingInitialization(root) {
  const recoveryPath = path.join(root, RECOVERY_RELATIVE_PATH);
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
  const reverted = await rollbackChanges(root, journal.changes, fileOperationAdapter());
  if (!reverted) return false;
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

function hasCompleteReportPackage(source) {
  const report = source?.report;
  const reportView = source?.report_view;
  const evidenceIndex = source?.evidence_index;
  const releaseIntent = report?.scope?.release_intent;
  return source?.status === "completed"
    && source?.operation === "audit"
    && typeof report?.schema_version === "string"
    && typeof report?.report_id === "string"
    && typeof report?.scope?.project_root === "string"
    && typeof report?.scope?.project?.name === "string"
    && typeof report?.scope?.project?.type === "string"
    && typeof report?.scope?.project?.package_manager === "string"
    && typeof releaseIntent?.confirmed === "boolean"
    && Array.isArray(releaseIntent?.production_targets)
    && Array.isArray(releaseIntent?.core_journeys)
    && Array.isArray(releaseIntent?.support_layers)
    && Array.isArray(releaseIntent?.provider_roles)
    && typeof report?.scope?.public_verification?.decision === "string"
    && Array.isArray(report?.scope?.public_verification?.targets)
    && reportView?.schema_version === REPORT_VIEW_SCHEMA
    && reportView?.report_id === report.report_id
    && reportView?.report_schema_version === report.schema_version
    && evidenceIndex?.schema_version === EVIDENCE_INDEX_SCHEMA
    && evidenceIndex?.report_id === report.report_id
    && report?.execution?.evidence_index?.index_id === evidenceIndex.index_id;
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
  if (!options.report_package && !options.resume_token) return unavailable();
  if (options.resume_token) {
    const state = decodeState(options.resume_token);
    if (!state) {
      return {
        contract: CLI_INTERACTION_CONTRACT,
        status: "execution_error",
        operation: "init",
        error: "invalid_resume_token",
        message: "The initialization preview token is invalid or corrupted.",
      };
    }
    if (state.root !== root) {
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
      return {
        contract: CLI_INTERACTION_CONTRACT,
        status: "execution_error",
        operation: "init",
        error: "invalid_resume_token",
        message: "The initialization preview token contains an invalid change plan.",
      };
    }
    if (options.confirmation === "decline") {
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
  if (!hasCompleteReportPackage(source)) {
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
  const manifestPath = path.join(root, ".launchrally", "launch-manifest.json");
  const existingManifestContent = await readOptional(manifestPath);
  if (existingManifestContent !== null) {
    try {
      assertSupportedManifestVersion(JSON.parse(existingManifestContent));
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
  const mode = existingManifestContent === null ? "initialization" : "migration";
  const manifest = createManifest(source.report);
  const packageJson = await readFile(path.join(root, "package.json"), "utf8");
  const lockfilePath = lockfileFor(source.report.scope.project.package_manager);
  if (!lockfilePath) {
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "execution_error",
      operation: "init",
      error: "unsupported_package_manager",
      message: "Initialization cannot prepare an exact lockfile change for this package manager.",
    };
  }
  const lockfile = await readFile(path.join(root, lockfilePath), "utf8");
  const prepareDependencyChanges = dependencies.prepare_dependency_changes
    ?? defaultPrepareDependencyChanges;
  let dependencyChanges;
  try {
    dependencyChanges = await prepareDependencyChanges({
      cwd: root,
      package_manager: source.report.scope.project.package_manager,
      package_json: packageJson,
      lockfile: { path: lockfilePath, content: lockfile },
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
  const dependencyPaths = dependencyChanges.map((change) => change.path).sort();
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
    ".launchrally/launch-manifest.json",
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
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
      resume_token: encodeState(state),
    },
    request: {
      type: "confirmation",
      prompt: "Apply exactly these local initialization changes?",
      choices: ["confirm", "decline"],
    },
  };
}
