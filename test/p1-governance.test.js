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
const currentVersion = JSON.parse(await readFile(
  path.join(root, "package.json"),
  "utf8",
)).version;

async function fixture() {
  return copyRepositoryFixture(root, "launchrally-p1-governance-", [
    ".github",
    "CHANGELOG.md",
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

async function validateP1(directory, extraArguments = []) {
  return execFileAsync(
    process.execPath,
    ["scripts/validate-p1.mjs", "--root", directory, ...extraArguments, "--json"],
    { cwd: root },
  );
}

async function registerRegression(directory, conditionId, regression) {
  const registryPath = path.join(directory, "release/p1-regression-registry.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  registry.assignments.push({
    regression_id: regression.regression_id,
    condition_id: conditionId,
    authority_scopes: regression.affected_authority_scopes,
  });
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

function pendingExternalRecord() {
  return {
    schema_version: "launchrally.dev/p1-external-verification/v1",
    status: "pending",
    version: currentVersion,
    tag: `v${currentVersion}`,
    channel: "experimental",
    verified_at: null,
    workflow_url: null,
    release_url: null,
    review_url: null,
    review_body: null,
    reviewer: null,
    release_actor: null,
    release_commit: null,
    reviewed_at: null,
    packages: [],
    publication_jobs: [],
    hosts: [],
    verification_digest: null,
  };
}

async function setDocumentedRequirementStatus(directory, requirementId, status) {
  const docsPath = path.join(directory, "docs/maintainers/p1-acceptance.md");
  const docs = await readFile(docsPath, "utf8");
  await writeFile(
    docsPath,
    docs.split("\n").map((line) => line.startsWith(`| ${requirementId} |`)
      ? line.replace(/\| (?:Complete|Open) \|$/u, `| ${status} |`)
      : line).join("\n"),
  );
}

test("the independent P1 governance contract maps every canonical requirement", async () => {
  const { stdout } = await validateP1(root);
  const result = JSON.parse(stdout);

  assert.equal(result.status, "completed");
  assert.equal(result.schema_version, "launchrally.dev/p1-release/v1");
  assert.equal(result.product_status, "complete");
  assert.equal(result.release_status, "experimental");
  assert.deepEqual(result.requirements, { complete: 38, open: 0, total: 38 });
  assert.deepEqual(result.suspended_authorities, []);
  assert.equal(result.p0_release_status, "stable");
});

test("P1 Experimental publication readiness permits only external verification to remain open", async () => {
  const directory = await fixture();
  const contractPath = path.join(directory, "release/p1.json");
  const matrixPath = path.join(directory, "release/p1-acceptance.json");
  const externalPath = path.join(directory, "release/p1-external-verification.json");
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  contract.product_status = "incomplete";
  contract.publication_status = "not_published";
  matrix.product_status = "incomplete";
  matrix.requirements.find(({ id }) => id === "P1-RELEASE-01").status = "open";
  matrix.release_gates.find(({ id }) => id === "p1_external_verification").status = "pending";
  await Promise.all([
    writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`),
    writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`),
    writeFile(externalPath, `${JSON.stringify(pendingExternalRecord(), null, 2)}\n`),
  ]);
  await setDocumentedRequirementStatus(directory, "P1-RELEASE-01", "Open");
  const { stdout } = await validateP1(directory, ["--require-publish-ready"]);
  const result = JSON.parse(stdout);

  assert.equal(result.publication_readiness, "ready");
  assert.deepEqual(result.publish_blockers, []);

  matrix.requirements.find(({ id }) => id === "P1-PRIVACY-01").status = "open";
  await writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);
  const docsPath = path.join(directory, "docs/maintainers/p1-acceptance.md");
  const changedDocs = await readFile(docsPath, "utf8");
  await writeFile(
    docsPath,
    changedDocs.replace(
      "| P1-PRIVACY-01 | Persisted Phase 1 records reject credentials, business payloads, raw Provider output, and personal data | focused negative fixtures reject sensitive persistence and receipt-as-Evidence | #134 | Complete |",
      "| P1-PRIVACY-01 | Persisted Phase 1 records reject credentials, business payloads, raw Provider output, and personal data | focused negative fixtures reject sensitive persistence and receipt-as-Evidence | #134 | Open |",
    ),
  );

  await assert.rejects(validateP1(directory, ["--require-publish-ready"]), (error) => {
    assert.match(error.stderr, /p1_publication_blocked/u);
    assert.match(error.stderr, /P1-PRIVACY-01/u);
    return true;
  });
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

test("P1 validation requires the exact unique mandatory release-gate roster", async () => {
  const directory = await fixture();
  const contractPath = path.join(directory, "release/p1.json");
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  contract.mandatory_release_gate_ids = [];
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

  await assert.rejects(validateP1(directory), (error) => {
    assert.match(error.stderr, /p1_invalid_canonical_gates/u);
    return true;
  });
});

test("a P1 regression suspends only its declared authority and never changes P0 Stable", async () => {
  const directory = await fixture();
  const contractPath = path.join(directory, "release/p1.json");
  const matrixPath = path.join(directory, "release/p1-acceptance.json");
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  const condition = matrix.quality_floor.find(({ id }) => id === "P1-QF-03");
  condition.status = "suspended";
  const regression = {
    regression_id: "P1-REG-0001",
    affected_authority_scopes: ["machine_evidence"],
    status: "open",
    reviewed_fix: null,
    restoration: null,
  };
  condition.regressions.push(regression);
  await registerRegression(directory, condition.id, regression);
  contract.quality_floor_status = "suspended";
  contract.product_status = "suspended";
  matrix.product_status = "suspended";
  await Promise.all([
    writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`),
    writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`),
  ]);

  const { stdout } = await validateP1(directory);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.suspended_authorities, ["machine_evidence"]);
  assert.equal(result.p0_release_status, "stable");
  assert.equal(result.quality_floor_status, "suspended");
});

test("a reviewed P1 fix remains suspended until a distinct restoration entry", async () => {
  const directory = await fixture();
  const contractPath = path.join(directory, "release/p1.json");
  const matrixPath = path.join(directory, "release/p1-acceptance.json");
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  const condition = matrix.quality_floor.find(({ id }) => id === "P1-QF-14");
  condition.status = "suspended";
  const regression = {
    regression_id: "P1-REG-0014",
    affected_authority_scopes: ["active_verification"],
    status: "fixed",
    reviewed_fix: "review:production-active-verification-boundary",
    restoration: null,
  };
  condition.regressions.push(regression);
  await registerRegression(directory, condition.id, regression);
  contract.quality_floor_status = "suspended";
  contract.product_status = "suspended";
  matrix.product_status = "suspended";
  await Promise.all([
    writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`),
    writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`),
  ]);

  const fixed = JSON.parse((await validateP1(directory)).stdout);
  assert.deepEqual(fixed.suspended_authorities, ["active_verification"]);

  condition.status = "satisfied";
  condition.regressions[0].status = "restored";
  condition.regressions[0].restoration = "review:quality-floor-restored";
  contract.quality_floor_status = "satisfied";
  contract.product_status = "complete";
  matrix.product_status = "complete";
  await Promise.all([
    writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`),
    writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`),
  ]);
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

test("P1 Stable requires every requirement and mandatory gate to be complete", async () => {
  const directory = await fixture();
  const contractPath = path.join(directory, "release/p1.json");
  const matrixPath = path.join(directory, "release/p1-acceptance.json");
  const externalPath = path.join(directory, "release/p1-external-verification.json");
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  Object.assign(contract, {
    product_status: "complete",
    release_status: "stable",
    publication_status: "published",
    validation_status: "validated",
    quality_floor_status: "satisfied",
    stable_promotion: { status: "approved", approved_tag: `v${currentVersion}` },
  });
  Object.assign(matrix, { product_status: "complete", release_status: "stable" });
  matrix.requirements.find(({ id }) => id === "P1-RELEASE-01").status = "open";
  matrix.release_gates.find(({ id }) => id === "p1_external_verification").status = "pending";
  await Promise.all([
    writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`),
    writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`),
    writeFile(externalPath, `${JSON.stringify(pendingExternalRecord(), null, 2)}\n`),
  ]);
  await setDocumentedRequirementStatus(directory, "P1-RELEASE-01", "Open");

  await assert.rejects(validateP1(directory), (error) => {
    assert.match(error.stderr, /p1_stable_promotion_blocked/u);
    assert.match(error.stderr, /P1-RELEASE-01/u);
    assert.doesNotMatch(error.stderr, /p1_exact_artifacts/u);
    assert.match(error.stderr, /p1_external_verification/u);
    return true;
  });
});

test("P1 Stable approval binds the exact package release tag", async () => {
  const directory = await fixture();
  const contractPath = path.join(directory, "release/p1.json");
  const matrixPath = path.join(directory, "release/p1-acceptance.json");
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  Object.assign(contract, {
    product_status: "complete",
    release_status: "stable",
    publication_status: "published",
    validation_status: "validated",
    quality_floor_status: "satisfied",
    stable_promotion: { status: "approved", approved_tag: "wrong-tag" },
  });
  Object.assign(matrix, { product_status: "complete", release_status: "stable" });
  await Promise.all([
    writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`),
    writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`),
  ]);

  await assert.rejects(validateP1(directory), (error) => {
    assert.match(error.stderr, /p1_stable_promotion_blocked/u);
    assert.match(error.stderr, /wrong-tag/u);
    assert.match(error.stderr, new RegExp(`v${currentVersion.replaceAll(".", "\\.")}`, "u"));
    return true;
  });
});

test("P1 Product Complete requires every requirement and mandatory gate to be complete", async () => {
  const directory = await fixture();
  const contractPath = path.join(directory, "release/p1.json");
  const matrixPath = path.join(directory, "release/p1-acceptance.json");
  const externalPath = path.join(directory, "release/p1-external-verification.json");
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  contract.product_status = "complete";
  contract.publication_status = "not_published";
  matrix.product_status = "complete";
  matrix.requirements.find(({ id }) => id === "P1-RELEASE-01").status = "open";
  matrix.release_gates.find(({ id }) => id === "p1_external_verification").status = "pending";
  await Promise.all([
    writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`),
    writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`),
    writeFile(externalPath, `${JSON.stringify(pendingExternalRecord(), null, 2)}\n`),
  ]);
  await setDocumentedRequirementStatus(directory, "P1-RELEASE-01", "Open");

  await assert.rejects(validateP1(directory), (error) => {
    assert.match(error.stderr, /p1_product_completion_blocked/u);
    assert.match(error.stderr, /publication_status=not_published/u);
    assert.match(error.stderr, /P1-RELEASE-01/u);
    assert.doesNotMatch(error.stderr, /p1_exact_artifacts/u);
    assert.match(error.stderr, /p1_external_verification/u);
    return true;
  });
});

test("P1 external verification cannot complete without its signed aggregate record", async () => {
  const directory = await fixture();
  const matrixPath = path.join(directory, "release/p1-acceptance.json");
  const externalPath = path.join(directory, "release/p1-external-verification.json");
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  matrix.release_gates.find(({ id }) => id === "p1_external_verification").status = "complete";
  await Promise.all([
    writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`),
    writeFile(externalPath, `${JSON.stringify(pendingExternalRecord(), null, 2)}\n`),
  ]);

  await assert.rejects(validateP1(directory), (error) => {
    assert.match(error.stderr, /p1_external_evidence_status_drift/u);
    return true;
  });
});

test("P1 validation rejects Quality Floor contract drift in either direction", async () => {
  const directory = await fixture();
  const contractPath = path.join(directory, "release/p1.json");
  const matrixPath = path.join(directory, "release/p1-acceptance.json");
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  const condition = matrix.quality_floor.find(({ id }) => id === "P1-QF-03");
  condition.status = "suspended";
  const regression = {
    regression_id: "P1-REG-0002",
    affected_authority_scopes: ["machine_evidence"],
    status: "open",
    reviewed_fix: null,
    restoration: null,
  };
  condition.regressions.push(regression);
  await registerRegression(directory, condition.id, regression);
  await writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);

  await assert.rejects(validateP1(directory), (error) => {
    assert.match(error.stderr, /p1_quality_floor_status_drift/u);
    return true;
  });

  contract.quality_floor_status = "suspended";
  condition.status = "satisfied";
  condition.regressions[0].status = "restored";
  condition.regressions[0].reviewed_fix = "review:machine-evidence-fix";
  condition.regressions[0].restoration = "review:machine-evidence-restored";
  await Promise.all([
    writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`),
    writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`),
  ]);

  await assert.rejects(validateP1(directory), (error) => {
    assert.match(error.stderr, /p1_quality_floor_status_drift/u);
    return true;
  });
});

test("P1 regression identifiers are globally unique across Quality Floor conditions", async () => {
  const directory = await fixture();
  const contractPath = path.join(directory, "release/p1.json");
  const matrixPath = path.join(directory, "release/p1-acceptance.json");
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  let registered = false;
  for (const id of ["P1-QF-03", "P1-QF-04"]) {
    const condition = matrix.quality_floor.find((candidate) => candidate.id === id);
    condition.status = "suspended";
    const regression = {
      regression_id: "P1-REG-0042",
      affected_authority_scopes: [condition.authority_scopes[0]],
      status: "open",
      reviewed_fix: null,
      restoration: null,
    };
    condition.regressions.push(regression);
    if (!registered) {
      await registerRegression(directory, condition.id, regression);
      registered = true;
    }
  }
  contract.quality_floor_status = "suspended";
  await Promise.all([
    writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`),
    writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`),
  ]);

  await assert.rejects(validateP1(directory), (error) => {
    assert.match(error.stderr, /p1_duplicate_regression: P1-REG-0042/u);
    return true;
  });
});

test("P1 restoration requires non-empty reviewed fix and restoration records", async () => {
  const directory = await fixture();
  const matrixPath = path.join(directory, "release/p1-acceptance.json");
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  const condition = matrix.quality_floor.find(({ id }) => id === "P1-QF-14");
  const regression = {
    regression_id: "P1-REG-0043",
    affected_authority_scopes: ["active_verification"],
    status: "restored",
    reviewed_fix: "",
    restoration: "",
  };
  condition.regressions.push(regression);
  await registerRegression(directory, condition.id, regression);
  await writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);

  await assert.rejects(validateP1(directory), (error) => {
    assert.match(error.stderr, /p1_invalid_regression: P1-REG-0043/u);
    return true;
  });
});

test("P1 regression assignments remain append-only against the reviewed Git baseline", async () => {
  const directory = await fixture();
  const matrixPath = path.join(directory, "release/p1-acceptance.json");
  const registryPath = path.join(directory, "release/p1-regression-registry.json");
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  const condition = matrix.quality_floor.find(({ id }) => id === "P1-QF-14");
  const regression = {
    regression_id: "P1-REG-0044",
    affected_authority_scopes: ["active_verification"],
    status: "restored",
    reviewed_fix: "review:active-verification-fix",
    restoration: "review:active-verification-restored",
  };
  condition.regressions.push(regression);
  await registerRegression(directory, condition.id, regression);
  await writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);
  await execFileAsync("git", ["init", "--quiet"], { cwd: directory });
  await execFileAsync("git", ["add", "release/p1-acceptance.json", registryPath], {
    cwd: directory,
  });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=LaunchRally Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "review P1 regression registry",
    ],
    { cwd: directory },
  );

  condition.regressions = [];
  const reusedCondition = matrix.quality_floor.find(({ id }) => id === "P1-QF-03");
  const reused = {
    ...regression,
    affected_authority_scopes: ["machine_evidence"],
  };
  reusedCondition.regressions.push(reused);
  await writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  registry.assignments = [{
    regression_id: reused.regression_id,
    condition_id: reusedCondition.id,
    authority_scopes: reused.affected_authority_scopes,
  }];
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

  await assert.rejects(validateP1(directory, ["--baseline-ref", "HEAD"]), (error) => {
    assert.match(error.stderr, /p1_regression_history_changed/u);
    return true;
  });
});

test("CI compares the P1 regression registry with every reviewed base", async () => {
  const workflow = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(
    workflow,
    /npm run validate:p1 -- --baseline-ref "origin\/\$GITHUB_BASE_REF"/u,
  );
  assert.match(
    workflow,
    /npm run validate:p1 -- --baseline-ref "\$\{\{ github\.event\.before \}\}"/u,
  );
});
