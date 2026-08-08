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

async function createP0Fixture() {
  return copyRepositoryFixture(root, "launchrally-p0-", [
    ".github",
    "CONTRIBUTING.md",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "adapters",
    "docs",
    "package.json",
    "packages",
    "release",
  ]);
}

test("the P0 release contract declares truthful pre-release telemetry-free status", async () => {
  const { stdout } = await execFileAsync(
    "npm",
    ["--silent", "run", "validate:p0", "--", "--json"],
    { cwd: root },
  );

  assert.deepEqual(JSON.parse(stdout), {
    status: "completed",
    phase: "p0",
    product_status: "incomplete",
    release_status: "release_candidate",
    validation_mode: "telemetry_free",
    license: "Apache-2.0",
    feedback_channels: ["discussions", "issues", "security"],
    quality_floor: [
      "reference_journey",
      "coverage_acceptance_matrix",
      "prd_traceability",
      "release_packaging",
      "p0_release_contract",
    ],
  });
});

test("the public release kit documents use, data, safety, feedback, and validation", async () => {
  const [readme, quickstart, dataModel, privacy, contribution, security, validation] =
    await Promise.all([
      "README.md",
      "docs/quickstart.md",
      "docs/data-model.md",
      "docs/privacy.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "docs/phase-0-validation.md",
    ].map((relative) => readFile(path.join(root, relative), "utf8")));
  const log = JSON.parse(await readFile(
    path.join(root, "docs/phase-0-validation-log.json"),
    "utf8",
  ));

  assert.match(readme, /Status: Pre-release development/iu);
  assert.match(readme, /github\.com\/codeacme17\/launchrally\/issues/u);
  assert.match(readme, /github\.com\/codeacme17\/launchrally\/discussions/u);
  assert.match(readme, /SECURITY\.md/u);
  assert.match(readme, /CONTRIBUTING\.md/u);

  assert.match(
    quickstart,
    /npm exec --package=@launchrally\/cli@0\.1\.0 -- rally audit --json --cwd \./u,
  );
  assert.match(quickstart, /Skill Quickstart/iu);
  for (const context of ["Astro", "FastAPI", "React", "Go", "pnpm", "self-hosted"]) {
    assert.match(quickstart, new RegExp(context, "iu"));
  }
  assert.match(quickstart, /secret-free/iu);

  for (const concept of ["Manifest", "Report Record", "Evidence Index"]) {
    assert.match(dataModel, new RegExp(concept, "u"));
  }
  assert.match(dataModel, /\.launchrally\/launch-manifest\.json/u);

  for (const boundary of [
    "no LaunchRally account",
    "no default telemetry",
    "no mandatory Report upload",
    "no user-level analytics",
    "no LaunchRally private service",
  ]) {
    assert.match(privacy, new RegExp(boundary, "iu"));
  }

  assert.match(contribution, /pull requests?[\s\S]*dev/iu);
  assert.match(contribution, /Apache-2\.0/u);
  assert.match(security, /private vulnerability reporting/iu);
  assert.match(security, /security\/advisories\/new/u);

  for (const stage of [
    "P0 is not Product Complete",
    "P0 Product Complete",
    "Experimental release",
    "Telemetry-Free Validation",
    "P0 Validated",
  ]) {
    assert.match(validation, new RegExp(stage, "u"));
  }
  assert.match(validation, /No hard download quota/iu);

  assert.equal(log.schema_version, "launchrally.dev/phase-0-validation-log/v1");
  assert.equal(log.collection_mode, "telemetry_free");
  assert.ok(Array.isArray(log.entries) && log.entries.length > 0);
  const entry = log.entries[0];
  assert.ok(entry.aggregate_adoption_trends);
  assert.ok(Array.isArray(entry.voluntary_feedback_categories));
  assert.ok(Array.isArray(entry.represented_contexts.frameworks));
  assert.ok(Array.isArray(entry.represented_contexts.deployments));
  assert.ok(Array.isArray(entry.recurring_p1_requests));
  assert.ok(Array.isArray(entry.product_decisions));
});

test("GitHub contribution entry points route feedback and security reports", async () => {
  const issueConfig = await readFile(
    path.join(root, ".github/ISSUE_TEMPLATE/config.yml"),
    "utf8",
  );

  assert.match(issueConfig, /blank_issues_enabled: true/u);
  assert.match(issueConfig, /github\.com\/codeacme17\/launchrally\/issues/u);
  assert.match(issueConfig, /github\.com\/codeacme17\/launchrally\/discussions/u);
  assert.match(issueConfig, /github\.com\/codeacme17\/launchrally\/security\/advisories\/new/u);
});

test("P0 validation fails closed when a telemetry-free boundary disappears", async () => {
  const fixture = await createP0Fixture();
  const privacyPath = path.join(fixture, "docs/privacy.md");
  const privacy = await readFile(privacyPath, "utf8");
  await writeFile(privacyPath, privacy.replace("no default telemetry", "optional analytics"));

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_release_incomplete/u);
      assert.match(error.stderr, /docs\/privacy\.md.*no default telemetry/iu);
      return true;
    },
  );
});

test("Apache-2.0 covers the source tree and every public release artifact", async () => {
  const rootPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const release = JSON.parse(await readFile(
    path.join(root, "release/artifacts.json"),
    "utf8",
  ));
  const license = await readFile(path.join(root, "LICENSE"), "utf8");

  assert.equal(rootPackage.license, "Apache-2.0");
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/u);
  assert.match(license, /END OF TERMS AND CONDITIONS/u);

  for (const artifact of release.packages) {
    const packageJson = JSON.parse(await readFile(
      path.join(root, artifact.path, "package.json"),
      "utf8",
    ));
    const artifactLicense = await readFile(
      path.join(root, artifact.path, "LICENSE"),
      "utf8",
    );
    assert.equal(packageJson.license, "Apache-2.0", artifact.name);
    assert.ok(artifact.files.includes("LICENSE"), artifact.name);
    assert.equal(artifactLicense, license, artifact.name);
  }
});

test("P0 validation rejects a public package with license drift", async () => {
  const fixture = await createP0Fixture();
  const packagePath = path.join(fixture, "packages/cli/package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.license = "UNLICENSED";
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_license_drift/u);
      assert.match(error.stderr, /@launchrally\/cli.*UNLICENSED.*Apache-2\.0/u);
      return true;
    },
  );
});

test("clean CI and tagged releases enforce the P0 quality floor", async () => {
  const [ci, release] = await Promise.all([
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
  ].map((relative) => readFile(path.join(root, relative), "utf8")));

  for (const workflow of [ci, release]) {
    assert.match(workflow, /npm ci --ignore-scripts/u);
    assert.match(workflow, /npm run build/u);
    assert.match(workflow, /git diff --exit-code/u);
    assert.match(workflow, /npm test/u);
    assert.match(workflow, /npm run validate:p0/u);
    assert.match(workflow, /npm run validate:release/u);
    assert.match(workflow, /npm run test:artifacts/u);
  }
});

test("the Phase 0 Validation Log rejects user-level analytics", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/phase-0-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  log.entries[0].user_id = "builder-123";
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_user_analytics_forbidden/u);
      assert.match(error.stderr, /user_id/u);
      return true;
    },
  );
});
