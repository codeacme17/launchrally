import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { runAudit, runInit } from "../packages/core/src/index.js";

const execFileAsync = promisify(execFile);
const cli = path.resolve("packages/cli/bin/rally.js");
const SECRET_SENTINEL = "manifest-secret-must-not-survive";

const ANSWERS = Object.freeze({
  intended_environment: "production",
  production_targets: ["https://example.com"],
  core_journeys: ["homepage loads"],
  provider_roles: [],
  support_layers: [],
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-init-"));
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "init-web",
      scripts: { build: "vite build" },
      private_config: SECRET_SENTINEL,
    }, null, 2),
  );
  await writeFile(
    path.join(directory, "package-lock.json"),
    JSON.stringify({ name: "init-web", lockfileVersion: 3, packages: { "": {} } }, null, 2),
  );
  return directory;
}

async function fixtureWithCliDependency() {
  const directory = await fixture();
  const changes = await prepareNpmChanges({
    package_json: await readFile(path.join(directory, "package.json"), "utf8"),
    lockfile: {
      path: "package-lock.json",
      content: await readFile(path.join(directory, "package-lock.json"), "utf8"),
    },
    dependency: "@launchrally/cli",
    version: "0.1.0",
  });
  for (const change of changes) {
    await writeFile(path.join(directory, change.path), change.content);
  }
  return directory;
}

async function completeAudit(directory) {
  const initial = await runAudit(directory, "0.1.0");
  const confirmation = await runAudit(directory, "0.1.0", {
    resume_token: initial.interaction.resume_token,
    answers: ANSWERS,
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

async function unconfirmedAudit(directory) {
  const initial = await runAudit(directory, "0.1.0");
  const confirmation = await runAudit(directory, "0.1.0", {
    resume_token: initial.interaction.resume_token,
    answers: ANSWERS,
  });
  return runAudit(directory, "0.1.0", {
    resume_token: confirmation.interaction.resume_token,
    confirmation: "cancel",
  });
}

async function prepareNpmChanges({ package_json, lockfile, dependency, version }) {
  const packageJson = JSON.parse(package_json);
  packageJson.devDependencies = {
    ...(packageJson.devDependencies ?? {}),
    [dependency]: version,
  };
  const packageLock = JSON.parse(lockfile.content);
  packageLock.packages[""].devDependencies = {
    ...(packageLock.packages[""].devDependencies ?? {}),
    [dependency]: version,
  };
  packageLock.packages[`node_modules/${dependency}`] = {
    version,
    dev: true,
  };
  return [
    { path: "package.json", content: `${JSON.stringify(packageJson, null, 2)}\n` },
    { path: lockfile.path, content: `${JSON.stringify(packageLock, null, 2)}\n` },
  ];
}

test("initialization is unavailable until a complete first Report is supplied", async () => {
  const directory = await fixture();
  const before = await readdir(directory);

  const result = await runInit(directory, "0.1.0");

  assert.deepEqual(result, {
    contract: "launchrally.dev/cli/v0",
    status: "unavailable",
    operation: "init",
    reason: "complete_report_required",
    message: "Run a complete Audit and supply its saved JSON output before initialization.",
  });
  assert.deepEqual(await readdir(directory), before);
});

test("an incomplete saved Audit bundle fails closed before dependency planning", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const packageBefore = await readFile(path.join(directory, "package.json"), "utf8");
  let plannerCalled = false;

  const result = await runInit(
    directory,
    "0.1.0",
    {
      report_package: {
        status: audit.status,
        operation: audit.operation,
        report: audit.report,
      },
    },
    {
      prepare_dependency_changes: async () => {
        plannerCalled = true;
        return [];
      },
    },
  );

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "invalid_report_package");
  assert.equal(plannerCalled, false);
  assert.equal(await readFile(path.join(directory, "package.json"), "utf8"), packageBefore);
  assert.deepEqual(await readdir(directory), ["package-lock.json", "package.json"]);
});

test("a complete Report from another project root fails closed before dependency planning", async () => {
  const sourceDirectory = await fixture();
  const targetDirectory = await fixture();
  const audit = await completeAudit(sourceDirectory);
  const packageBefore = await readFile(path.join(targetDirectory, "package.json"), "utf8");
  let plannerCalled = false;

  const result = await runInit(
    targetDirectory,
    "0.1.0",
    { report_package: audit },
    {
      prepare_dependency_changes: async () => {
        plannerCalled = true;
        return [];
      },
    },
  );

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "report_scope_mismatch");
  assert.equal(plannerCalled, false);
  assert.equal(await readFile(path.join(targetDirectory, "package.json"), "utf8"), packageBefore);
  assert.deepEqual(await readdir(targetDirectory), ["package-lock.json", "package.json"]);
});

test("an unsupported future Report major fails closed before dependency planning", async () => {
  const directory = await fixture();
  const audit = structuredClone(await completeAudit(directory));
  audit.report.schema_version = "launchrally.dev/report/v2";
  let plannerCalled = false;

  const result = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    {
      prepare_dependency_changes: async () => {
        plannerCalled = true;
        return [];
      },
    },
  );

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "unsupported_report_version");
  assert.equal(plannerCalled, false);
  assert.deepEqual(await readdir(directory), ["package-lock.json", "package.json"]);
});

test("a complete Report produces an exact secret-free preview without repository writes", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const packageBefore = await readFile(path.join(directory, "package.json"), "utf8");
  const lockBefore = await readFile(path.join(directory, "package-lock.json"), "utf8");

  const result = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );

  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.operation, "init");
  assert.equal(result.source_report_id, audit.report.report_id);
  assert.ok(result.interaction.resume_token.length > 20);
  assert.deepEqual(result.manifest, {
    schema_version: "launchrally.dev/manifest/v1",
    project: {
      name: { state: "declared", value: "init-web" },
      type: { state: "declared", value: "web" },
      package_manager: { state: "declared", value: "npm" },
    },
    release: {
      intended_environment: { state: "declared", value: "production" },
      production_targets: { state: "declared", value: ["https://example.com/"] },
      core_journeys: { state: "declared", value: ["homepage loads"] },
    },
    execution: {
      source_report_id: { state: "declared", value: audit.report.report_id },
      assessment: { state: "declared", value: "inconclusive" },
      public_verification: {
        state: "declared",
        value: { decision: "denied", targets: ["https://example.com/"] },
      },
    },
    support: {
      layers: {
        state: "not_applicable",
        reason: "No support layers were declared for this release.",
      },
    },
    providers: {
      roles: {
        state: "not_applicable",
        reason: "No Provider roles were declared for this release.",
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(result.manifest), new RegExp(SECRET_SENTINEL));
  assert.deepEqual(result.preview.changes.map(({ path: changedPath, operation }) => ({
    path: changedPath,
    operation,
  })), [
    { path: ".launchrally/.gitignore", operation: "create" },
    { path: ".launchrally/launch-manifest.json", operation: "create" },
    { path: "package-lock.json", operation: "update" },
    { path: "package.json", operation: "update" },
  ]);
  assert.ok(result.preview.changes.every((change) => change.after_digest.startsWith("sha256:")));
  assert.equal(
    result.preview.changes.find((change) => change.path === ".launchrally/.gitignore").after,
    "/reports/\n/evidence/\n/.init-transaction/\n",
  );
  assert.deepEqual(await readdir(directory), ["package-lock.json", "package.json"]);
  assert.equal(await readFile(path.join(directory, "package.json"), "utf8"), packageBefore);
  assert.equal(await readFile(path.join(directory, "package-lock.json"), "utf8"), lockBefore);
});

test("declining the exact preview leaves the repository unchanged", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const preview = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );
  const packageBefore = await readFile(path.join(directory, "package.json"), "utf8");
  const lockBefore = await readFile(path.join(directory, "package-lock.json"), "utf8");

  const result = await runInit(directory, "0.1.0", {
    resume_token: preview.interaction.resume_token,
    confirmation: "decline",
  });

  assert.deepEqual(result, {
    contract: "launchrally.dev/cli/v0",
    status: "completed",
    operation: "init",
    outcome: "initialization_declined",
    changes_applied: [],
  });
  assert.deepEqual(await readdir(directory), ["package-lock.json", "package.json"]);
  assert.equal(await readFile(path.join(directory, "package.json"), "utf8"), packageBefore);
  assert.equal(await readFile(path.join(directory, "package-lock.json"), "utf8"), lockBefore);
});

test("confirming applies exactly the previewed initialization files", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const preview = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );

  const result = await runInit(directory, "0.1.0", {
    resume_token: preview.interaction.resume_token,
    confirmation: "confirm",
  });

  assert.deepEqual(result, {
    contract: "launchrally.dev/cli/v0",
    status: "completed",
    operation: "init",
    outcome: "initialized",
    source_report_id: audit.report.report_id,
    changes_applied: preview.preview.changes.map((change) => change.path),
  });
  for (const change of preview.preview.changes) {
    assert.equal(await readFile(path.join(directory, change.path), "utf8"), change.after);
  }
  assert.deepEqual(
    JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")).devDependencies,
    { "@launchrally/cli": "0.1.0" },
  );
  assert.deepEqual(
    (await readdir(path.join(directory, ".launchrally"))).sort(),
    [".gitignore", "launch-manifest.json"],
  );
});

test("a stale preview fails before applying any initialization change", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const preview = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );
  await writeFile(path.join(directory, "package.json"), "{\"changed\":true}\n");

  const result = await runInit(directory, "0.1.0", {
    resume_token: preview.interaction.resume_token,
    confirmation: "confirm",
  });

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "preview_stale");
  assert.deepEqual(await readdir(directory), ["package-lock.json", "package.json"]);
});

test("a partial filesystem failure rolls back every attempted change", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const preview = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );
  const packageBefore = await readFile(path.join(directory, "package.json"), "utf8");
  const lockBefore = await readFile(path.join(directory, "package-lock.json"), "utf8");
  let failed = false;

  const result = await runInit(
    directory,
    "0.1.0",
    {
      resume_token: preview.interaction.resume_token,
      confirmation: "confirm",
    },
    {
      file_operations: {
        write_file: async (target, content) => {
          if (!failed && target === path.join(directory, "package.json")) {
            failed = true;
            throw new Error("simulated partial write failure");
          }
          await writeFile(target, content, "utf8");
        },
      },
    },
  );

  assert.deepEqual(result, {
    contract: "launchrally.dev/cli/v0",
    status: "execution_error",
    operation: "init",
    error: "initialization_failed_reverted",
    message: "Initialization failed and every attempted change was reverted.",
    recoverable: true,
    changes_applied: [],
  });
  assert.equal(await readFile(path.join(directory, "package.json"), "utf8"), packageBefore);
  assert.equal(await readFile(path.join(directory, "package-lock.json"), "utf8"), lockBefore);
  assert.deepEqual(await readdir(directory), ["package-lock.json", "package.json"]);
});

test("dependency planning failures are recoverable and leave the repository unchanged", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const packageBefore = await readFile(path.join(directory, "package.json"), "utf8");
  const lockBefore = await readFile(path.join(directory, "package-lock.json"), "utf8");

  const result = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    {
      prepare_dependency_changes: async () => {
        throw new Error("registry unavailable");
      },
    },
  );

  assert.deepEqual(result, {
    contract: "launchrally.dev/cli/v0",
    status: "execution_error",
    operation: "init",
    error: "dependency_plan_failed",
    message: "The exact CLI dependency and lockfile preview could not be prepared; nothing was changed.",
    recoverable: true,
  });
  assert.equal(await readFile(path.join(directory, "package.json"), "utf8"), packageBefore);
  assert.equal(await readFile(path.join(directory, "package-lock.json"), "utf8"), lockBefore);
  assert.deepEqual(await readdir(directory), ["package-lock.json", "package.json"]);
});

test("an interrupted rollback leaves an ignored recovery journal that the next init repairs", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const preview = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );
  const packageBefore = await readFile(path.join(directory, "package.json"), "utf8");
  const lockBefore = await readFile(path.join(directory, "package-lock.json"), "utf8");

  const failed = await runInit(
    directory,
    "0.1.0",
    {
      resume_token: preview.interaction.resume_token,
      confirmation: "confirm",
    },
    {
      file_operations: {
        write_file: async (target, content) => {
          if (target === path.join(directory, "package.json")) {
            throw new Error("simulated persistent write failure");
          }
          await writeFile(target, content, "utf8");
        },
      },
    },
  );

  assert.equal(failed.error, "initialization_recovery_required");
  const journalPath = path.join(
    directory,
    ".launchrally",
    ".init-transaction",
    "recovery.json",
  );
  assert.equal(JSON.parse(await readFile(journalPath, "utf8")).root, directory);

  const recovered = await runInit(directory, "0.1.0");

  assert.deepEqual(recovered, {
    contract: "launchrally.dev/cli/v0",
    status: "completed",
    operation: "init",
    outcome: "initialization_recovered",
    changes_applied: [],
  });
  assert.equal(await readFile(path.join(directory, "package.json"), "utf8"), packageBefore);
  assert.equal(await readFile(path.join(directory, "package-lock.json"), "utf8"), lockBefore);
  assert.deepEqual(await readdir(directory), ["package-lock.json", "package.json"]);
});

test("unconfirmed Report intent remains reasoned Unknown rather than inferred or Not Applicable", async () => {
  const directory = await fixture();
  const audit = await unconfirmedAudit(directory);

  const result = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );

  assert.deepEqual(result.manifest.release, {
    intended_environment: {
      state: "unknown",
      reason: "The first Report did not confirm an intended environment.",
    },
    production_targets: {
      state: "unknown",
      reason: "The first Report did not confirm production targets.",
    },
    core_journeys: {
      state: "unknown",
      reason: "The first Report did not confirm core journeys.",
    },
  });
  assert.deepEqual(result.manifest.support.layers, {
    state: "unknown",
    reason: "The first Report did not confirm support-layer intent.",
  });
  assert.deepEqual(result.manifest.providers.roles, {
    state: "unknown",
    reason: "The first Report did not confirm Provider intent.",
  });
});

test("an unsupported future Manifest major fails closed without planning or writes", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  await mkdir(path.join(directory, ".launchrally"));
  const futureManifest = '{"schema_version":"launchrally.dev/manifest/v2"}\n';
  await writeFile(
    path.join(directory, ".launchrally", "launch-manifest.json"),
    futureManifest,
  );
  let plannerCalled = false;

  const result = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    {
      prepare_dependency_changes: async () => {
        plannerCalled = true;
        return [];
      },
    },
  );

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "unsupported_manifest_version");
  assert.equal(plannerCalled, false);
  assert.equal(
    await readFile(path.join(directory, ".launchrally", "launch-manifest.json"), "utf8"),
    futureManifest,
  );
});

test("a supported Manifest migration shows only its exact diff and requires approval", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const initialPreview = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );
  await runInit(directory, "0.1.0", {
    resume_token: initialPreview.interaction.resume_token,
    confirmation: "confirm",
  });
  const manifestPath = path.join(directory, ".launchrally", "launch-manifest.json");
  const legacy = JSON.parse(await readFile(manifestPath, "utf8"));
  legacy.support.layers = {
    state: "unknown",
    reason: "Legacy Manifest did not capture support intent.",
  };
  const legacyContent = `${JSON.stringify(legacy, null, 2)}\n`;
  await writeFile(manifestPath, legacyContent);

  const migration = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );

  assert.equal(migration.status, "needs_confirmation");
  assert.equal(migration.mode, "migration");
  assert.deepEqual(migration.preview.changes.map((change) => change.path), [
    ".launchrally/launch-manifest.json",
  ]);
  assert.equal(migration.preview.changes[0].before, legacyContent);
  assert.notEqual(migration.preview.changes[0].after, legacyContent);
  assert.match(
    migration.preview.changes[0].diff,
    /^--- a\/\.launchrally\/launch-manifest\.json\n\+\+\+ b\/\.launchrally\/launch-manifest\.json\n@@/u,
  );
  assert.equal(await readFile(manifestPath, "utf8"), legacyContent);

  const applied = await runInit(directory, "0.1.0", {
    resume_token: migration.interaction.resume_token,
    confirmation: "confirm",
  });
  assert.equal(applied.outcome, "migrated");
  assert.equal(await readFile(manifestPath, "utf8"), migration.preview.changes[0].after);
});

test("the CLI keeps init unavailable when no complete Report is supplied", async () => {
  const directory = await fixture();

  await assert.rejects(
    execFileAsync(process.execPath, [cli, "init", "--json", "--cwd", directory]),
    (error) => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.status, "unavailable");
      assert.equal(result.operation, "init");
      assert.equal(result.reason, "complete_report_required");
      return true;
    },
  );
});

test("the CLI previews a saved complete Audit and decline applies nothing", async () => {
  const directory = await fixtureWithCliDependency();
  const audit = await completeAudit(directory);
  const reportDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrally-report-file-"));
  const reportPath = path.join(reportDirectory, "audit.json");
  await writeFile(reportPath, JSON.stringify(audit));

  const previewProcess = await execFileAsync(process.execPath, [
    cli,
    "init",
    "--json",
    "--cwd",
    directory,
    "--report",
    reportPath,
  ]);
  const preview = JSON.parse(previewProcess.stdout);

  assert.equal(preview.status, "needs_confirmation");
  assert.deepEqual(preview.preview.changes.map((change) => change.path), [
    ".launchrally/.gitignore",
    ".launchrally/launch-manifest.json",
  ]);
  assert.deepEqual(await readdir(directory), ["package-lock.json", "package.json"]);

  const declineProcess = await execFileAsync(process.execPath, [
    cli,
    "init",
    "--json",
    "--cwd",
    directory,
    "--resume",
    preview.interaction.resume_token,
    "--confirm",
    "decline",
  ]);
  assert.equal(JSON.parse(declineProcess.stdout).outcome, "initialization_declined");
  assert.deepEqual(await readdir(directory), ["package-lock.json", "package.json"]);
});

test("Human Mode renders every exact initialization change before confirmation", async () => {
  const directory = await fixtureWithCliDependency();
  const audit = await completeAudit(directory);
  const reportDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrally-human-report-"));
  const reportPath = path.join(reportDirectory, "audit.json");
  await writeFile(reportPath, JSON.stringify(audit));

  const processResult = await execFileAsync(process.execPath, [
    cli,
    "init",
    "--cwd",
    directory,
    "--report",
    reportPath,
  ]);

  assert.match(processResult.stdout, /^LaunchRally Initialization Preview/mu);
  assert.match(processResult.stdout, /CREATE \.launchrally\/\.gitignore/u);
  assert.match(processResult.stdout, /\/reports\/\n\/evidence\/\n\/\.init-transaction\//u);
  assert.match(processResult.stdout, /CREATE \.launchrally\/launch-manifest\.json/u);
  assert.match(processResult.stdout, /Apply exactly these local initialization changes\?/u);
  assert.match(processResult.stdout, /Resume token: .{20,}/u);
});

test("initialization never stages or commits its project-owned files", async () => {
  const directory = await fixture();
  await execFileAsync("git", ["init"], { cwd: directory });
  await execFileAsync("git", ["add", "package.json", "package-lock.json"], {
    cwd: directory,
  });
  const stagedBefore = (await execFileAsync("git", ["diff", "--cached", "--name-only"], {
    cwd: directory,
  })).stdout;
  const audit = await completeAudit(directory);
  const preview = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );

  await runInit(directory, "0.1.0", {
    resume_token: preview.interaction.resume_token,
    confirmation: "confirm",
  });

  const stagedAfter = (await execFileAsync("git", ["diff", "--cached", "--name-only"], {
    cwd: directory,
  })).stdout;
  const status = (await execFileAsync("git", ["status", "--short"], { cwd: directory })).stdout;
  assert.equal(stagedAfter, stagedBefore);
  assert.doesNotMatch(stagedAfter, /\.launchrally/u);
  assert.match(status, /\?\? \.launchrally\//u);
});
