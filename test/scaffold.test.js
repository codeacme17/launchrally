import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "packages", "cli", "bin", "rally.js");

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

test("audit returns a local Initial Readiness Snapshot and Web baseline result", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "launchrally-web-fixture-"));
  await writeFile(
    path.join(fixture, "package.json"),
    JSON.stringify({ name: "fixture-web", scripts: { build: "vite build" } }),
  );
  await writeFile(path.join(fixture, "package-lock.json"), '{"lockfileVersion":3}');
  const before = await snapshotFiles(fixture);
  const networkGuard = await createNetworkGuard();

  const { stdout } = await execFileAsync(process.execPath, [cli, "audit", "--json", "--cwd", fixture], {
    cwd: root,
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${networkGuard}`.trim(),
    },
  });
  const result = JSON.parse(stdout);

  assert.equal(result.contract, "launchrally.dev/cli/v0");
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
    scripts: { build: "vite build" },
    detected_files: ["package.json", "package-lock.json"],
  });
  assert.deepEqual(result.snapshot.obvious_blockers, []);
  assert.deepEqual(result.snapshot.next, {
    type: "none",
    required: false,
    message: "No input or approval is required for this local-only Audit.",
  });
  assert.deepEqual(result.report.results.checks, [
    {
      check_id: "web.baseline.lockfile",
      check_version: 1,
      priority: "p0",
      status: "passed",
      summary: "A dependency lockfile is present for reproducible installs.",
      evidence: [{ kind: "file", path: "package-lock.json" }],
    },
  ]);
  assert.equal(result.report.results.verification_gaps.length, 1);
  assert.equal(result.report.results.verification_gaps[0].priority, "p0");
  assert.equal(result.report.results.verification_gaps[0].status, "unverified");
  assert.equal(result.report.results.coverage_summary[0].coverage, "partial");
  assert.ok(result.snapshot.limitations.length > 0);

  assert.deepEqual(await snapshotFiles(fixture), before);
  await assert.rejects(access(path.join(fixture, ".launchrally")));
});

test("audit renders the Snapshot, Check, gap, and limitation for a person", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "launchrally-terminal-fixture-"));
  await writeFile(
    path.join(fixture, "package.json"),
    JSON.stringify({ name: "terminal-web", scripts: { build: "vite build" } }),
  );
  await writeFile(path.join(fixture, "package-lock.json"), '{"lockfileVersion":3}');

  const { stdout } = await execFileAsync(process.execPath, [cli, "audit", "--cwd", fixture], {
    cwd: root,
  });

  assert.match(
    stdout,
    /Initial Readiness Snapshot[\s\S]*Project: terminal-web \(web\)[\s\S]*PASS \[P0\] web\.baseline\.lockfile[\s\S]*Assessment: Inconclusive[\s\S]*UNVERIFIED \[P0\] web\.p0\.remaining-coverage[\s\S]*Limitations:/,
  );
});

test("audit reports a failed Web baseline Check when the lockfile is missing", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "launchrally-unlocked-fixture-"));
  await writeFile(
    path.join(fixture, "package.json"),
    JSON.stringify({ name: "unlocked-web", scripts: { build: "vite build" } }),
  );

  const { stdout } = await execFileAsync(process.execPath, [cli, "audit", "--json", "--cwd", fixture], {
    cwd: root,
  });
  const result = JSON.parse(stdout);

  assert.deepEqual(result.report.results.checks, [
    {
      check_id: "web.baseline.lockfile",
      check_version: 1,
      priority: "p0",
      status: "failed",
      summary: "No dependency lockfile was found, so installs are not reproducible.",
      evidence: [],
    },
  ]);
  assert.deepEqual(result.report.results.action_queue, [
    {
      check_id: "web.baseline.lockfile",
      priority: "p0",
      action: "Commit the package manager lockfile generated by the project dependency install.",
    },
  ]);
  assert.equal(result.report.assessment, "no_go");
});

test("audit renders obvious blockers and remediation actions for a person", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "launchrally-readable-failure-"));
  await writeFile(
    path.join(fixture, "package.json"),
    JSON.stringify({ name: "actionable-web", scripts: { build: "vite build" } }),
  );

  const { stdout } = await execFileAsync(process.execPath, [cli, "audit", "--cwd", fixture], {
    cwd: root,
  });

  assert.match(
    stdout,
    /Obvious Blockers:\n  None[\s\S]*Action Queue:\n  \[P0\] web\.baseline\.lockfile — Commit the package manager lockfile/,
  );
});

test("audit distinguishes an invalid package manifest from a missing one", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "launchrally-invalid-manifest-"));
  await writeFile(path.join(fixture, "package.json"), "{ invalid json");

  const { stdout } = await execFileAsync(process.execPath, [cli, "audit", "--json", "--cwd", fixture], {
    cwd: root,
  });
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

  const { stdout: terminalOutput } = await execFileAsync(
    process.execPath,
    [cli, "audit", "--cwd", fixture],
    { cwd: root },
  );
  assert.match(
    terminalOutput,
    /Obvious Blockers:\n  - package\.json exists but could not be read as a valid package manifest\./,
  );
});

test("reserved workflows return not_implemented", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "plan", "--json"], { cwd: root }),
    (error) => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.status, "not_implemented");
      assert.equal(result.operation, "plan");
      return true;
    },
  );
});

test("plugin manifests and public schemas are valid JSON", async () => {
  const files = [
    "adapters/codex/launchrally/.codex-plugin/plugin.json",
    "adapters/claude/launchrally/.claude-plugin/plugin.json",
    "packages/contracts/schemas/manifest/v1.schema.json",
    "packages/contracts/schemas/report/v1.schema.json",
  ];

  for (const relative of files) {
    const content = await readFile(path.join(root, relative), "utf8");
    assert.doesNotThrow(() => JSON.parse(content), relative);
  }
});
