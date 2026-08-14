import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { copyRepositoryFixture } from "./helpers/repository-fixture.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

async function fixture() {
  return copyRepositoryFixture(root, "launchrally-p1-governance-", [
    ".github",
    "adapters",
    "docs",
    "package.json",
    "packages",
    "release",
    "scripts",
    "skills",
    "test",
  ]);
}

async function validateP1(directory) {
  return execFileAsync(
    process.execPath,
    ["scripts/validate-p1.mjs", "--root", directory, "--json"],
    { cwd: root },
  );
}

test("the independent P1 governance contract maps every canonical requirement", async () => {
  const { stdout } = await validateP1(root);
  const result = JSON.parse(stdout);

  assert.equal(result.status, "completed");
  assert.equal(result.schema_version, "launchrally.dev/p1-release/v1");
  assert.equal(result.product_status, "incomplete");
  assert.equal(result.release_status, "experimental");
  assert.deepEqual(result.requirements, { complete: 37, open: 1, total: 38 });
  assert.deepEqual(result.suspended_authorities, []);
  assert.equal(result.p0_release_status, "stable");
});

test("P1 validation rejects a requirement deleted from both the matrix and documentation", async () => {
  const directory = await fixture();
  const matrixPath = path.join(directory, "release/p1-acceptance.json");
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  matrix.requirements = matrix.requirements.filter(({ id }) => id !== "P1-INTENT-01");
  await writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);
  const docsPath = path.join(directory, "docs/maintainers/p1-acceptance.md");
  const docs = await readFile(docsPath, "utf8");
  await writeFile(
    docsPath,
    docs.split("\n").filter((line) => !line.startsWith("| P1-INTENT-01 |" )).join("\n"),
  );

  await assert.rejects(validateP1(directory), (error) => {
    assert.match(error.stderr, /p1_unmapped_requirement: P1-INTENT-01/u);
    return true;
  });
});

test("a P1 regression suspends only its declared authority and never changes P0 Stable", async () => {
  const directory = await fixture();
  const matrixPath = path.join(directory, "release/p1-acceptance.json");
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  const condition = matrix.quality_floor.find(({ id }) => id === "P1-QF-03");
  condition.status = "suspended";
  condition.regressions.push({
    regression_id: "P1-REG-0001",
    affected_authority_scopes: ["machine_evidence"],
    status: "open",
    reviewed_fix: null,
    restoration: null,
  });
  await writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);

  const { stdout } = await validateP1(directory);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.suspended_authorities, ["machine_evidence"]);
  assert.equal(result.p0_release_status, "stable");
  assert.equal(result.quality_floor_status, "suspended");
});

test("a reviewed P1 fix remains suspended until a distinct restoration entry", async () => {
  const directory = await fixture();
  const matrixPath = path.join(directory, "release/p1-acceptance.json");
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  const condition = matrix.quality_floor.find(({ id }) => id === "P1-QF-14");
  condition.status = "suspended";
  condition.regressions.push({
    regression_id: "P1-REG-0014",
    affected_authority_scopes: ["active_verification"],
    status: "fixed",
    reviewed_fix: "review:production-active-verification-boundary",
    restoration: null,
  });
  await writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);

  const fixed = JSON.parse((await validateP1(directory)).stdout);
  assert.deepEqual(fixed.suspended_authorities, ["active_verification"]);

  condition.status = "satisfied";
  condition.regressions[0].status = "restored";
  condition.regressions[0].restoration = "review:quality-floor-restored";
  await writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);
  const restored = JSON.parse((await validateP1(directory)).stdout);
  assert.deepEqual(restored.suspended_authorities, []);
});

test("P0 Stable never promotes P1 beyond Experimental without separate approval", async () => {
  const directory = await fixture();
  const contractPath = path.join(directory, "release/p1.json");
  const matrixPath = path.join(directory, "release/p1-acceptance.json");
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  contract.release_status = "stable";
  matrix.release_status = "stable";
  await Promise.all([
    writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`),
    writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`),
  ]);

  await assert.rejects(validateP1(directory), (error) => {
    assert.match(error.stderr, /p1_stable_promotion_blocked/u);
    return true;
  });
});
