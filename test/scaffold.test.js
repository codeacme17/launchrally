import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { renderHumanAuditCompletion } from "../packages/cli/bin/human-audit.js";
import { evaluateReportCurrentness } from "../packages/core/src/index.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "packages", "cli", "bin", "rally.js");
const SECRET_SENTINEL = "lr_secret_DO_NOT_EXPOSE_7f3d9a";

async function snapshotFiles(directory, relative = "") {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const snapshot = {};

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      Object.assign(snapshot, await snapshotFiles(directory, entryRelative));
    } else {
      snapshot[entryRelative] = await readFile(path.join(directory, entryRelative), "base64");
    }
  }

  return snapshot;
}

async function createNetworkGuard() {
  const guardDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrally-network-guard-"));
  const guard = path.join(guardDirectory, "deny-network.cjs");
  await writeFile(
    guard,
    [
      'const deny = () => { throw new Error("network access attempted"); };',
      'const net = require("node:net");',
      'const http = require("node:http");',
      'const https = require("node:https");',
      "net.connect = deny;",
      "net.createConnection = deny;",
      "http.request = deny;",
      "http.get = deny;",
      "https.request = deny;",
      "https.get = deny;",
      "global.fetch = deny;",
    ].join("\n"),
  );
  return guard;
}

async function createWebFixture(name, { withLockfile = false } = {}) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), `launchrally-${name}-`));
  await writeFile(
    path.join(fixture, "package.json"),
    JSON.stringify({ name, scripts: { build: "vite build" } }),
  );
  if (withLockfile) {
    await writeFile(path.join(fixture, "package-lock.json"), '{"lockfileVersion":3}');
  }
  return fixture;
}

async function runCliAudit(fixture, { json = false, env, publicDecision = "denied" } = {}) {
  const invoke = async (options, structured = true) => {
    const args = [cli, "audit"];
    if (structured) args.push("--json");
    args.push("--cwd", fixture, ...options);
    return execFileAsync(process.execPath, args, {
      cwd: root,
      ...(env ? { env } : {}),
    });
  };

  const initial = JSON.parse((await invoke([])).stdout);
  const confirmation = JSON.parse((await invoke([
    "--resume",
    initial.interaction.resume_token,
    "--answers",
    JSON.stringify({
      intended_environment: "production",
      production_targets: ["https://example.com"],
      core_journeys: ["homepage loads"],
      provider_roles: [],
      support_layers: [],
    }),
  ])).stdout);
  const permission = JSON.parse((await invoke([
    "--resume",
    confirmation.interaction.resume_token,
    "--confirm",
    "confirm",
  ])).stdout);
  const completed = await invoke(
    [
      "--resume",
      permission.interaction.resume_token,
      "--permissions",
      JSON.stringify({ public_verification: publicDecision }),
    ],
    true,
  );
  if (json) return completed.stdout;
  return renderHumanAuditCompletion(JSON.parse(completed.stdout), { cwd: fixture });
}

test("audit returns a local Initial Readiness Snapshot and Web baseline result", async () => {
  const fixture = await createWebFixture("fixture-web", { withLockfile: true });
  const before = await snapshotFiles(fixture);
  const networkGuard = await createNetworkGuard();

  const stdout = await runCliAudit(fixture, {
    json: true,
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${networkGuard}`.trim(),
    },
  });
  const result = JSON.parse(stdout);

  assert.equal(result.contract, "launchrally.dev/cli/v2");
  assert.equal(result.status, "completed");
  assert.equal(result.operation, "audit");
  assert.equal(result.snapshot.kind, "initial_readiness_snapshot");
  assert.equal(result.report.assessment, "inconclusive");
  assert.deepEqual(result.snapshot.project, {
    root: fixture,
    name: "fixture-web",
    type: "web",
    package_manifest: { path: "package.json", status: "valid" },
    package_manager: "npm",
    script_names: ["build"],
    detected_files: ["package.json", "package-lock.json"],
    facts: [
      {
        kind: "lockfile",
        package_manager: "npm",
        provenance: { path: "package-lock.json", collector: "local_safe_scan/v1" },
      },
      {
        kind: "package_manifest",
        status: "valid",
        name: "fixture-web",
        script_names: ["build"],
        provenance: { path: "package.json", collector: "local_safe_scan/v1" },
      },
    ],
    safe_scan: {
      policy_version: "local_safe_scan/v1",
      exclusions: {
        ignored: 0,
        dependencies: 0,
        build_outputs: 0,
        tooling_metadata: 0,
        binary: 0,
        large: 0,
        unsupported: 0,
        symlinks: 0,
        nested_repositories: 0,
        outside_root: 0,
        unreadable: 0,
      },
      errors: [],
      coverage: {
        root_lockfiles: { complete: true, uncovered: [] },
      },
    },
  });
  assert.deepEqual(result.snapshot.obvious_blockers, []);
  assert.deepEqual(result.snapshot.next, {
    type: "none",
    required: false,
    message: "No input or approval is required for this local-only Audit.",
  });
  assert.equal(result.report.results.checks.length, 9);
  assert.equal(
    result.report.results.checks.find(
      (check) => check.check_id === "web.baseline.lockfile",
    ).status,
    "passed",
  );
  assert.equal(result.report.catalog.risk_domains.length, 8);
  assert.equal(result.report.results.domain_coverage.length, 8);
  assert.equal(result.report.provenance.check_catalog_version, "web-baseline-check-catalog/v2");
  assert.equal(result.report.provenance.baseline_version, "web-application-baseline/v1");
  assert.deepEqual(result.report.provenance.active_profile_versions, []);
  assert.deepEqual(result.report.provenance.active_adapter_versions, []);
  assert.ok(result.report.results.verification_gaps.length > 0);
  assert.equal(result.report.results.verification_gaps[0].priority, "p0");
  assert.equal(result.report.results.verification_gaps[0].status, "unverified");
  assert.equal(result.report.results.coverage_summary[0].coverage, "partial");
  assert.ok(result.snapshot.limitations.length > 0);

  assert.deepEqual(await snapshotFiles(fixture), before);
  await assert.rejects(access(path.join(fixture, ".launchrally")));
});

test("audit renders a concise assessment, Findings, Gaps, and next command for a person", async () => {
  const fixture = await createWebFixture("terminal-web", { withLockfile: true });
  const stdout = await runCliAudit(fixture);

  assert.match(
    stdout,
    /LaunchRally Audit[\s\S]*Assessment\nInconclusive[\s\S]*Failed Findings \(0\)[\s\S]*Verification Gaps \(\d+\)[\s\S]*web\.public\.availability[\s\S]*Next command\nrally init .*--report <saved-report-path>/,
  );
  assert.doesNotMatch(stdout, /Initial Readiness Snapshot|# LaunchRally Audit Report/u);
});

test("audit reports a failed Web baseline Check when the lockfile is missing", async () => {
  const fixture = await createWebFixture("unlocked-web");
  await mkdir(path.join(fixture, ".agents"));
  await writeFile(
    path.join(fixture, ".agents", "package-lock.json"),
    '{"lockfileVersion":3}',
  );
  const stdout = await runCliAudit(fixture, { json: true });
  const result = JSON.parse(stdout);

  const lockfileCheck = result.report.results.checks.find(
    (check) => check.check_id === "web.baseline.lockfile",
  );
  assert.equal(lockfileCheck.status, "failed");
  assert.equal(
    lockfileCheck.summary,
    "No dependency lockfile was found, so installs are not reproducible.",
  );
  const [action] = result.report.results.action_queue;
  assert.match(action.evidence[0].digest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(result.report.results.action_queue, [
    {
      check_id: "web.baseline.lockfile",
      priority: "p0",
      severity: "critical",
      gating: true,
      dependency_unblocking: true,
      core_journey_impact: "indirect",
      action: "Commit the package manager lockfile generated by the project dependency install.",
      evidence: [{
        digest: action.evidence[0].digest,
        source: "local_safe_scan/v1",
        target: "repository:root-lockfiles",
      }],
      observations: [{
        kind: "local_observation",
        evidence_digest: action.evidence[0].digest,
        target: "repository:root-lockfiles",
        outcome: "No supported root dependency lockfile was present in the complete Local Safe Scan.",
      }],
      targeted_verification: {
        operation: "verify",
        scope: "targeted",
        check_ids: ["web.baseline.lockfile"],
      },
    },
  ]);
  assert.equal(result.report.assessment, "no_go");
  assert.deepEqual(result.snapshot.project.safe_scan.coverage.root_lockfiles, {
    complete: true,
    uncovered: [],
  });
  assert.equal(result.snapshot.project.safe_scan.exclusions.tooling_metadata, 1);
});

test("audit recognizes the binary Bun lockfile without reading its contents", async () => {
  const fixture = await createWebFixture("bun-web");
  await writeFile(
    path.join(fixture, "bun.lockb"),
    Buffer.concat([Buffer.from([0]), Buffer.from(SECRET_SENTINEL)]),
  );

  const stdout = await runCliAudit(fixture, { json: true });
  const result = JSON.parse(stdout);

  assert.equal(result.snapshot.project.package_manager, "bun");
  assert.ok(result.snapshot.project.detected_files.includes("bun.lockb"));
  assert.equal(
    result.report.results.checks.find(
      (check) => check.check_id === "web.baseline.lockfile",
    ).status,
    "passed",
  );
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET_SENTINEL));
});

test("audit renders failed Findings without dumping the Action Queue", async () => {
  const fixture = await createWebFixture("actionable-web");
  const stdout = await runCliAudit(fixture);

  assert.match(
    stdout,
    /Failed Findings \(1\)[\s\S]*\[P0\] web\.baseline\.lockfile\n  No dependency lockfile was found/,
  );
  assert.doesNotMatch(stdout, /Action Queue/u);
});

test("audit distinguishes an invalid package manifest from a missing one", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "launchrally-invalid-manifest-"));
  await writeFile(
    path.join(fixture, "package.json"),
    `{ "token": "${SECRET_SENTINEL}", invalid json`,
  );

  const stdout = await runCliAudit(fixture, { json: true });
  const result = JSON.parse(stdout);

  assert.equal(result.snapshot.project.type, "unknown");
  assert.deepEqual(result.snapshot.project.package_manifest, {
    path: "package.json",
    status: "invalid",
  });
  assert.ok(result.snapshot.project.detected_files.includes("package.json"));
  assert.deepEqual(result.snapshot.obvious_blockers, [
    "package.json exists but could not be read as a valid package manifest.",
  ]);
  assert.doesNotMatch(stdout, new RegExp(SECRET_SENTINEL));

  const terminalOutput = await runCliAudit(fixture);
  assert.doesNotMatch(terminalOutput, new RegExp(SECRET_SENTINEL));
  assert.match(
    terminalOutput,
    /Failed Findings \(1\)[\s\S]*web\.baseline\.package-manifest\n  The root package manifest is invalid\./,
  );
});

test("audit retains only safe local facts with provenance", async () => {
  const fixture = await createWebFixture("safe-facts", { withLockfile: true });
  await writeFile(
    path.join(fixture, "package.json"),
    JSON.stringify({
      name: "safe-facts",
      scripts: {
        build: "vite build",
        deploy: `deploy --token=${SECRET_SENTINEL}`,
      },
    }),
  );
  await writeFile(
    path.join(fixture, ".env"),
    [
      `API_TOKEN=${SECRET_SENTINEL}`,
      `export DATABASE_URL="postgres://${SECRET_SENTINEL}@localhost/db"`,
      "EMPTY=",
      "# COMMENTED_SECRET=must-not-be-a-fact",
    ].join("\n"),
  );
  await writeFile(path.join(fixture, ".gitignore"), ".env\n");
  await mkdir(path.join(fixture, "src"));
  await writeFile(path.join(fixture, "src", "main.js"), "export const ready = true;\n");
  await writeFile(path.join(fixture, "vite.config.js"), "export default {};\n");

  const before = await snapshotFiles(fixture);
  const networkGuard = await createNetworkGuard();
  const stdout = await runCliAudit(fixture, {
    json: true,
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${networkGuard}`.trim(),
    },
  });
  const result = JSON.parse(stdout);
  const serialized = JSON.stringify(result);

  assert.doesNotMatch(serialized, new RegExp(SECRET_SENTINEL));
  assert.deepEqual(result.snapshot.project.script_names, ["build", "deploy"]);
  assert.equal("scripts" in result.snapshot.project, false);

  const environmentFact = result.snapshot.project.facts.find(
    (fact) => fact.kind === "environment_variables",
  );
  assert.deepEqual(environmentFact, {
    kind: "environment_variables",
    names: ["API_TOKEN", "DATABASE_URL", "EMPTY"],
    provenance: {
      path: ".env",
      collector: "local_safe_scan/v1",
    },
  });

  const factPaths = result.snapshot.project.facts.map((fact) => fact.provenance.path);
  assert.ok(factPaths.includes("src/main.js"));
  assert.ok(factPaths.includes("vite.config.js"));
  assert.ok(
    result.snapshot.project.facts.every(
      (fact) => fact.provenance.collector === "local_safe_scan/v1" && fact.provenance.path,
    ),
  );
  assert.equal(result.report.provenance.scan_policy_version, "local_safe_scan/v1");

  const terminalOutput = await runCliAudit(fixture);
  assert.doesNotMatch(terminalOutput, new RegExp(SECRET_SENTINEL));
  assert.deepEqual(await snapshotFiles(fixture), before);
});

test("audit excludes ignored, generated, binary, large, and unsupported content", async () => {
  const fixture = await createWebFixture("safe-exclusions", { withLockfile: true });
  await writeFile(
    path.join(fixture, ".gitignore"),
    ["ignored/", "secrets-[0-9].js", "\\#literal.js", "\\!literal.js"].join("\n"),
  );

  await mkdir(path.join(fixture, "ignored"));
  await writeFile(path.join(fixture, "ignored", "ignored.js"), SECRET_SENTINEL);
  await writeFile(path.join(fixture, "secrets-7.js"), SECRET_SENTINEL);
  await writeFile(path.join(fixture, "#literal.js"), SECRET_SENTINEL);
  await writeFile(path.join(fixture, "!literal.js"), SECRET_SENTINEL);
  await mkdir(path.join(fixture, "node_modules", "fixture-package"), { recursive: true });
  await writeFile(
    path.join(fixture, "node_modules", "fixture-package", "index.js"),
    SECRET_SENTINEL,
  );
  await mkdir(path.join(fixture, "dist"));
  await writeFile(path.join(fixture, "dist", "bundle.js"), SECRET_SENTINEL);
  await writeFile(
    path.join(fixture, "binary.js"),
    Buffer.concat([Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from(SECRET_SENTINEL)]),
  );
  await writeFile(
    path.join(fixture, "large.js"),
    `${SECRET_SENTINEL}${"x".repeat(256 * 1024)}`,
  );
  await writeFile(path.join(fixture, "notes.txt"), SECRET_SENTINEL);

  const stdout = await runCliAudit(fixture, { json: true });
  const result = JSON.parse(stdout);
  const serialized = JSON.stringify(result);
  const factPaths = result.snapshot.project.facts.map((fact) => fact.provenance.path);

  assert.doesNotMatch(serialized, new RegExp(SECRET_SENTINEL));
  assert.ok(!factPaths.includes("ignored/ignored.js"));
  assert.ok(!factPaths.includes("node_modules/fixture-package/index.js"));
  assert.ok(!factPaths.includes("dist/bundle.js"));
  assert.ok(!factPaths.includes("binary.js"));
  assert.ok(!factPaths.includes("large.js"));
  assert.ok(!factPaths.includes("notes.txt"));
  assert.deepEqual(result.snapshot.project.safe_scan.exclusions, {
    ignored: 4,
    dependencies: 1,
    build_outputs: 1,
    tooling_metadata: 0,
    binary: 1,
    large: 1,
    unsupported: 1,
    symlinks: 0,
    nested_repositories: 0,
    outside_root: 0,
    unreadable: 0,
  });
});

test("audit excludes Agent tooling metadata without hiding release-relevant repository facts", async () => {
  const fixture = await createWebFixture("tooling-metadata", { withLockfile: true });
  await writeFile(path.join(fixture, ".env"), "APP_MODE=production\n");
  await mkdir(path.join(fixture, ".github", "workflows"), { recursive: true });
  await writeFile(
    path.join(fixture, ".github", "workflows", "release.yml"),
    "name: release\n",
  );
  await writeFile(path.join(fixture, "wrangler.toml"), "name = \"tooling-metadata\"\n");

  for (const directory of [".agents", ".claude", ".codex"]) {
    const metadataRoot = path.join(fixture, directory, "skills", "release-helper");
    await mkdir(metadataRoot, { recursive: true });
    await writeFile(
      path.join(metadataRoot, "package.json"),
      JSON.stringify({
        name: `${directory}-release-helper`,
        scripts: { deploy: "agent-owned-deploy" },
      }),
    );
    await writeFile(path.join(metadataRoot, "bun.lock"), "lockfileVersion = 1\n");
    await writeFile(
      path.join(metadataRoot, ".env"),
      "DATABASE_URL=agent-owned\nSENTRY_DSN=agent-owned\n",
    );
  }
  await symlink(path.join(fixture, ".agents"), path.join(fixture, "agent-metadata-alias"));

  const result = JSON.parse(await runCliAudit(fixture, { json: true }));
  const factPaths = result.snapshot.project.facts.map((fact) => fact.provenance.path);
  const digestPaths = result.report.verification_context.repository_digests.map(
    (entry) => entry.path,
  );
  const applicability = Object.fromEntries(result.report.results.checks.map((check) => [
    check.check_id,
    check.applicability.status,
  ]));

  assert.equal(result.snapshot.project.type, "web");
  assert.equal(result.snapshot.project.package_manager, "npm");
  assert.deepEqual(result.snapshot.project.script_names, ["build"]);
  assert.equal(applicability["web.baseline.data-state"], "not_applicable");
  assert.equal(applicability["web.baseline.observability"], "not_applicable");
  assert.ok(factPaths.includes("package.json"));
  assert.ok(factPaths.includes("package-lock.json"));
  assert.ok(factPaths.includes(".github/workflows/release.yml"));
  assert.ok(factPaths.includes("wrangler.toml"));
  assert.ok(digestPaths.includes(".github/workflows/release.yml"));
  assert.ok(digestPaths.includes("wrangler.toml"));
  assert.ok(!factPaths.some((factPath) => /^(?:\.agents|\.claude|\.codex)\//u.test(factPath)));
  assert.ok(!digestPaths.some((digestPath) => /^(?:\.agents|\.claude|\.codex)\//u.test(digestPath)));
  assert.equal(result.snapshot.project.safe_scan.exclusions.tooling_metadata, 3);
  assert.equal(result.snapshot.project.safe_scan.exclusions.symlinks, 1);

  await writeFile(
    path.join(fixture, ".agents", "skills", "release-helper", "package.json"),
    JSON.stringify({ name: "changed-agent-metadata", scripts: { build: "changed" } }),
  );
  assert.equal(evaluateReportCurrentness(result, { cwd: fixture }).current, true);
});

test("audit fails closed when repository ignore rules cannot be read safely", async () => {
  const fixture = await createWebFixture("unsafe-ignore", { withLockfile: true });
  await writeFile(
    path.join(fixture, ".gitignore"),
    `${SECRET_SENTINEL}${"x".repeat(256 * 1024)}`,
  );
  await writeFile(path.join(fixture, "source.js"), SECRET_SENTINEL);

  const stdout = await runCliAudit(fixture, { json: true });
  const result = JSON.parse(stdout);

  assert.doesNotMatch(stdout, new RegExp(SECRET_SENTINEL));
  assert.deepEqual(result.snapshot.project.facts, []);
  assert.equal(result.snapshot.project.safe_scan.exclusions.large, 1);
});

test("an ignored root lockfile is uncovered scope and never a complete negative finding", async () => {
  const fixture = await createWebFixture("ignored-lockfile", { withLockfile: true });
  await writeFile(path.join(fixture, ".gitignore"), "package-lock.json\n");

  const result = JSON.parse(await runCliAudit(fixture, { json: true }));
  const lockfile = result.report.results.checks.find(
    (check) => check.check_id === "web.baseline.lockfile",
  );

  assert.equal(result.snapshot.project.safe_scan.coverage.root_lockfiles.complete, false);
  assert.deepEqual(result.snapshot.project.safe_scan.coverage.root_lockfiles.uncovered, [{
    path: "package-lock.json",
    reason: "ignored",
  }]);
  assert.equal(lockfile.status, "unverified");
  assert.equal(
    result.report.results.verification_gaps.find(
      (gap) => gap.check_id === "web.baseline.lockfile",
    ).reason_code,
    "uncovered_scope",
  );
});

test("audit never follows symlinks or enters nested repositories", async () => {
  const fixture = await createWebFixture("safe-boundaries", { withLockfile: true });
  const outside = await mkdtemp(path.join(os.tmpdir(), "launchrally-outside-"));
  await writeFile(path.join(outside, "outside.js"), SECRET_SENTINEL);
  await writeFile(path.join(outside, ".env"), `ESCAPED_TOKEN=${SECRET_SENTINEL}\n`);

  await symlink(outside, path.join(fixture, "linked-directory"));
  await symlink(path.join(outside, "outside.js"), path.join(fixture, "linked.js"));

  const nested = path.join(fixture, "nested-project");
  await mkdir(path.join(nested, ".git"), { recursive: true });
  await writeFile(path.join(nested, "index.js"), SECRET_SENTINEL);
  await writeFile(path.join(nested, ".env"), `NESTED_TOKEN=${SECRET_SENTINEL}\n`);

  const stdout = await runCliAudit(fixture, { json: true });
  const result = JSON.parse(stdout);
  const serialized = JSON.stringify(result);
  const factPaths = result.snapshot.project.facts.map((fact) => fact.provenance.path);

  assert.doesNotMatch(serialized, new RegExp(SECRET_SENTINEL));
  assert.ok(!factPaths.some((factPath) => factPath.startsWith("linked")));
  assert.ok(!factPaths.some((factPath) => factPath.startsWith("nested-project/")));
  assert.equal(result.snapshot.project.safe_scan.exclusions.symlinks, 2);
  assert.equal(result.snapshot.project.safe_scan.exclusions.nested_repositories, 1);
  assert.equal(result.snapshot.project.safe_scan.exclusions.outside_root, 0);
});

test("audit rejects a symlink selected as its root", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "launchrally-root-target-"));
  await writeFile(path.join(outside, ".env"), `ROOT_TOKEN=${SECRET_SENTINEL}\n`);
  const linkDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrally-root-link-"));
  const linkedRoot = path.join(linkDirectory, "audit-root");
  await symlink(outside, linkedRoot);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [cli, "audit", "--json", "--cwd", linkedRoot],
      { cwd: root },
    ),
    (error) => {
      const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      assert.doesNotMatch(output, new RegExp(SECRET_SENTINEL));
      const result = JSON.parse(error.stdout);
      assert.equal(result.error, "local_safe_scan_failed");
      return true;
    },
  );
});

test("audit errors never expose filesystem details or secret-like values", async () => {
  const missingRoot = path.join(
    os.tmpdir(),
    `launchrally-missing-${SECRET_SENTINEL}`,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [cli, "audit", "--json", "--cwd", missingRoot],
      { cwd: root },
    ),
    (error) => {
      const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      assert.doesNotMatch(output, new RegExp(SECRET_SENTINEL));
      const result = JSON.parse(error.stdout);
      assert.deepEqual(result, {
        contract: "launchrally.dev/cli/v2",
        status: "execution_error",
        operation: "audit",
        error: "local_safe_scan_failed",
        message: "Local Safe Scan could not complete safely.",
      });
      return true;
    },
  );
});

test("Verify fails closed until a complete source Report is supplied", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "verify", "--json"], { cwd: root }),
    (error) => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.status, "execution_error");
      assert.equal(result.operation, "verify");
      assert.equal(result.error, "invalid_report_package");
      return true;
    },
  );
});

test("plugin manifests and public schemas are valid JSON", async () => {
  const files = [
    "adapters/codex/launchrally/.codex-plugin/plugin.json",
    "adapters/claude/launchrally/.claude-plugin/plugin.json",
    "packages/contracts/schemas/manifest/v1.schema.json",
    "packages/contracts/schemas/manifest/v2.schema.json",
    "packages/contracts/schemas/report/v1.schema.json",
    "packages/contracts/schemas/report/v2.schema.json",
    "packages/contracts/schemas/report-view/v1.schema.json",
    "packages/contracts/schemas/report-view/v2.schema.json",
    "packages/contracts/schemas/evidence-index/v1.schema.json",
    "packages/contracts/schemas/audit-brief/v1.schema.json",
    "packages/contracts/schemas/audit-interaction/v1.schema.json",
    "packages/contracts/schemas/init-interaction/v1.schema.json",
    "packages/contracts/schemas/init-interaction/v2.schema.json",
    "packages/contracts/schemas/launch-plan/v1.schema.json",
    "packages/contracts/schemas/launch-plan/v2.schema.json",
    "packages/contracts/schemas/verify-interaction/v1.schema.json",
    "packages/contracts/schemas/verify-interaction/v2.schema.json",
    "packages/contracts/schemas/verification-result/v1.schema.json",
    "packages/contracts/schemas/verification-result/v2.schema.json",
    "packages/contracts/schemas/provider-decision-card/v1.schema.json",
    "packages/contracts/schemas/provider-guidance-interaction/v1.schema.json",
    "packages/contracts/schemas/provider-guidance/v1.schema.json",
    "packages/contracts/schemas/provider-guidance/v2.schema.json",
    "packages/contracts/schemas/cli/v2.schema.json",
  ];

  for (const relative of files) {
    const content = await readFile(path.join(root, relative), "utf8");
    assert.doesNotThrow(() => JSON.parse(content), relative);
  }
});
