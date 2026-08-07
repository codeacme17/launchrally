import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
    contract: "launchrally.dev/cli/v2",
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

test("every required Report, View, and Evidence Index field is required before init", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const requiredFields = {
    report: [
      "schema_version",
      "report_id",
      "created_at",
      "assessment",
      "provenance",
      "policy",
      "scope",
      "permissions",
      "execution",
      "catalog",
      "results",
      "limitations",
    ],
    report_view: [
      "schema_version",
      "report_id",
      "report_schema_version",
      "generated_at",
      "format",
      "content",
    ],
    evidence_index: ["schema_version", "index_id", "report_id", "created_at", "entries"],
  };
  let plannerCalled = false;

  for (const [document, fields] of Object.entries(requiredFields)) {
    for (const field of fields) {
      const incomplete = structuredClone(audit);
      delete incomplete[document][field];
      const result = await runInit(
        directory,
        "0.1.0",
        { report_package: incomplete },
        {
          prepare_dependency_changes: async () => {
            plannerCalled = true;
            return [];
          },
        },
      );
      assert.equal(result.error, "invalid_report_package", `${document}.${field}`);
    }
  }

  assert.equal(plannerCalled, false);
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
  audit.report.schema_version = "launchrally.dev/report/v3";
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
    schema_version: "launchrally.dev/manifest/v2",
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
        evidence: [{
          source_report_id: audit.report.report_id,
          field: "scope.release_intent.support_layers",
        }],
      },
    },
    providers: {
      roles: {
        state: "not_applicable",
        reason: "No Provider roles were declared for this release.",
        evidence: [{
          source_report_id: audit.report.report_id,
          field: "scope.release_intent.provider_roles",
        }],
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(result.manifest), new RegExp(SECRET_SENTINEL));
  assert.deepEqual(result.preview.changes.map(({ path: changedPath, operation }) => ({
    path: changedPath,
    operation,
  })), [
    { path: ".launchrally/.gitignore", operation: "create" },
    { path: ".launchrally/manifest.yaml", operation: "create" },
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
    contract: "launchrally.dev/cli/v2",
    status: "completed",
    operation: "init",
    outcome: "initialization_declined",
    changes_applied: [],
  });
  assert.deepEqual(await readdir(directory), ["package-lock.json", "package.json"]);
  assert.equal(await readFile(path.join(directory, "package.json"), "utf8"), packageBefore);
  assert.equal(await readFile(path.join(directory, "package-lock.json"), "utf8"), lockBefore);
});

test("a forged preview token cannot substitute different confirmed contents", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const preview = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );
  const substituted = {
    schema_version: preview.interaction.schema_version,
    root: directory,
    source_report_id: preview.source_report_id,
    mode: preview.mode,
    manifest: preview.manifest,
    changes: structuredClone(preview.preview.changes),
  };
  substituted.changes.find((change) => change.path === "package.json").after =
    "{\"forged\":true}\n";
  const forgedPayload = Buffer.from(JSON.stringify(substituted), "utf8").toString("base64url");
  const forgedChecksum = createHash("sha256").update(forgedPayload).digest("base64url");

  const result = await runInit(directory, "0.1.0", {
    resume_token: `${forgedPayload}.${forgedChecksum}`,
    confirmation: "confirm",
  });

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "invalid_resume_token");
  assert.doesNotMatch(await readFile(path.join(directory, "package.json"), "utf8"), /forged/u);
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
    contract: "launchrally.dev/cli/v2",
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
    [".gitignore", "manifest.yaml"],
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
    contract: "launchrally.dev/cli/v2",
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
    contract: "launchrally.dev/cli/v2",
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
    contract: "launchrally.dev/cli/v2",
    status: "completed",
    operation: "init",
    outcome: "initialization_recovered",
    changes_applied: [],
  });
  assert.equal(await readFile(path.join(directory, "package.json"), "utf8"), packageBefore);
  assert.equal(await readFile(path.join(directory, "package-lock.json"), "utf8"), lockBefore);
  assert.deepEqual(await readdir(directory), ["package-lock.json", "package.json"]);
});

test("recovery fails closed without overwriting a post-crash user edit", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const preview = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );
  await runInit(
    directory,
    "0.1.0",
    { resume_token: preview.interaction.resume_token, confirmation: "confirm" },
    {
      file_operations: {
        write_file: async (target, content) => {
          if (target === path.join(directory, "package.json")) throw new Error("stop apply");
          await writeFile(target, content, "utf8");
        },
      },
    },
  );
  const userEdit = "{\"user_edit_after_crash\":true}\n";
  await writeFile(path.join(directory, "package-lock.json"), userEdit);

  const result = await runInit(directory, "0.1.0");

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "initialization_recovery_conflict");
  assert.equal(await readFile(path.join(directory, "package-lock.json"), "utf8"), userEdit);
});

test("a symlinked LaunchRally directory cannot redirect initialization outside the project", async () => {
  const directory = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "launchrally-outside-"));
  const audit = await completeAudit(directory);
  await symlink(outside, path.join(directory, ".launchrally"));
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
  assert.equal(result.error, "unsafe_project_path");
  assert.equal(plannerCalled, false);
  assert.deepEqual(await readdir(outside), []);
});

test("non-npm lockfiles must bind the exact CLI dependency and version", async () => {
  const directory = await fixture();
  const audit = structuredClone(await completeAudit(directory));
  audit.report.scope.project.package_manager = "pnpm";
  await rm(path.join(directory, "package-lock.json"));
  await writeFile(path.join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  const result = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    {
      prepare_dependency_changes: async ({ package_json: packageJson }) => {
        const manifest = JSON.parse(packageJson);
        manifest.devDependencies = { "@launchrally/cli": "0.1.0" };
        return [
          { path: "package.json", content: `${JSON.stringify(manifest)}\n` },
          {
            path: "pnpm-lock.yaml",
            content: "notes: '@launchrally/cli is mentioned; another package is 0.1.0'\n",
          },
        ];
      },
    },
  );

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "invalid_dependency_plan");
});

test("pnpm, Yarn, and text Bun lockfiles accept exact manager-specific bindings", async () => {
  const cases = [
    {
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      planned: [
        "lockfileVersion: '9.0'",
        "importers:",
        "  .:",
        "    devDependencies:",
        "      '@launchrally/cli':",
        "        specifier: 0.1.0",
        "        version: 0.1.0",
        "",
      ].join("\n"),
    },
    {
      manager: "yarn",
      lockfile: "yarn.lock",
      planned: '"@launchrally/cli@0.1.0":\n  version "0.1.0"\n',
    },
    {
      manager: "bun",
      lockfile: "bun.lock",
      planned: '{"packages":{"@launchrally/cli":["@launchrally/cli@0.1.0",""]}}\n',
    },
  ];

  for (const fixtureCase of cases) {
    const directory = await fixture();
    const audit = structuredClone(await completeAudit(directory));
    audit.report.scope.project.package_manager = fixtureCase.manager;
    await rm(path.join(directory, "package-lock.json"));
    await writeFile(path.join(directory, fixtureCase.lockfile), "initial lock\n");

    const result = await runInit(
      directory,
      "0.1.0",
      { report_package: audit },
      {
        prepare_dependency_changes: async ({ package_json: packageJson }) => {
          const manifest = JSON.parse(packageJson);
          manifest.devDependencies = { "@launchrally/cli": "0.1.0" };
          return [
            { path: "package.json", content: `${JSON.stringify(manifest)}\n` },
            { path: fixtureCase.lockfile, content: fixtureCase.planned },
          ];
        },
      },
    );

    assert.equal(result.status, "needs_confirmation", fixtureCase.manager);
    assert.ok(
      result.preview.changes.some((change) => change.path === fixtureCase.lockfile),
      fixtureCase.manager,
    );
  }
});

test("legacy binary Bun lockfiles fail deliberately without planning or writes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-bun-init-"));
  await writeFile(path.join(directory, "package.json"), '{"name":"bun-web"}\n');
  const binaryLock = Buffer.from([0, 1, 2, 3, 255]);
  await writeFile(path.join(directory, "bun.lockb"), binaryLock);
  const audit = await completeAudit(directory);
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
  assert.equal(result.error, "unsupported_binary_lockfile");
  assert.equal(result.recoverable, true);
  assert.equal(plannerCalled, false);
  assert.deepEqual(await readFile(path.join(directory, "bun.lockb")), binaryLock);
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
  const futureManifest = "schema_version: launchrally.dev/manifest/v3\n";
  await writeFile(
    path.join(directory, ".launchrally", "manifest.yaml"),
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
    await readFile(path.join(directory, ".launchrally", "manifest.yaml"), "utf8"),
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
  const manifestPath = path.join(directory, ".launchrally", "manifest.yaml");
  const legacyPath = path.join(directory, ".launchrally", "launch-manifest.json");
  const legacy = structuredClone(initialPreview.manifest);
  legacy.schema_version = "launchrally.dev/manifest/v1";
  legacy.support.layers = {
    state: "unknown",
    reason: "Legacy Manifest did not capture support intent.",
  };
  delete legacy.providers.roles.evidence;
  const legacyContent = `${JSON.stringify(legacy, null, 2)}\n`;
  await rm(manifestPath);
  await writeFile(legacyPath, legacyContent);

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
    ".launchrally/manifest.yaml",
  ]);
  assert.equal(migration.preview.changes[0].before, legacyContent);
  assert.equal(migration.preview.changes[0].after, null);
  assert.match(
    migration.preview.changes[0].diff,
    /^--- a\/\.launchrally\/launch-manifest\.json\n\+\+\+ \/dev\/null\n@@/u,
  );
  assert.equal(await readFile(legacyPath, "utf8"), legacyContent);

  const applied = await runInit(directory, "0.1.0", {
    resume_token: migration.interaction.resume_token,
    confirmation: "confirm",
  });
  assert.equal(applied.outcome, "migrated");
  await assert.rejects(readFile(legacyPath, "utf8"), { code: "ENOENT" });
  assert.equal(await readFile(manifestPath, "utf8"), migration.preview.changes[1].after);
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
    ".launchrally/manifest.yaml",
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
  assert.match(processResult.stdout, /CREATE \.launchrally\/manifest\.yaml/u);
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
