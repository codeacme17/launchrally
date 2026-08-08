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

async function createAcceptanceFixture() {
  return copyRepositoryFixture(root, "launchrally-acceptance-", [
    ".github",
    "adapters",
    "docs",
    "fixtures",
    "package.json",
    "packages",
    "release",
    "scripts",
    "skills",
    "test",
  ]);
}

test("the committed P0 matrix maps every normative requirement to executable evidence", async () => {
  const { stdout } = await execFileAsync(
    "npm",
    ["--silent", "run", "validate:acceptance", "--", "--json"],
    { cwd: root },
  );

  assert.deepEqual(JSON.parse(stdout), {
    status: "completed",
    schema_version: "launchrally.dev/p0-acceptance/v1",
    product_status: "incomplete",
    release_status: "release_candidate",
    requirements: { complete: 18, open: 4, total: 22 },
    release_gates: 10,
  });
});

test("acceptance validation rejects a missing mandatory release gate", async () => {
  const fixture = await createAcceptanceFixture();
  const matrixPath = path.join(fixture, "release/p0-acceptance.json");
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  matrix.release_gates = matrix.release_gates.filter(({ id }) => id !== "persistence_recovery");
  await writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-acceptance.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /acceptance_missing_gate/u);
      assert.match(error.stderr, /persistence_recovery/u);
      return true;
    },
  );
});

test("acceptance validation rejects tandem-deleted requirements and renamed tests", async () => {
  const missingFixture = await createAcceptanceFixture();
  const missingPath = path.join(missingFixture, "release/p0-acceptance.json");
  const missing = JSON.parse(await readFile(missingPath, "utf8"));
  missing.requirements = missing.requirements.filter(({ id }) => id !== "P0-CONTRACT-03");
  await writeFile(missingPath, `${JSON.stringify(missing, null, 2)}\n`);
  const acceptancePath = path.join(missingFixture, "docs/p0-acceptance.md");
  const acceptance = await readFile(acceptancePath, "utf8");
  await writeFile(
    acceptancePath,
    acceptance.split("\n").filter((line) => !line.startsWith("| P0-CONTRACT-03 |")).join("\n"),
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-acceptance.mjs", "--root", missingFixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /acceptance_unmapped_requirement.*P0-CONTRACT-03/u);
      return true;
    },
  );

  const staleFixture = await createAcceptanceFixture();
  const stalePath = path.join(staleFixture, "release/p0-acceptance.json");
  const stale = JSON.parse(await readFile(stalePath, "utf8"));
  stale.requirements[0].tests[0].name = "renamed migration contract";
  await writeFile(stalePath, `${JSON.stringify(stale, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-acceptance.mjs", "--root", staleFixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /acceptance_stale_test.*renamed migration contract/u);
      return true;
    },
  );
});

test("CI runs contract and clean journey gates on every required Node and OS target", async () => {
  const [ci, release, packageText] = await Promise.all([
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    "package.json",
  ].map((relativePath) => readFile(path.join(root, relativePath), "utf8")));
  const scripts = JSON.parse(packageText).scripts;

  assert.match(scripts["test:contracts"], /test:release-contracts/u);
  assert.match(scripts["test:release-contracts"], /test\/release\.test\.js/u);
  assert.match(scripts["test:release-contracts"], /--test-name-pattern/u);

  assert.match(ci, /contracts:[\s\S]*runs-on: ubuntu-latest[\s\S]*node: \[20, 22, 24\]/u);
  assert.match(
    ci,
    /journeys:[\s\S]*os: \[ubuntu-latest, macos-latest, windows-latest\][\s\S]*node-version: 22/u,
  );
  assert.match(
    release,
    /contracts:[\s\S]*node: \[20, 22, 24\][\s\S]*journeys:[\s\S]*os: \[ubuntu-latest, macos-latest, windows-latest\]/u,
  );
  assert.match(release, /publish:[\s\S]*needs: \[contracts, journeys\]/u);
  for (const command of [
    "npm run test:contracts",
    "npm run test:journeys",
    "npm run test:artifacts",
    "npm run validate:acceptance",
  ]) {
    assert.match(ci, new RegExp(command, "u"), command);
    assert.match(release, new RegExp(command, "u"), command);
  }
  assert.match(release, /npm run validate:acceptance -- --require-publish-ready/u);
  assert.match(release, /public-smoke:[\s\S]*needs: publish[\s\S]*npm run test:public-release/u);
  assert.match(release, /prerelease:[\s\S]*needs: public-smoke[\s\S]*gh release create/u);
});

test("release readiness fails closed while any normative requirement remains open", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-acceptance.mjs", "--require-release-ready", "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /acceptance_release_blocked/u);
      assert.match(error.stderr, /P0-RELEASE-01/u);
      assert.match(error.stderr, /P0-VALIDATE-02/u);
      return true;
    },
  );
});

test("release readiness accepts the future complete release-candidate transition", async () => {
  const fixture = await createAcceptanceFixture();
  const matrixPath = path.join(fixture, "release/p0-acceptance.json");
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  matrix.product_status = "complete";
  matrix.release_status = "release_candidate";
  for (const requirement of matrix.requirements) requirement.status = "complete";
  await writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);
  const acceptancePath = path.join(fixture, "docs/p0-acceptance.md");
  const acceptance = await readFile(acceptancePath, "utf8");
  await writeFile(acceptancePath, acceptance.replaceAll("| Open |", "| Complete |"));

  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/validate-acceptance.mjs", "--root", fixture, "--require-release-ready", "--json"],
    { cwd: root },
  );
  assert.equal(JSON.parse(stdout).product_status, "complete");
  assert.equal(JSON.parse(stdout).release_status, "release_candidate");
});

test("publication readiness accepts only the approved pre-publication requirements as open", async () => {
  const fixture = await createAcceptanceFixture();
  const matrixPath = path.join(fixture, "release/p0-acceptance.json");
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  await writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);

  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/validate-acceptance.mjs", "--root", fixture, "--require-publish-ready", "--json"],
    { cwd: root },
  );
  assert.equal(JSON.parse(stdout).release_status, "release_candidate");

  matrix.requirements.find(({ id }) => id === "P0-QUALITY-01").status = "open";
  await writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);
  const acceptancePath = path.join(fixture, "docs/p0-acceptance.md");
  const acceptance = await readFile(acceptancePath, "utf8");
  await writeFile(
    acceptancePath,
    acceptance.replace(
      "| P0-QUALITY-01 | PRD traceability, secret safety, permission boundaries, false-confidence invariants, migrations, and recovery are release gates | CI validation | #39 | Complete |",
      "| P0-QUALITY-01 | PRD traceability, secret safety, permission boundaries, false-confidence invariants, migrations, and recovery are release gates | CI validation | #39 | Open |",
    ),
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-acceptance.mjs", "--root", fixture, "--require-publish-ready", "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /acceptance_publish_blocked/u);
      assert.match(error.stderr, /P0-QUALITY-01/u);
      return true;
    },
  );
});

test("public status remains pre-release until an Experimental release exists", async () => {
  const [readme, quickstart, contributing, validation, release] = await Promise.all([
    "README.md",
    "docs/quickstart.md",
    "CONTRIBUTING.md",
    "docs/phase-0-validation.md",
    "release/p0.json",
  ].map((relativePath) => readFile(path.join(root, relativePath), "utf8")));

  assert.match(readme, /Status: Pre-release development/u);
  assert.match(quickstart, /No public Experimental release exists/u);
  assert.match(contributing, /pre-release development project/iu);
  assert.match(validation, /P0 is not Product Complete/iu);
  assert.deepEqual(
    (({ product_status, release_status }) => ({ product_status, release_status }))(
      JSON.parse(release),
    ),
    { product_status: "incomplete", release_status: "release_candidate" },
  );
});
