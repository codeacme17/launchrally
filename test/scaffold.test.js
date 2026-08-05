import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "packages", "cli", "bin", "rally.js");

test("template audit is read-only and explicitly inconclusive", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "launchrally-fixture-"));
  await writeFile(path.join(fixture, "package.json"), JSON.stringify({ name: "fixture-web" }));

  const { stdout } = await execFileAsync(process.execPath, [cli, "audit", "--json", "--cwd", fixture], {
    cwd: root,
  });
  const result = JSON.parse(stdout);

  assert.equal(result.status, "completed");
  assert.equal(result.report.assessment, "inconclusive");
  assert.equal(result.snapshot.project.name, "fixture-web");
  assert.equal(result.report.results.verification_gaps.length, 1);

  await assert.rejects(access(path.join(fixture, ".launchrally")));
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

test("plugin manifests and public schema scaffolds are valid JSON", async () => {
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
