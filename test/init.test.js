import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  renderReportMarkdown,
  resolveExecutionAuthority,
  runAudit,
  runInit,
  runVerify,
} from "../packages/core/src/index.js";
import {
  isOfflineResolutionMiss,
  npmExecFileCommand,
} from "../packages/core/src/initialization.js";
import { createHistoryFiles, persistLocalHistory } from "../packages/core/src/local-history.js";
import {
  materializeExactToolchain,
  prepareExactToolchainChanges as prepareNpmChanges,
  writeExactToolchain,
} from "./helpers/exact-toolchain.js";
import { simulateExtendedMkdtempSuffix } from "./helpers/temporary-state-token.js";

const execFileAsync = promisify(execFile);
const cli = path.resolve("packages/cli/bin/rally.js");
const engine = path.resolve("packages/cli/bin/engine.js");
const SECRET_SENTINEL = "manifest-secret-must-not-survive";

test("Windows npm execution uses an explicit command interpreter without shell mode", () => {
  assert.deepEqual(
    npmExecFileCommand(["ci", "--ignore-scripts"], {
      platform: "win32",
      command_interpreter: "C:\\Windows\\System32\\cmd.exe",
    }),
    {
      executable: "C:\\Windows\\System32\\cmd.exe",
      arguments: ["/d", "/s", "/c", "npm", "ci", "--ignore-scripts"],
      shell: false,
    },
  );
});

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

async function fixtureWithCliDependency(version = "0.1.0") {
  const directory = await fixture();
  const changes = await prepareNpmChanges({
    package_json: `${JSON.stringify({
      name: "launchrally-toolchain",
      private: true,
      version: "0.0.0",
      devDependencies: { "@launchrally/cli": version },
    }, null, 2)}\n`,
    package_path: ".launchrally/toolchain/package.json",
    lockfile: {
      path: ".launchrally/toolchain/package-lock.json",
      content: `${JSON.stringify({
        name: "launchrally-toolchain",
        version: "0.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": {} },
      }, null, 2)}\n`,
    },
    dependency: "@launchrally/cli",
    version,
  });
  for (const change of changes) {
    await mkdir(path.dirname(path.join(directory, change.path)), { recursive: true });
    await writeFile(path.join(directory, change.path), change.content);
  }
  return directory;
}

async function currentCliPackage() {
  return JSON.parse(await readFile(
    path.resolve("packages/cli/package.json"),
    "utf8",
  ));
}

async function prepareMaterializedToolchain(request) {
  const changes = prepareNpmChanges(request);
  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "launchrally-init-materialized-"));
  await mkdir(path.join(stagingRoot, ".launchrally"));
  await writeExactToolchain(stagingRoot, request.version);
  await materializeExactToolchain(stagingRoot, request.version);
  Object.defineProperty(changes, "materialization", {
    enumerable: false,
    value: {
      staging_path: path.join(stagingRoot, ".launchrally", "toolchain"),
      package_count: 9,
      integrity_digest: `sha256:${"a".repeat(64)}`,
      command: {
        executable: "npm",
        arguments: [
          "install",
          "--ignore-scripts",
          "--save-dev",
          "--save-exact",
          "--no-audit",
          "--no-fund",
          "--offline",
          `@launchrally/cli@${request.version}`,
        ],
        shell: false,
      },
    },
  });
  return changes;
}

async function prepareNpmChangesWithCliDependencies(request, dependencies) {
  const changes = await prepareNpmChanges(request);
  const lockChange = changes.find(
    ({ path: changedPath }) => changedPath.endsWith("package-lock.json"),
  );
  const lockfile = JSON.parse(lockChange.content);
  lockfile.packages["node_modules/@launchrally/cli"].dependencies = dependencies;
  lockChange.content = `${JSON.stringify(lockfile, null, 2)}\n`;
  return changes;
}

async function completeAudit(directory, answers = ANSWERS, permissionDecisions = {
  public_verification: "denied",
}) {
  const initial = await runAudit(directory, "0.1.0");
  const confirmation = await runAudit(directory, "0.1.0", {
    resume_token: initial.interaction.resume_token,
    answers,
  });
  const permission = await runAudit(directory, "0.1.0", {
    resume_token: confirmation.interaction.resume_token,
    confirmation: "confirm",
  });
  return runAudit(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: permissionDecisions,
  });
}

test("Init preserves protected journey declarations without authenticated results", async () => {
  const directory = await fixture();
  const protectedJourney = {
    schema_version: "launchrally.dev/protected-journey/v1",
    method: "GET",
    path: "/control",
    purpose: "staff Control Room loads",
    access: {
      authentication_class: "staff",
      anonymous_status_codes: [404],
      authenticated_status_codes: [200],
    },
  };
  const audit = await completeAudit(
    directory,
    { ...ANSWERS, core_journeys: [protectedJourney] },
    {
      public_verification: "denied",
      authenticated_journey_verification: "denied",
    },
  );
  const preview = await runInit(directory, "0.1.0", {
    report_package: audit,
  }, {
    prepare_dependency_changes: prepareNpmChanges,
  });

  assert.equal(preview.status, "needs_confirmation", JSON.stringify(preview));
  assert.deepEqual(preview.manifest.release.core_journeys, {
    state: "declared",
    value: [protectedJourney],
  });
  assert.doesNotMatch(
    JSON.stringify(preview.manifest),
    /journey_results|session=|bearer\s|"cookie"|"headers"/iu,
  );
});

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

test("Init adopts every ecosystem through an isolated committed npm toolchain", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const packageBefore = await readFile(path.join(directory, "package.json"), "utf8");
  const applicationLockBefore = await readFile(
    path.join(directory, "package-lock.json"),
    "utf8",
  );

  const preview = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );

  assert.equal(preview.status, "needs_confirmation");
  const changedPaths = preview.preview.changes.map(({ path: changedPath }) => changedPath);
  assert.ok(changedPaths.includes(".launchrally/toolchain/package.json"));
  assert.ok(changedPaths.includes(".launchrally/toolchain/package-lock.json"));
  assert.equal(changedPaths.includes("package.json"), false);
  assert.equal(changedPaths.includes("package-lock.json"), false);

  const completed = await runInit(directory, "0.1.0", {
    resume_token: preview.interaction.resume_token,
    confirmation: "confirm",
  });

  assert.equal(completed.status, "completed");
  assert.equal(await readFile(path.join(directory, "package.json"), "utf8"), packageBefore);
  assert.equal(
    await readFile(path.join(directory, "package-lock.json"), "utf8"),
    applicationLockBefore,
  );
  assert.deepEqual(
    JSON.parse(await readFile(
      path.join(directory, ".launchrally", "toolchain", "package.json"),
      "utf8",
    )).devDependencies,
    { "@launchrally/cli": "0.1.0" },
  );
});

test("Init accepts the published CLI dependency graph", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const cliPackage = await currentCliPackage();

  const preview = await runInit(
    directory,
    cliPackage.version,
    { report_package: audit },
    {
      prepare_dependency_changes: (request) => prepareNpmChangesWithCliDependencies(
        request,
        cliPackage.dependencies,
      ),
    },
  );

  assert.equal(preview.status, "needs_confirmation");
});

test("Init rejects an unexpected direct CLI dependency", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const cliPackage = await currentCliPackage();
  const dependencies = {
    ...cliPackage.dependencies,
    unexpected: "1.0.0",
  };

  const result = await runInit(
    directory,
    cliPackage.version,
    { report_package: audit },
    {
      prepare_dependency_changes: (request) => prepareNpmChangesWithCliDependencies(
        request,
        dependencies,
      ),
    },
  );

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "invalid_dependency_plan");
});

test("Init refuses to rewrite an established invalid toolchain", async () => {
  const directory = await fixture();
  const toolchain = path.join(directory, ".launchrally", "toolchain");
  await mkdir(toolchain, { recursive: true });
  await writeFile(path.join(toolchain, "package.json"), `${JSON.stringify({
    name: "launchrally-toolchain",
    private: true,
    version: "0.0.0",
    scripts: { preinstall: "must-not-run" },
    devDependencies: { "@launchrally/cli": "0.1.0" },
  })}\n`);
  await writeFile(path.join(toolchain, "package-lock.json"), `${JSON.stringify({
    name: "launchrally-toolchain",
    version: "0.0.0",
    lockfileVersion: 3,
    packages: {
      "": { devDependencies: { "@launchrally/cli": "0.1.0" } },
      "node_modules/@launchrally/cli": {
        version: "0.1.0",
        resolved: "file:../../untrusted-cli",
      },
    },
  })}\n`);
  const audit = await completeAudit(directory);

  const result = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "invalid_project_toolchain");
  assert.match(await readFile(path.join(toolchain, "package.json"), "utf8"), /must-not-run/u);
});

test("Init pins the transitive UI closure before npm resolves caret ranges", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const overrides = {
    "@clack/core": "1.4.3",
    "fast-string-truncated-width": "3.0.3",
    "fast-string-width": "3.0.2",
    "fast-wrap-ansi": "0.2.2",
    sisteransi: "1.0.5",
  };

  const preview = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    {
      prepare_dependency_changes: async (request) => {
        const changes = await prepareNpmChanges(request);
        if (!JSON.parse(request.package_json).overrides) {
          const lockChange = changes.find(
            ({ path: changedPath }) => changedPath.endsWith("package-lock.json"),
          );
          const lockfile = JSON.parse(lockChange.content);
          const entry = lockfile.packages["node_modules/fast-string-width"];
          entry.version = "3.0.4";
          entry.resolved = "https://registry.npmjs.org/fast-string-width/-/fast-string-width-3.0.4.tgz";
          lockChange.content = `${JSON.stringify(lockfile, null, 2)}\n`;
        }
        return changes;
      },
    },
  );

  assert.equal(preview.status, "needs_confirmation");
  const packageChange = preview.preview.changes.find(
    ({ path: changedPath }) => changedPath === ".launchrally/toolchain/package.json",
  );
  assert.deepEqual(JSON.parse(packageChange.after).overrides, overrides);
});

test("Init never repairs a truncated established toolchain integrity pin", async () => {
  const directory = await fixtureWithCliDependency();
  const lockPath = path.join(directory, ".launchrally", "toolchain", "package-lock.json");
  const lockfile = JSON.parse(await readFile(lockPath, "utf8"));
  lockfile.packages["node_modules/@launchrally/cli"].integrity = "sha512-QUFBQQ==";
  await writeFile(lockPath, `${JSON.stringify(lockfile, null, 2)}\n`);
  const audit = await completeAudit(directory);
  let resolutions = 0;

  const result = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    {
      prepare_dependency_changes: async (request) => {
        resolutions += 1;
        return prepareNpmChanges(request);
      },
    },
  );

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "invalid_project_toolchain");
  assert.equal(resolutions, 0);
});

test("Init cannot bypass registry disclosure through public API options", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const attempts = [];
  const prepare = async (request) => {
    attempts.push(request.registry_allowed);
    const error = new Error("offline cache miss");
    error.code = "registry_permission_required";
    error.temporary_target = path.join(os.tmpdir(), "launchrally-dependency-plan-bypass");
    throw error;
  };

  const result = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepare, registry_allowed: true },
  );

  assert.equal(result.status, "needs_permission");
  assert.deepEqual(attempts, [false]);
});

test("Init attempts offline toolchain resolution before disclosing registry permission", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const attempts = [];
  const prepare = async (request) => {
    attempts.push(request.registry_allowed);
    if (!request.registry_allowed) {
      const error = new Error("offline cache miss");
      error.code = "registry_permission_required";
      error.temporary_target = path.join(os.tmpdir(), "launchrally-dependency-plan-offline");
      throw error;
    }
    return prepareNpmChanges(request);
  };

  const permission = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepare },
  );

  assert.equal(permission.status, "needs_permission");
  assert.deepEqual(attempts, [false]);
  assert.deepEqual(permission.request.permissions, [{
    id: "npm_registry_read",
    boundary: "public_network",
    source: "https://registry.npmjs.org",
    package: "@launchrally/cli",
    version: "0.1.0",
    temporary_target: permission.request.permissions[0].temporary_target,
    commands: [{
      executable: "npm",
      arguments: [
        "install",
        "--ignore-scripts",
        "--save-dev",
        "--save-exact",
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmjs.org",
        "@launchrally/cli@0.1.0",
      ],
      shell: false,
    }],
  }]);

  const denied = await runInit(
    directory,
    "0.1.0",
    {
      resume_token: permission.interaction.resume_token,
      permission_decisions: { npm_registry_read: "denied" },
    },
    { prepare_dependency_changes: prepare },
  );
  assert.equal(denied.error, "registry_permission_denied");
  assert.deepEqual(attempts, [false]);
  assert.deepEqual(await readdir(directory), ["package-lock.json", "package.json"]);

  const secondPermission = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepare },
  );
  const preview = await runInit(
    directory,
    "0.1.0",
    {
      resume_token: secondPermission.interaction.resume_token,
      permission_decisions: { npm_registry_read: "approved" },
    },
    { prepare_dependency_changes: prepare },
  );

  assert.equal(preview.status, "needs_confirmation");
  assert.deepEqual(attempts, [false, false, true]);
});

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

test("Init securely creates a previously absent isolated lock root", async () => {
  const directory = await fixture();
  const lockKey = createHash("sha256").update(await realpath(directory)).digest("hex");
  const lockRoot = path.join(os.tmpdir(), `launchrally-init-${lockKey}`);
  await assert.rejects(lstat(lockRoot), { code: "ENOENT" });

  const result = await runInit(directory, "0.1.0");

  assert.equal(result.status, "unavailable");
  assert.equal((await lstat(lockRoot)).isDirectory(), true);
  assert.equal((await lstat(path.join(lockRoot, "owners"))).isDirectory(), true);
  await assert.rejects(lstat(path.join(lockRoot, "init.lock")), { code: "ENOENT" });
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

test("Init rejects a forged Report View instead of persisting an independent narrative", async () => {
  const directory = await fixture();
  const audit = structuredClone(await completeAudit(directory));
  audit.report_view.content = "# Forged readiness\n\nLaunch Ready\n";

  const result = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "invalid_report_view");
  assert.deepEqual(await readdir(directory), ["package-lock.json", "package.json"]);
});

test("Init rejects unreferenced and referenced non-allowlisted Evidence artifacts", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const unreferenced = structuredClone(audit);
  const template = structuredClone(unreferenced.evidence_index.entries[0]);
  template.normalized_artifact = {
    kind: "release_intent",
    field: "raw_secret",
    value: "must-not-persist",
  };
  template.evidence_kind = "release_intent";
  template.digest = `sha256:${createHash("sha256")
    .update(JSON.stringify(template.normalized_artifact))
    .digest("hex")}`;
  template.target = "release_intent:raw_secret";
  unreferenced.evidence_index.entries.push(template);
  unreferenced.report.execution.evidence_index.entry_count += 1;
  unreferenced.report_view.content = renderReportMarkdown(unreferenced.report);

  const unreferencedResult = await runInit(
    directory,
    "0.1.0",
    { report_package: unreferenced },
    { prepare_dependency_changes: prepareNpmChanges },
  );
  assert.equal(unreferencedResult.error, "invalid_evidence_index");

  const referenced = structuredClone(audit);
  const entry = referenced.evidence_index.entries[0];
  const previousDigest = entry.digest;
  entry.normalized_artifact.raw_secret = "must-not-persist";
  entry.digest = `sha256:${createHash("sha256")
    .update(JSON.stringify(Object.fromEntries(
      Object.entries(entry.normalized_artifact).sort(([left], [right]) => left.localeCompare(right)),
    )))
    .digest("hex")}`;
  for (const check of referenced.report.results.checks) {
    for (const reference of [...check.applicability.evidence, ...check.evidence]) {
      if (reference.digest === previousDigest) reference.digest = entry.digest;
    }
  }
  for (const reference of [
    ...referenced.report.results.public_evidence_refs,
    ...referenced.report.results.provider_evidence_refs,
  ]) {
    if (reference.digest === previousDigest) reference.digest = entry.digest;
  }
  referenced.report_view.content = renderReportMarkdown(referenced.report);

  const referencedResult = await runInit(
    directory,
    "0.1.0",
    { report_package: referenced },
    { prepare_dependency_changes: prepareNpmChanges },
  );
  assert.equal(referencedResult.error, "unsafe_evidence_artifact");
});

test("Init rejects unsafe types inside otherwise allowlisted Evidence fields", async () => {
  const directory = await fixture();
  const audit = structuredClone(await completeAudit(directory));
  const entry = audit.evidence_index.entries.find(
    ({ evidence_kind: kind }) => kind === "release_intent",
  );
  const previousDigest = entry.digest;
  entry.normalized_artifact.value = { raw_secret: "must-not-persist" };
  entry.digest = `sha256:${createHash("sha256")
    .update(JSON.stringify(Object.fromEntries(
      Object.entries(entry.normalized_artifact).sort(([left], [right]) => left.localeCompare(right)),
    )))
    .digest("hex")}`;
  for (const check of audit.report.results.checks) {
    for (const reference of [...check.applicability.evidence, ...check.evidence]) {
      if (reference.digest === previousDigest) reference.digest = entry.digest;
    }
  }
  audit.report_view.content = renderReportMarkdown(audit.report);

  const result = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );

  assert.equal(result.error, "unsafe_evidence_artifact");
});

test("Init binds to explicit cwd instead of a Report-supplied root while real drift fails currentness", async () => {
  const sourceDirectory = await fixture();
  const targetDirectory = await fixture();
  const audit = await completeAudit(sourceDirectory);

  const result = await runInit(
    targetDirectory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );

  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.source_report_id, audit.report.report_id);
  await writeFile(path.join(targetDirectory, "package.json"), "{\"name\":\"drifted\"}\n");
  const drifted = await runInit(
    targetDirectory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );
  assert.equal(drifted.status, "needs_refresh");
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
  const previewChanges = result.preview.changes.map(({ path: changedPath, operation }) => ({
    path: changedPath,
    operation,
  }));
  for (const expected of [
    { path: ".launchrally/.gitignore", operation: "create" },
    { path: ".launchrally/manifest.yaml", operation: "create" },
    { path: ".launchrally/toolchain/authority.json", operation: "create" },
    { path: ".launchrally/toolchain/package-lock.json", operation: "create" },
    { path: ".launchrally/toolchain/package.json", operation: "create" },
  ]) assert.ok(previewChanges.some((change) =>
    change.path === expected.path && change.operation === expected.operation));
  assert.ok(previewChanges.some(({ path: changedPath }) => changedPath.includes("/reports/")));
  assert.ok(previewChanges.some(({ path: changedPath }) => changedPath.includes("/evidence/sha256/")));
  assert.ok(!previewChanges.some(({ path: changedPath }) => changedPath.includes("/cache/")));
  assert.ok(result.preview.changes.every((change) => change.after_digest.startsWith("sha256:")));
  assert.equal(
    result.preview.changes.find((change) => change.path === ".launchrally/.gitignore").after,
    "/reports/\n/evidence/\n/cache/\n/transactions/\n/locks/\n/toolchain/node_modules/\n/.init-transaction/\n/.toolchain-transaction/\n",
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
  substituted.changes.find(
    (change) => change.path === ".launchrally/toolchain/package.json",
  ).after =
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

test("Init accepts a portable token when mkdtemp preserves its placeholder", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const preview = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );
  const portableToken = await simulateExtendedMkdtempSuffix(
    preview.interaction.resume_token,
    "init",
  );

  const result = await runInit(directory, "0.1.0", {
    resume_token: portableToken,
    confirmation: "decline",
  });

  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.outcome, "initialization_declined");
});

test("the opaque Init token detects preview-record corruption before applying changes", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const preview = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );
  const match = preview.interaction.resume_token.match(
    /^lrinit_([A-Za-z0-9]{6}|[A-Za-z0-9]{12})_([A-Za-z0-9_-]{43})_/u,
  );
  const statePath = path.join(
    os.tmpdir(),
    `launchrally-init-preview-${match[1]}`,
    `${match[2]}.json`,
  );
  const corrupted = JSON.parse(await readFile(statePath, "utf8"));
  corrupted.report_package.report_view.content = "forged view\n";
  await writeFile(statePath, `${JSON.stringify(corrupted)}\n`);

  const result = await runInit(directory, "0.1.0", {
    resume_token: preview.interaction.resume_token,
    confirmation: "confirm",
  });

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "invalid_resume_token");
  assert.deepEqual(await readdir(directory), ["package-lock.json", "package.json"]);
});

test("Init rejects structurally substituted apply and Report state even through a custom loader", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  let storedState;
  const token = `custom_${"x".repeat(32)}`;
  await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    {
      prepare_dependency_changes: prepareNpmChanges,
      store_state: async (state) => {
        storedState = structuredClone(state);
        return token;
      },
    },
  );
  storedState.changes.find(
    ({ path: changedPath }) => changedPath === ".launchrally/toolchain/package.json",
  ).after =
    "{\"substituted\":true}\n";

  const result = await runInit(
    directory,
    "0.1.0",
    { resume_token: token, confirmation: "confirm" },
    { load_state: async () => ({ state: storedState, statePath: null }) },
  );

  assert.equal(result.error, "invalid_resume_token");
  assert.deepEqual(await readdir(directory), ["package-lock.json", "package.json"]);
});

test("Init rejects substituted state mode and unexpected top-level state fields", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  let storedState;
  const token = `custom_${"m".repeat(32)}`;
  await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    {
      prepare_dependency_changes: prepareNpmChanges,
      store_state: async (state) => {
        storedState = structuredClone(state);
        return token;
      },
    },
  );
  storedState.mode = "forged_completion_mode";
  storedState.unexpected = true;

  const result = await runInit(
    directory,
    "0.1.0",
    { resume_token: token, confirmation: "confirm" },
    { load_state: async () => ({ state: storedState, statePath: null }) },
  );

  assert.equal(result.error, "invalid_resume_token");
  assert.deepEqual(await readdir(directory), ["package-lock.json", "package.json"]);
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
    JSON.parse(await readFile(path.join(
      directory,
      ".launchrally",
      "toolchain",
      "package.json",
    ), "utf8")).devDependencies,
    { "@launchrally/cli": "0.1.0" },
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(
      directory,
      ".launchrally",
      "toolchain",
      "authority.json",
    ), "utf8")),
    {
      contract: "launchrally.dev/execution-authority/v1",
      engine: {
        package: "@launchrally/cli",
        version: "0.1.0",
        entrypoint: "bin/engine.js",
      },
    },
  );
  assert.deepEqual(
    (await readdir(path.join(directory, ".launchrally"))).sort(),
    [".gitignore", "evidence", "locks", "manifest.yaml", "reports", "toolchain", "transactions"],
  );
});

test("confirmed Init adopts a validated immediately executable project Engine", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const preview = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareMaterializedToolchain },
  );

  assert.deepEqual(preview.preview.materialization, {
    command: {
      executable: "npm",
      arguments: [
        "install",
        "--ignore-scripts",
        "--save-dev",
        "--save-exact",
        "--no-audit",
        "--no-fund",
        "--offline",
        "@launchrally/cli@0.1.0",
      ],
      shell: false,
    },
    package_count: 9,
    integrity_digest: `sha256:${"a".repeat(64)}`,
    target: ".launchrally/toolchain/node_modules",
    ignored: true,
    authoritative: false,
  });

  const result = await runInit(directory, "0.1.0", {
    resume_token: preview.interaction.resume_token,
    confirmation: "confirm",
  });
  const authority = await resolveExecutionAuthority({
    cwd: directory,
    launcher_version: "0.1.0",
  });

  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(authority.state, "ready");
  assert.equal(authority.engine.version, "0.1.0");
});

test("re-running Init preserves the established project Engine pin", async () => {
  const directory = await fixture();
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

  const rerun = await runInit(
    directory,
    "9.9.9",
    { report_package: audit },
    {
      prepare_dependency_changes: async () => {
        assert.fail("Init must not resolve a different Engine after project authority exists.");
      },
    },
  );

  assert.equal(rerun.status, "needs_refresh");
  assert.deepEqual(
    JSON.parse(await readFile(path.join(
      directory,
      ".launchrally",
      "toolchain",
      "package.json",
    ), "utf8")).devDependencies,
    { "@launchrally/cli": "0.1.0" },
  );
});

test("confirmed Init persists the complete source Audit as immutable local history", async () => {
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

  assert.equal(result.status, "completed");
  const reportDirectory = path.join(
    directory,
    ".launchrally",
    "reports",
    audit.report.report_id,
  );
  const recordContent = await readFile(path.join(reportDirectory, "record.json"), "utf8");
  assert.deepEqual(JSON.parse(recordContent), audit.report);
  assert.equal(
    await readFile(path.join(reportDirectory, "record.sha256"), "utf8"),
    `sha256:${createHash("sha256").update(recordContent).digest("hex")}\n`,
  );
  assert.equal(await readFile(path.join(reportDirectory, "view.md"), "utf8"), audit.report_view.content);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(reportDirectory, "evidence-index.json"), "utf8")),
    audit.evidence_index,
  );
  const evidenceFiles = await readdir(path.join(directory, ".launchrally", "evidence", "sha256"));
  assert.equal(evidenceFiles.length, audit.evidence_index.entries.length);
  for (const entry of audit.evidence_index.entries) {
    const artifactContent = await readFile(
      path.join(directory, ".launchrally", "evidence", "sha256", `${entry.digest.slice(7)}.json`),
      "utf8",
    );
    assert.equal(
      `sha256:${createHash("sha256").update(artifactContent).digest("hex")}`,
      entry.digest,
    );
    assert.deepEqual(JSON.parse(artifactContent), entry.normalized_artifact);
  }
});

test("failed Init history staging exposes no partial Report and reverts adoption", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const packageBefore = await readFile(path.join(directory, "package.json"), "utf8");
  const preview = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );

  const result = await runInit(
    directory,
    "0.1.0",
    { resume_token: preview.interaction.resume_token, confirmation: "confirm" },
    {
      history_file_operations: {
        write_file: async (target, content, options) => {
          if (target.endsWith(`${path.sep}view.md`)) {
            const error = new Error("history path is not writable");
            error.code = "EACCES";
            throw error;
          }
          await writeFile(target, content, options);
        },
      },
    },
  );

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "EACCES");
  assert.equal(result.recoverable, true);
  assert.equal(await readFile(path.join(directory, "package.json"), "utf8"), packageBefore);
  await assert.rejects(
    readFile(path.join(
      directory,
      ".launchrally",
      "reports",
      audit.report.report_id,
      "record.json",
    )),
    { code: "ENOENT" },
  );
  await assert.rejects(
    readFile(path.join(directory, ".launchrally", "manifest.yaml")),
    { code: "ENOENT" },
  );
  assert.deepEqual(
    await readdir(path.join(directory, ".launchrally", "evidence", "sha256")),
    [],
  );
});

test("Init crash recovery preserves already committed immutable history", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const preview = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );
  const interrupted = await runInit(
    directory,
    "0.1.0",
    {
      resume_token: preview.interaction.resume_token,
      confirmation: "confirm",
    },
    {
      mark_history_committed: async () => {
        const error = new Error("simulated crash after Report commit");
        error.code = "EIO";
        throw error;
      },
    },
  );
  assert.equal(interrupted.error, "initialization_recovery_required");

  const recovered = await runInit(directory, "0.1.0");

  assert.equal(recovered.status, "completed");
  assert.equal(recovered.outcome, "initialized");
  assert.equal(recovered.recovery, "committed_history_finalized");
  assert.deepEqual(
    JSON.parse(await readFile(path.join(
      directory,
      ".launchrally",
      "toolchain",
      "package.json",
    ), "utf8")).devDependencies,
    { "@launchrally/cli": "0.1.0" },
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(
      directory,
      ".launchrally",
      "reports",
      audit.report.report_id,
      "record.json",
    ), "utf8")),
    audit.report,
  );
});

test("Init committed-phase recovery refuses missing physical history without rolling back adoption", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const preview = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );
  const recoveryPath = path.join(
    directory,
    ".launchrally",
    ".init-transaction",
    "recovery.json",
  );
  const interrupted = await runInit(
    directory,
    "0.1.0",
    { resume_token: preview.interaction.resume_token, confirmation: "confirm" },
    {
      mark_history_committed: async () => {
        const journal = JSON.parse(await readFile(recoveryPath, "utf8"));
        await writeFile(recoveryPath, `${JSON.stringify({
          ...journal,
          phase: "history_committed",
        })}\n`);
        await rm(path.join(
          directory,
          ".launchrally",
          "reports",
          audit.report.report_id,
          "view.md",
        ));
        const error = new Error("simulated crash after committed-phase journal write");
        error.code = "EIO";
        throw error;
      },
    },
  );
  assert.equal(interrupted.error, "initialization_recovery_required");

  const recovered = await runInit(directory, "0.1.0");

  assert.equal(recovered.error, "invalid_recovery_journal");
  assert.deepEqual(
    JSON.parse(await readFile(path.join(
      directory,
      ".launchrally",
      "toolchain",
      "package.json",
    ), "utf8")).devDependencies,
    { "@launchrally/cli": "0.1.0" },
  );
  assert.equal(JSON.parse(await readFile(recoveryPath, "utf8")).phase, "history_committed");
});

test("a concurrent Init cannot recover or roll back another live adoption", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const preview = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );
  let persistenceStarted;
  let allowPersistence;
  const started = new Promise((resolve) => { persistenceStarted = resolve; });
  const allowed = new Promise((resolve) => { allowPersistence = resolve; });
  const first = runInit(
    directory,
    "0.1.0",
    { resume_token: preview.interaction.resume_token, confirmation: "confirm" },
    {
      persist_history: async (...args) => {
        persistenceStarted();
        await allowed;
        return persistLocalHistory(...args);
      },
    },
  );
  await started;

  const concurrent = await runInit(directory, "0.1.0");

  assert.equal(concurrent.error, "initialization_busy");
  assert.deepEqual(
    JSON.parse(await readFile(path.join(
      directory,
      ".launchrally",
      "toolchain",
      "package.json",
    ), "utf8")).devDependencies,
    { "@launchrally/cli": "0.1.0" },
  );
  allowPersistence();
  assert.equal((await first).status, "completed");
  assert.equal((await readFile(path.join(directory, ".launchrally", "manifest.yaml"), "utf8")).length > 0, true);
});

test("Init refuses a concurrent immutable Evidence collision after preview", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const preview = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );
  const entry = audit.evidence_index.entries[0];
  const evidenceDirectory = path.join(directory, ".launchrally", "evidence", "sha256");
  await mkdir(evidenceDirectory, { recursive: true });
  const evidencePath = path.join(evidenceDirectory, `${entry.digest.slice(7)}.json`);
  const tampered = "{\"tampered\":true}\n";
  await writeFile(evidencePath, tampered);

  const result = await runInit(directory, "0.1.0", {
    resume_token: preview.interaction.resume_token,
    confirmation: "confirm",
  });

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "preview_stale");
  assert.equal(await readFile(evidencePath, "utf8"), tampered);
  await assert.rejects(
    readFile(path.join(directory, ".launchrally", "manifest.yaml"), "utf8"),
    { code: "ENOENT" },
  );
});

test("Init fails before preview on partial Report history or missing committed Evidence", async () => {
  for (const historyState of ["partial_bundle", "missing_evidence"]) {
    const directory = await fixture();
    const audit = await completeAudit(directory);
    const history = createHistoryFiles(audit, { include_cache: false });
    const reportFiles = history.files.filter(({ path: historyPath }) =>
      historyPath.includes("/reports/"));
    const selected = historyState === "partial_bundle" ? reportFiles.slice(0, 1) : reportFiles;
    for (const file of selected) {
      const target = path.join(directory, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }

    const result = await runInit(
      directory,
      "0.1.0",
      { report_package: audit },
      { prepare_dependency_changes: prepareNpmChanges },
    );

    assert.equal(result.error, "history_collision", historyState);
    assert.equal(result.changes_applied, undefined, historyState);
    await assert.rejects(
      readFile(path.join(directory, ".launchrally", "manifest.yaml")),
      { code: "ENOENT" },
    );
  }
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
  await mkdir(path.join(directory, ".launchrally", "toolchain"), { recursive: true });
  await writeFile(
    path.join(directory, ".launchrally", "toolchain", "package.json"),
    "{\"changed\":true}\n",
  );

  const result = await runInit(directory, "0.1.0", {
    resume_token: preview.interaction.resume_token,
    confirmation: "confirm",
  });

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "preview_stale");
  assert.deepEqual(await readdir(directory), [".launchrally", "package-lock.json", "package.json"]);
});

test("Init confirmation refuses to recreate preexisting immutable history deleted after preview", async () => {
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
  const oldIgnore = "/reports/\n/evidence/\n/cache/\n/transactions/\n/.init-transaction/\n";
  const ignorePath = path.join(directory, ".launchrally", ".gitignore");
  await writeFile(ignorePath, oldIgnore);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: audit,
    scope: "full",
  });
  const verified = await runVerify(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });
  assert.equal(verified.status, "completed");
  const preview = await runInit(
    directory,
    "0.1.0",
    { report_package: verified },
    { prepare_dependency_changes: prepareNpmChanges },
  );
  assert.equal(preview.status, "needs_confirmation");
  assert.deepEqual(preview.preview.changes.map(({ path: changedPath }) => changedPath), [
    ".launchrally/.gitignore",
  ]);
  const reportDirectory = path.join(
    directory,
    ".launchrally",
    "reports",
    verified.report.report_id,
  );
  await rm(reportDirectory, { recursive: true });

  const result = await runInit(directory, "0.1.0", {
    resume_token: preview.interaction.resume_token,
    confirmation: "confirm",
  });

  assert.equal(result.error, "preview_stale");
  assert.equal(await readFile(ignorePath, "utf8"), oldIgnore);
  await assert.rejects(readFile(path.join(reportDirectory, "record.json")), { code: "ENOENT" });
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
          if (!failed && target === path.join(
            directory,
            ".launchrally",
            "toolchain",
            "package.json",
          )) {
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
    message: "The isolated exact CLI toolchain preview could not be prepared; nothing was changed.",
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
          if (target === path.join(
            directory,
            ".launchrally",
            "toolchain",
            "package.json",
          )) {
            throw new Error("simulated persistent write failure");
          }
          await writeFile(target, content, "utf8");
        },
        remove_file: async () => {
          throw new Error("simulated interrupted rollback");
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
          if (target === path.join(
            directory,
            ".launchrally",
            "toolchain",
            "package.json",
          )) throw new Error("stop apply");
          await writeFile(target, content, "utf8");
        },
        remove_file: async () => {
          throw new Error("stop rollback");
        },
      },
    },
  );
  const userEdit = "{\"user_edit_after_crash\":true}\n";
  const toolchainLock = path.join(
    directory,
    ".launchrally",
    "toolchain",
    "package-lock.json",
  );
  await writeFile(toolchainLock, userEdit);

  const result = await runInit(directory, "0.1.0");

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "initialization_recovery_conflict");
  assert.equal(await readFile(toolchainLock, "utf8"), userEdit);
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

test("Init preflights every planned history path before preview reads", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const history = createHistoryFiles(audit, { include_cache: false });
  const evidence = history.files.find(({ path: historyPath }) =>
    historyPath.includes("/evidence/"));
  const target = path.join(directory, evidence.path);
  const outside = path.join(await mkdtemp(
    path.join(os.tmpdir(), "launchrally-init-evidence-outside-"),
  ), "evidence.json");
  await writeFile(outside, "outside-must-remain-unchanged\n");
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(outside, target);

  const result = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );

  assert.equal(result.error, "unsafe_project_path");
  assert.equal(await readFile(outside, "utf8"), "outside-must-remain-unchanged\n");
  await assert.rejects(
    readFile(path.join(directory, ".launchrally", "manifest.yaml")),
    { code: "ENOENT" },
  );
});

test("Init confirmation preflights unchanged history before digest reads", async () => {
  const directory = await fixture();
  const packageBefore = await readFile(path.join(directory, "package.json"), "utf8");
  await mkdir(path.join(directory, ".launchrally"));
  await writeFile(
    path.join(directory, ".launchrally", ".gitignore"),
    "/evidence/\n/reports/\n",
  );
  const audit = await completeAudit(directory);
  const history = createHistoryFiles(audit, { include_cache: false });
  const evidence = history.files.find(({ path: historyPath }) =>
    historyPath.includes("/evidence/"));
  const target = path.join(directory, evidence.path);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, evidence.content);
  const preview = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );
  assert.equal(preview.status, "needs_confirmation");
  const outside = path.join(await mkdtemp(
    path.join(os.tmpdir(), "launchrally-init-confirm-evidence-outside-"),
  ), "evidence.json");
  await writeFile(outside, evidence.content);
  await rm(target);
  await symlink(outside, target);

  const result = await runInit(directory, "0.1.0", {
    resume_token: preview.interaction.resume_token,
    confirmation: "confirm",
  });

  assert.equal(result.error, "unsafe_project_path");
  assert.equal(await readFile(outside, "utf8"), evidence.content);
  assert.equal(await readFile(path.join(directory, "package.json"), "utf8"), packageBefore);
  await assert.rejects(
    readFile(path.join(directory, ".launchrally", "manifest.yaml")),
    { code: "ENOENT" },
  );
});

test("Init refuses a predictable temp lock root symlink without writing through it", async () => {
  const directory = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "launchrally-init-lock-outside-"));
  const lockKey = createHash("sha256").update(await realpath(directory)).digest("hex");
  const lockRoot = path.join(os.tmpdir(), `launchrally-init-${lockKey}`);
  await symlink(outside, lockRoot);
  try {
    const result = await runInit(directory, "0.1.0");

    assert.equal(result.error, "invalid_initialization_lock");
    assert.deepEqual(await readdir(outside), []);
    assert.deepEqual(await readdir(directory), ["package-lock.json", "package.json"]);
  } finally {
    await rm(lockRoot, { force: true });
  }
});

test("application package-manager files never control or receive the npm toolchain", async () => {
  for (const applicationLock of ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]) {
    const directory = await fixture();
    await rm(path.join(directory, "package-lock.json"));
    const applicationContent = applicationLock === "bun.lockb"
      ? Buffer.from([0, 1, 2, 3, 255])
      : Buffer.from("application lock remains unchanged\n");
    await writeFile(path.join(directory, applicationLock), applicationContent);
    const audit = await completeAudit(directory);

    const result = await runInit(
      directory,
      "0.1.0",
      { report_package: audit },
      { prepare_dependency_changes: prepareNpmChanges },
    );

    assert.equal(result.status, "needs_confirmation", applicationLock);
    assert.ok(result.preview.changes.some(
      (change) => change.path === ".launchrally/toolchain/package.json"), applicationLock);
    assert.ok(result.preview.changes.some(
      (change) => change.path === ".launchrally/toolchain/package-lock.json"), applicationLock);
    assert.equal(result.preview.changes.some(
      (change) => change.path === applicationLock), false, applicationLock);
    assert.deepEqual(await readFile(path.join(directory, applicationLock)), applicationContent);
  }
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
      reason: "The first Report did not confirm targets for the intended environment.",
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
  const currentAudit = await completeAudit(directory);
  const manifestPath = path.join(directory, ".launchrally", "manifest.yaml");
  const legacyPath = path.join(directory, ".launchrally", "launch-manifest.json");
  const legacy = structuredClone(initialPreview.manifest);
  legacy.schema_version = "launchrally.dev/manifest/v1";
  legacy.execution.source_report_id.value = currentAudit.report.report_id;
  legacy.execution.assessment.value = currentAudit.report.assessment;
  legacy.support.layers = {
    state: "not_applicable",
    reason: "No support layers were declared for this release.",
  };
  delete legacy.providers.roles.evidence;
  const legacyContent = `${JSON.stringify(legacy, null, 2)}\n`;
  await rm(manifestPath);
  await writeFile(legacyPath, legacyContent);

  const migration = await runInit(
    directory,
    "0.1.0",
    { report_package: currentAudit },
    { prepare_dependency_changes: prepareNpmChanges },
  );

  assert.equal(migration.status, "needs_confirmation");
  assert.equal(migration.mode, "migration");
  const migrationPaths = migration.preview.changes.map((change) => change.path);
  assert.ok(migrationPaths.includes(".launchrally/launch-manifest.json"));
  assert.ok(migrationPaths.includes(".launchrally/manifest.yaml"));
  assert.ok(migrationPaths.some((changedPath) => changedPath.includes("/reports/")));
  const legacyChange = migration.preview.changes.find(
    (change) => change.path === ".launchrally/launch-manifest.json",
  );
  assert.equal(legacyChange.before, legacyContent);
  assert.equal(legacyChange.after, null);
  assert.match(
    legacyChange.diff,
    /^--- a\/\.launchrally\/launch-manifest\.json\n\+\+\+ \/dev\/null\n@@/u,
  );
  assert.equal(await readFile(legacyPath, "utf8"), legacyContent);

  const applied = await runInit(directory, "0.1.0", {
    resume_token: migration.interaction.resume_token,
    confirmation: "confirm",
  });
  assert.equal(applied.outcome, "migrated", JSON.stringify(applied));
  await assert.rejects(readFile(legacyPath, "utf8"), { code: "ENOENT" });
  assert.equal(
    await readFile(manifestPath, "utf8"),
    migration.preview.changes.find((change) => change.path === ".launchrally/manifest.yaml").after,
  );
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

test("stale offline npm metadata still requires an explicit registry permission", () => {
  const error = new Error("Command failed: npm install --offline @launchrally/cli@0.1.0");
  error.stderr = [
    "npm error code ETARGET",
    "npm error notarget No matching version found for @launchrally/cli@0.1.0.",
  ].join("\n");

  assert.equal(isOfflineResolutionMiss(error), true);
});

test("the CLI exposes and honors the isolated toolchain registry permission", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const reportDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrally-registry-report-"));
  const npmCache = await mkdtemp(path.join(os.tmpdir(), "launchrally-empty-npm-cache-"));
  const isolatedEnvironment = { ...process.env, NPM_CONFIG_CACHE: npmCache };
  const reportPath = path.join(reportDirectory, "audit.json");
  await writeFile(reportPath, JSON.stringify(audit));

  const permission = JSON.parse((await execFileAsync(process.execPath, [
    cli,
    "init",
    "--json",
    "--cwd",
    directory,
    "--report",
    reportPath,
  ], { env: isolatedEnvironment })).stdout);

  assert.equal(permission.status, "needs_permission");
  assert.equal(permission.request.permissions[0].id, "npm_registry_read");
  assert.ok(permission.request.permissions[0].commands[0].arguments.includes("--ignore-scripts"));
  assert.ok(permission.request.permissions[0].commands[0].arguments.some(
    (argument) => argument.includes("registry.npmjs.org"),
  ));
  assert.equal(permission.request.permissions[0].commands[0].shell, false);
  await assert.rejects(
    execFileAsync(process.execPath, [
      cli,
      "init",
      "--json",
      "--cwd",
      directory,
      "--resume",
      permission.interaction.resume_token,
      "--permissions",
      JSON.stringify({ npm_registry_read: "denied" }),
    ], { env: isolatedEnvironment }),
    (error) => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.error, "registry_permission_denied");
      return true;
    },
  );
  assert.deepEqual(await readdir(directory), ["package-lock.json", "package.json"]);
});

test("the CLI previews a saved complete Audit and decline applies nothing", async () => {
  const directory = await fixtureWithCliDependency("0.3.1");
  const audit = await completeAudit(directory);
  const reportDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrally-report-file-"));
  const reportPath = path.join(reportDirectory, "audit.json");
  await writeFile(reportPath, JSON.stringify(audit));

  const previewProcess = await execFileAsync(process.execPath, [
    engine,
    "init",
    "--json",
    "--cwd",
    directory,
    "--report",
    reportPath,
  ]);
  const preview = JSON.parse(previewProcess.stdout);

  assert.equal(preview.status, "needs_confirmation");
  const previewPaths = preview.preview.changes.map((change) => change.path);
  assert.ok(previewPaths.includes(".launchrally/.gitignore"));
  assert.ok(previewPaths.includes(".launchrally/manifest.yaml"));
  assert.ok(previewPaths.some((changedPath) => changedPath.includes("/reports/")));
  assert.ok(previewPaths.some((changedPath) => changedPath.includes("/evidence/sha256/")));
  assert.deepEqual(await readdir(directory), [".launchrally", "package-lock.json", "package.json"]);

  const declineProcess = await execFileAsync(process.execPath, [
    engine,
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
  assert.deepEqual(await readdir(directory), [".launchrally", "package-lock.json", "package.json"]);
});

test("Human Mode renders every exact initialization change before confirmation", async () => {
  const directory = await fixtureWithCliDependency("0.3.1");
  const audit = await completeAudit(directory);
  const reportDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrally-human-report-"));
  const reportPath = path.join(reportDirectory, "audit.json");
  await writeFile(reportPath, JSON.stringify(audit));

  const processResult = await execFileAsync(process.execPath, [
    engine,
    "init",
    "--cwd",
    directory,
    "--report",
    reportPath,
  ]);

  assert.match(processResult.stdout, /^LaunchRally Initialization Preview/mu);
  assert.match(processResult.stdout, /CREATE \.launchrally\/\.gitignore/u);
  assert.match(
    processResult.stdout,
    /\/reports\/\n\/evidence\/\n\/cache\/\n\/transactions\/\n\/locks\/\n\/toolchain\/node_modules\/\n\/\.init-transaction\/\n\/\.toolchain-transaction\//u,
  );
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
