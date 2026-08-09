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
const COMPLETION_CLAIMS = [
  {
    path: "README.md",
    complete: "P0 is Product Complete and `0.1.0` is publicly available",
    suspended: "The P0 Product Complete claim is suspended while the Quality Floor regression is reviewed; `0.1.0` remains publicly available",
  },
  {
    path: "CONTRIBUTING.md",
    complete: "P0 is Product Complete and publicly released",
    suspended: "The P0 Product Complete claim is suspended while the Quality Floor regression is reviewed, and the Experimental release remains public",
  },
  {
    path: "docs/maintainers/phase-0-validation.md",
    complete: "P0 is Product Complete and `0.1.0` is a public Experimental release.",
    suspended: "The P0 Product Complete claim is suspended while the Quality Floor regression is reviewed; `0.1.0` remains a public Experimental release.",
  },
  {
    path: "docs/maintainers/p0-acceptance.md",
    complete: "P0 is Product Complete and `0.1.0` is publicly available as an Experimental\nrelease.",
    suspended: "The P0 Product Complete claim is suspended while the Quality Floor regression\nis reviewed; `0.1.0` remains publicly available as an Experimental release.",
  },
];

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

async function replaceCompletionClaims(fixture, from, to) {
  await Promise.all(COMPLETION_CLAIMS.map(async (claim) => {
    const documentPath = path.join(fixture, claim.path);
    const content = await readFile(documentPath, "utf8");
    const updated = content.replace(claim[from], claim[to]);
    assert.notEqual(updated, content, `${claim.path} must contain the ${from} claim`);
    await writeFile(documentPath, updated);
  }));
}

test("the P0 release contract keeps Product Complete, Experimental, and validation distinct", async () => {
  const { stdout } = await execFileAsync(
    "npm",
    ["--silent", "run", "validate:p0", "--", "--json"],
    { cwd: root },
  );

  assert.deepEqual(JSON.parse(stdout), {
    status: "completed",
    phase: "p0",
    product_status: "complete",
    release_status: "experimental",
    validation_mode: "telemetry_free",
    validation_status: "collecting",
    p0_validated: false,
    p1_discovery: "allowed",
    p1_authority: "blocked",
    quality_floor_status: "satisfied",
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
      "docs/getting-started/quickstart.md",
      "docs/concepts/data-model.md",
      "docs/concepts/privacy.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "docs/maintainers/phase-0-validation.md",
    ].map((relative) => readFile(path.join(root, relative), "utf8")));
  const log = JSON.parse(await readFile(
    path.join(root, "docs/maintainers/phase-0-validation-log.json"),
    "utf8",
  ));

  assert.match(readme, /Status: Experimental P0/iu);
  assert.match(readme, /P0 is Product Complete/iu);
  assert.match(readme, /Telemetry-Free Validation.*collecting/iu);
  assert.match(readme, /not P0 Validated/iu);
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
    "P0 is Product Complete",
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
  const privacyPath = path.join(fixture, "docs/concepts/privacy.md");
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
      assert.match(error.stderr, /docs\/concepts\/privacy\.md.*no default telemetry/iu);
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
  assert.match(ci, /git fetch origin "\$GITHUB_BASE_REF" --depth=1/u);
  assert.match(ci, /npm run validate:p0 -- --baseline-ref "origin\/\$GITHUB_BASE_REF"/u);
  assert.match(ci, /git fetch origin "\$\{\{ github\.event\.before \}\}" --depth=1/u);
  assert.match(ci, /npm run validate:p0 -- --baseline-ref "\$\{\{ github\.event\.before \}\}"/u);
  assert.match(ci, /github\.event\.before == '0000000000000000000000000000000000000000'/u);
});

test("the Phase 0 Validation Log rejects user-level analytics", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/maintainers/phase-0-validation-log.json");
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

test("P0 validation rejects edits to reviewed Validation Log history", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/maintainers/phase-0-validation-log.json");
  const baselinePath = path.join(fixture, "reviewed-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  await writeFile(baselinePath, `${JSON.stringify(log, null, 2)}\n`);
  log.entries[0].period = "rewritten-history";
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "scripts/validate-p0.mjs",
        "--root",
        fixture,
        "--baseline-log",
        "reviewed-validation-log.json",
        "--json",
      ],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_validation_history_changed/u);
      assert.match(error.stderr, /entry 0/u);
      return true;
    },
  );
});

test("P0 validation compares append-only history with the reviewed Git ref", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/maintainers/phase-0-validation-log.json");
  await execFileAsync("git", ["init"], { cwd: fixture });
  await execFileAsync(
    "git",
    ["add", "release/p0.json", "docs/maintainers/phase-0-validation-log.json"],
    { cwd: fixture },
  );
  await execFileAsync("git", [
    "-c",
    "user.name=LaunchRally Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "review validation log",
  ], { cwd: fixture });
  const log = JSON.parse(await readFile(logPath, "utf8"));
  log.entries[0].period = "rewritten-after-review";
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "scripts/validate-p0.mjs",
        "--root",
        fixture,
        "--baseline-ref",
        "HEAD",
        "--json",
      ],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_validation_history_changed/u);
      return true;
    },
  );
});

test("P0 validation follows the baseline contract when the Validation Log path moves", async () => {
  const fixture = await createP0Fixture();
  const contractPath = path.join(fixture, "release/p0.json");
  const currentContract = JSON.parse(await readFile(contractPath, "utf8"));
  const currentLogPath = path.join(fixture, currentContract.validation_log);
  const legacyLogPath = path.join(fixture, "docs/phase-0-validation-log.json");
  const baselineContract = {
    ...currentContract,
    validation_log: "docs/phase-0-validation-log.json",
  };

  await writeFile(contractPath, `${JSON.stringify(baselineContract, null, 2)}\n`);
  await writeFile(legacyLogPath, await readFile(currentLogPath, "utf8"));
  await execFileAsync("git", ["init"], { cwd: fixture });
  await execFileAsync(
    "git",
    ["add", "release/p0.json", "docs/phase-0-validation-log.json"],
    { cwd: fixture },
  );
  await execFileAsync("git", [
    "-c",
    "user.name=LaunchRally Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "review validation log before path migration",
  ], { cwd: fixture });
  await writeFile(contractPath, `${JSON.stringify(currentContract, null, 2)}\n`);

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "scripts/validate-p0.mjs",
      "--root",
      fixture,
      "--baseline-ref",
      "HEAD",
      "--json",
    ],
    { cwd: root },
  );

  assert.equal(JSON.parse(stdout).status, "completed");
});

test("P0 validation rejects identifying values inside aggregate observations", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/maintainers/phase-0-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  log.entries[0].aggregate_adoption_trends.notes =
    "A report was submitted by builder@example.com.";
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_identifying_data_forbidden/u);
      assert.doesNotMatch(error.stderr, /builder@example\.com/u);
      return true;
    },
  );
});

test("P0 validation rejects repository URLs inside aggregate observations", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/maintainers/phase-0-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  log.entries.at(-1).aggregate_adoption_trends.notes =
    "Observed in https://github.com/example/private-project.";
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_identifying_data_forbidden/u);
      assert.doesNotMatch(error.stderr, /private-project/u);
      return true;
    },
  );
});

test("P0 validation rejects raw support content under unreviewed fields", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/maintainers/phase-0-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  log.entries.at(-1).raw_support_message = "The builder pasted a private failure report.";
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_user_analytics_forbidden/u);
      assert.doesNotMatch(error.stderr, /private failure report/u);
      return true;
    },
  );
});

test("new aggregate entries reject unclassified names and organizations", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/maintainers/phase-0-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  log.entries.at(-1).voluntary_feedback_categories.push("Jane Doe at Acme");
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_identifying_data_forbidden/u);
      assert.doesNotMatch(error.stderr, /Jane Doe|Acme/u);
      return true;
    },
  );
});

test("P0 validation accepts only permitted telemetry-free signal sources", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/maintainers/phase-0-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  log.entries.at(-1).aggregate_adoption_trends.sources.push("mandatory_report_upload");
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_validation_source_forbidden/u);
      assert.match(error.stderr, /mandatory_report_upload/u);
      return true;
    },
  );
});

test("new Validation Log entries require every directional signal category", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/maintainers/phase-0-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  delete log.entries.at(-1).repeated_defect_patterns;
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_validation_entry_incomplete/u);
      return true;
    },
  );
});

test("P0 validation rejects hard adoption quotas as validation criteria", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/maintainers/phase-0-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  log.entries[0].validation_decision = {
    status: "validated",
    hard_download_quota: 100,
    rationale: "The package reached the numeric target.",
  };
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_hard_quota_forbidden/u);
      return true;
    },
  );
});

test("P0 validation rejects numeric adoption thresholds hidden in prose", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/maintainers/phase-0-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  log.entries.at(-1).validation_decision.rationale =
    "P0 becomes validated after at least 100 downloads.";
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_hard_quota_forbidden/u);
      return true;
    },
  );
});

test("P0 validation rejects alternate quantitative validation criteria", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/maintainers/phase-0-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  log.entries.at(-1).validation_decision.rationale =
    "Validated when downloads reach 100.";
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_hard_quota_forbidden/u);
      return true;
    },
  );
});

test("P0 validation rejects numeric quota fields outside the aggregate schema", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/maintainers/phase-0-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  log.entries.at(-1).validation_decision.required_count = 100;
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_hard_quota_forbidden/u);
      return true;
    },
  );
});

test("a Quality Floor regression suspends validation and P1 authority", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/maintainers/phase-0-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  Object.assign(log.entries.at(-1), {
    quality_floor: {
      status: "suspended",
      regressions: [{
        id: "qf-2026-08-08-01",
        category: "permission_boundary",
        status: "open",
        summary: "A permission regression is under review.",
      }],
    },
    validation_decision: {
      ...log.entries.at(-1).validation_decision,
      status: "validated",
      rationale: "Earlier signals looked directionally consistent.",
    },
    p1_gate: {
      discovery: "allowed",
      authority_expanding_implementation: "allowed",
    },
  });
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_quality_floor_suspended/u);
      return true;
    },
  );
});

test("a Quality Floor regression retracts the Product Complete claim", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/maintainers/phase-0-validation-log.json");
  const contractPath = path.join(fixture, "release/p0.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const suspended = structuredClone(log.entries.at(-1));
  Object.assign(suspended, {
    period: "2026-08-10-01",
    quality_floor: {
      status: "suspended",
      regressions: [{
        id: "qf-2026-08-10-01",
        category: "permission_boundary",
        status: "open",
        summary: "permission_boundary_regression_under_review",
      }],
    },
    validation_decision: {
      ...log.entries.at(-1).validation_decision,
      status: "not_validated",
      rationale: "quality_floor_regression_suspends_completion",
    },
    p1_gate: {
      discovery: "allowed",
      authority_expanding_implementation: "blocked",
    },
  });
  log.entries.push(suspended);
  Object.assign(contract, {
    product_status: "suspended",
    validation_status: "suspended",
    p0_validated: false,
    quality_floor_status: "suspended",
    p1_discovery: "allowed",
    p1_authority: "blocked",
  });
  await Promise.all([
    writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`),
    writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`),
  ]);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_completion_claim_drift/u);
      return true;
    },
  );

  await replaceCompletionClaims(fixture, "complete", "suspended");

  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
    { cwd: root },
  );
  assert.equal(JSON.parse(stdout).product_status, "suspended");
});

test("a suspended Quality Floor requires a documented verified fix before restoration", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/maintainers/phase-0-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  const suspended = structuredClone(log.entries.at(-1));
  suspended.period = "2026-08-10-01";
  suspended.quality_floor = {
    status: "suspended",
    regressions: [{
      id: "qf-2026-08-10-01",
      category: "permission_boundary",
      status: "open",
      summary: "permission_boundary_regression_under_review",
    }],
  };
  suspended.validation_decision.status = "not_validated";
  suspended.validation_decision.rationale = "quality_floor_regression_suspends_completion";
  suspended.p1_gate.authority_expanding_implementation = "blocked";
  const restored = structuredClone(log.entries.at(-1));
  restored.period = "2026-08-11-01";
  restored.quality_floor = { status: "satisfied", regressions: [] };
  log.entries.push(suspended, restored);
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_quality_floor_fix_missing/u);
      return true;
    },
  );
});

test("every Quality Floor regression ID requires its own verified fix", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/maintainers/phase-0-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  const suspended = structuredClone(log.entries.at(-1));
  suspended.period = "2026-08-10-01";
  suspended.quality_floor = {
    status: "suspended",
    regressions: [
      {
        id: "qf-2026-08-10-01",
        category: "permission_boundary",
        status: "open",
        summary: "permission_boundary_regression_under_review",
      },
      {
        id: "qf-2026-08-10-02",
        category: "permission_boundary",
        status: "open",
        summary: "permission_boundary_regression_under_review",
      },
    ],
  };
  suspended.validation_decision.status = "not_validated";
  suspended.p1_gate.authority_expanding_implementation = "blocked";
  const partiallyRestored = structuredClone(log.entries.at(-1));
  partiallyRestored.period = "2026-08-11-01";
  partiallyRestored.quality_floor = {
    status: "satisfied",
    regressions: [
      {
        id: "qf-2026-08-09-01",
        category: "evidence_integrity",
        status: "verified_fixed",
        summary: "evidence_integrity_fix_verified",
      },
      {
        id: "qf-2026-08-10-01",
        category: "permission_boundary",
        status: "verified_fixed",
        summary: "permission_boundary_fix_verified",
      },
    ],
  };
  log.entries.push(suspended, partiallyRestored);
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_quality_floor_fix_missing/u);
      assert.match(error.stderr, /qf-2026-08-10-02/u);
      return true;
    },
  );
});

test("a resolved Quality Floor regression ID can never be reused", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/maintainers/phase-0-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  const suspended = structuredClone(log.entries.at(-1));
  suspended.period = "2026-08-10-01";
  suspended.quality_floor = {
    status: "suspended",
    regressions: [{
      id: "qf-2026-08-10-01",
      category: "permission_boundary",
      status: "open",
      summary: "permission_boundary_regression_under_review",
    }],
  };
  suspended.validation_decision.status = "not_validated";
  suspended.p1_gate.authority_expanding_implementation = "blocked";
  const restored = structuredClone(log.entries.at(-1));
  restored.period = "2026-08-11-01";
  restored.quality_floor = {
    status: "satisfied",
    regressions: [{
      id: "qf-2026-08-10-01",
      category: "permission_boundary",
      status: "verified_fixed",
      summary: "permission_boundary_fix_verified",
    }],
  };
  const reused = structuredClone(suspended);
  reused.period = "2026-08-12-01";
  log.entries.push(suspended, restored, reused);
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_validation_entry_incomplete/u);
      assert.match(error.stderr, /reused regression qf-2026-08-10-01/u);
      return true;
    },
  );
});

test("Quality Floor regression summaries must match their category", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/maintainers/phase-0-validation-log.json");
  const contractPath = path.join(fixture, "release/p0.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const suspended = structuredClone(log.entries.at(-1));
  Object.assign(suspended, {
    period: "2026-08-10-01",
    quality_floor: {
      status: "suspended",
      regressions: [{
        id: "qf-2026-08-10-01",
        category: "evidence_integrity",
        status: "open",
        summary: "permission_boundary_regression_under_review",
      }],
    },
    validation_decision: {
      ...log.entries.at(-1).validation_decision,
      status: "not_validated",
      rationale: "quality_floor_regression_suspends_completion",
    },
    p1_gate: {
      discovery: "allowed",
      authority_expanding_implementation: "blocked",
    },
  });
  log.entries.push(suspended);
  Object.assign(contract, {
    product_status: "suspended",
    validation_status: "suspended",
    quality_floor_status: "suspended",
  });
  await Promise.all([
    writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`),
    writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`),
  ]);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_identifying_data_forbidden/u);
      assert.match(error.stderr, /quality_floor\.regressions\.0\.summary/u);
      return true;
    },
  );
});

test("Quality Floor regression summaries must match open and verified-fix status", async () => {
  const openFixture = await createP0Fixture();
  const openLogPath = path.join(openFixture, "docs/maintainers/phase-0-validation-log.json");
  const openContractPath = path.join(openFixture, "release/p0.json");
  const openLog = JSON.parse(await readFile(openLogPath, "utf8"));
  const openContract = JSON.parse(await readFile(openContractPath, "utf8"));
  const openSuspended = structuredClone(openLog.entries.at(-1));
  Object.assign(openSuspended, {
    period: "2026-08-10-01",
    quality_floor: {
      status: "suspended",
      regressions: [{
        id: "qf-2026-08-10-01",
        category: "permission_boundary",
        status: "open",
        summary: "permission_boundary_fix_verified",
      }],
    },
    validation_decision: {
      ...openLog.entries.at(-1).validation_decision,
      status: "not_validated",
      rationale: "quality_floor_regression_suspends_completion",
    },
    p1_gate: {
      discovery: "allowed",
      authority_expanding_implementation: "blocked",
    },
  });
  openLog.entries.push(openSuspended);
  Object.assign(openContract, {
    product_status: "suspended",
    validation_status: "suspended",
    quality_floor_status: "suspended",
  });
  await Promise.all([
    writeFile(openLogPath, `${JSON.stringify(openLog, null, 2)}\n`),
    writeFile(openContractPath, `${JSON.stringify(openContract, null, 2)}\n`),
  ]);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", openFixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_identifying_data_forbidden/u);
      assert.match(error.stderr, /quality_floor\.regressions\.0\.summary/u);
      return true;
    },
  );

  const fixedFixture = await createP0Fixture();
  const fixedLogPath = path.join(fixedFixture, "docs/maintainers/phase-0-validation-log.json");
  const fixedLog = JSON.parse(await readFile(fixedLogPath, "utf8"));
  const suspended = structuredClone(fixedLog.entries.at(-1));
  suspended.period = "2026-08-10-01";
  suspended.quality_floor = {
    status: "suspended",
    regressions: [{
      id: "qf-2026-08-10-01",
      category: "permission_boundary",
      status: "open",
      summary: "permission_boundary_regression_under_review",
    }],
  };
  suspended.validation_decision.status = "not_validated";
  suspended.p1_gate.authority_expanding_implementation = "blocked";
  const restored = structuredClone(fixedLog.entries.at(-1));
  restored.period = "2026-08-11-01";
  restored.quality_floor = {
    status: "satisfied",
    regressions: [{
      id: "qf-2026-08-10-01",
      category: "permission_boundary",
      status: "verified_fixed",
      summary: "permission_boundary_regression_under_review",
    }],
  };
  fixedLog.entries.push(suspended, restored);
  await writeFile(fixedLogPath, `${JSON.stringify(fixedLog, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", fixedFixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_identifying_data_forbidden/u);
      assert.match(error.stderr, /quality_floor\.regressions\.0\.summary/u);
      return true;
    },
  );
});

test("authority-expanding P1 implementation remains blocked before P0 Validated", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/maintainers/phase-0-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  Object.assign(log.entries.at(-1), {
    validation_decision: {
      ...log.entries.at(-1).validation_decision,
      status: "not_validated",
      rationale: "Directional field evidence is not established yet.",
    },
    p1_gate: {
      discovery: "allowed",
      authority_expanding_implementation: "allowed",
    },
  });
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_p1_authority_blocked/u);
      return true;
    },
  );
});

test("P0 Validated requires a documented qualitative decision basis", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/maintainers/phase-0-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  Object.assign(log.entries.at(-1), {
    validation_decision: {
      status: "validated",
      rationale: "",
      evidence_summary: {
        represented_contexts: "Broad contexts were reviewed.",
        repeated_patterns: "Repeated patterns were reviewed.",
        recurring_p1_needs: "Recurring P1 needs were reviewed.",
        resulting_decisions: "Resulting decisions were reviewed.",
      },
    },
    p1_gate: {
      discovery: "allowed",
      authority_expanding_implementation: "allowed",
    },
  });
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p0_validation_decision_incomplete/u);
      return true;
    },
  );
});

test("a complete qualitative decision can advance the P0 release contract", async () => {
  const fixture = await createP0Fixture();
  const logPath = path.join(fixture, "docs/maintainers/phase-0-validation-log.json");
  const contractPath = path.join(fixture, "release/p0.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  Object.assign(log.entries.at(-1), {
    validation_decision: {
      status: "validated",
      rationale: "consistent_directional_evidence",
      evidence_summary: {
        represented_contexts: "represented_contexts_established",
        repeated_patterns: "repeated_patterns_established",
        recurring_p1_needs: "recurring_p1_needs_reviewed",
        resulting_decisions: "explicit_p0_validation_decision",
      },
    },
    p1_gate: {
      discovery: "allowed",
      authority_expanding_implementation: "allowed",
    },
  });
  Object.assign(contract, {
    product_status: "complete",
    validation_status: "validated",
    p0_validated: true,
    quality_floor_status: "satisfied",
    p1_discovery: "allowed",
    p1_authority: "allowed",
  });
  await Promise.all([
    writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`),
    writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`),
  ]);
  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/validate-p0.mjs", "--root", fixture, "--json"],
    { cwd: root },
  );
  assert.equal(JSON.parse(stdout).p0_validated, true);
});
