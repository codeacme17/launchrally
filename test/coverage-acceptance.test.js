import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "packages", "cli", "bin", "rally.js");
const coverageRoot = path.join(root, "fixtures", "coverage");
const fixture = path.join(coverageRoot, "python-fastapi");
const SECRET_SENTINEL = "coverage-secret-must-not-appear";

async function invokeWithEnvironment(env, ...args) {
  return JSON.parse((await execFileAsync(
    process.execPath,
    [cli, ...args],
    { cwd: root, ...(env ? { env } : {}) },
  )).stdout);
}

async function auditFixture(
  directory,
  {
    target = "https://python-api.example.com",
    providerRoles = [],
    env,
  } = {},
) {
  const execute = (...args) => invokeWithEnvironment(env, ...args);
  const input = await execute("audit", "--json", "--cwd", directory);
  const confirmation = await execute(
    "audit",
    "--json",
    "--cwd",
    directory,
    "--resume",
    input.interaction.resume_token,
    "--answers",
    JSON.stringify({
      intended_environment: "production",
      production_targets: [target],
      core_journeys: [{ method: "GET", path: "/", purpose: "API health" }],
      provider_roles: providerRoles,
      support_layers: [],
    }),
  );
  const permission = await execute(
    "audit",
    "--json",
    "--cwd",
    directory,
    "--resume",
    confirmation.interaction.resume_token,
    "--confirm",
    "confirm",
  );
  return execute(
    "audit",
    "--json",
    "--cwd",
    directory,
    "--resume",
    permission.interaction.resume_token,
    "--permissions",
    JSON.stringify({
      public_verification: "denied",
      ...Object.fromEntries(providerRoles.map(({ provider }) => [
        `provider_read:${provider}`,
        "approved",
      ])),
    }),
  );
}

function assertPassedEvidenceContracts(result, representativeId) {
  const declarations = new Map(
    result.report.catalog.checks.map((check) => [check.check_id, check]),
  );
  const evidenceByDigest = new Map(
    result.evidence_index.entries.map((entry) => [entry.digest, entry]),
  );

  for (const check of result.report.results.checks.filter(
    ({ status }) => status === "passed",
  )) {
    const requirement = declarations.get(check.check_id).pass_evidence_requirement;
    const qualifyingEvidence = check.evidence
      .map(({ digest }) => evidenceByDigest.get(digest))
      .filter((evidence) =>
        evidence
        && requirement.accepted_kinds.includes(evidence.evidence_kind)
        && (!requirement.provenance_required || Boolean(evidence.source))
        && evidence.current === true
        && evidence.currentness.status === "current",
      );
    assert.ok(
      qualifyingEvidence.length >= requirement.minimum_items,
      `${representativeId}:${check.check_id}`,
    );
  }
}

test("a Python server completes the Baseline with transparent coverage gaps", async () => {
  const result = await auditFixture(fixture);
  const checks = new Map(
    result.report.results.checks.map((check) => [check.check_id, check]),
  );
  const serialized = JSON.stringify(result);

  assert.equal(result.status, "completed");
  assert.equal(result.operation, "audit");
  assert.equal(result.snapshot.project.type, "unknown");
  assert.deepEqual(result.report.provenance.active_profile_versions, []);
  assert.deepEqual(result.report.provenance.active_adapter_versions, []);
  assert.equal(checks.get("web.baseline.package-manifest").status, "unverified");
  assert.equal(checks.get("web.baseline.lockfile").status, "unverified");
  assert.equal(checks.get("web.baseline.build-command").status, "unverified");
  assert.equal(result.report.assessment, "inconclusive");
  assert.doesNotMatch(serialized, /unsupported[_ ]project/iu);
  assert.doesNotMatch(serialized, new RegExp(SECRET_SENTINEL, "u"));
});

test("the acceptance matrix completes every representative without an ecosystem gate", async () => {
  const matrix = JSON.parse(await readFile(path.join(coverageRoot, "matrix.json"), "utf8"));
  const networkGuard = path.join(coverageRoot, "deny-network.cjs");
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${networkGuard}`.trim(),
  };

  assert.equal(matrix.schema_version, "launchrally.dev/coverage-acceptance-matrix/v1");
  assert.equal(matrix.fixtures_are_support_allowlist, false);
  assert.deepEqual(
    new Set(matrix.fixtures.map(({ ecosystem }) => ecosystem)),
    new Set([
      "typescript_meta_framework",
      "python_server_framework",
      "split_frontend_backend",
      "monorepo_multi_app",
      "custom_without_profile",
    ]),
  );
  assert.deepEqual(
    new Set(matrix.fixtures.map(({ deployment_shape }) => deployment_shape)),
    new Set(["hosted_web", "edge_serverless", "container_paas", "self_hosted_custom"]),
  );

  for (const representative of matrix.fixtures) {
    const result = await auditFixture(
      path.join(coverageRoot, representative.path),
      {
        target: representative.production_target,
        providerRoles: representative.provider_roles ?? [],
        env,
      },
    );
    const serialized = JSON.stringify(result);
    const gaps = result.report.results.verification_gaps;

    assert.equal(result.status, "completed", representative.id);
    assert.equal(result.operation, "audit", representative.id);
    assert.deepEqual(result.report.provenance.active_profile_versions, [], representative.id);
    assert.deepEqual(result.report.provenance.active_adapter_versions, [], representative.id);
    assert.equal(
      result.report.scope.public_verification.decision,
      "denied",
      representative.id,
    );
    assert.deepEqual(result.report.results.public_evidence_refs, [], representative.id);
    assert.equal(
      result.evidence_index.entries.some(
        ({ evidence_kind: evidenceKind }) => evidenceKind === "public_observation",
      ),
      false,
      representative.id,
    );
    assert.ok(gaps.length > 0, representative.id);
    assert.notEqual(result.report.assessment, "launch_ready", representative.id);
    assertPassedEvidenceContracts(result, representative.id);
    assert.doesNotMatch(serialized, /unsupported[_ ]project/iu, representative.id);
    assert.doesNotMatch(serialized, new RegExp(SECRET_SENTINEL, "u"), representative.id);
    if (representative.id === "custom-self-hosted") {
      const providerCheck = result.report.results.checks.find(
        ({ check_id: checkId }) => checkId === "provider.custom-deployer.metadata",
      );
      const providerGap = gaps.find(
        ({ check_id: checkId }) => checkId === "provider.custom-deployer.metadata",
      );
      assert.equal(providerCheck.status, "unverified");
      assert.equal(providerGap.reason_code, "unsupported_provider");
    }
  }
});

test("public quickstarts and defaults present the matrix as representatives, not gates", async () => {
  const [readme, guide, agentMetadata, codexManifest] = await Promise.all([
    readFile(path.join(root, "README.md"), "utf8"),
    readFile(path.join(root, "docs", "reference", "coverage-acceptance.md"), "utf8"),
    readFile(path.join(root, "skills", "launchrally", "agents", "openai.yaml"), "utf8"),
    readFile(
      path.join(root, "adapters", "codex", "launchrally", ".codex-plugin", "plugin.json"),
      "utf8",
    ),
  ]);

  assert.match(readme, /docs\/reference\/coverage-acceptance\.md/u);
  assert.match(guide, /representatives, not a support allowlist/iu);
  for (const fixturePath of [
    "typescript-astro",
    "python-fastapi",
    "split-react-go",
    "pnpm-edge-monorepo",
    "custom-self-hosted",
  ]) {
    assert.match(guide, new RegExp(fixturePath, "u"));
  }
  assert.match(guide, /no framework or deployment provider is an entry requirement/iu);
  assert.match(agentMetadata, /^  default_prompt:/mu);
  assert.match(agentMetadata, /JavaScript.*non-JavaScript.*split.*multi-app.*custom/iu);
  assert.match(codexManifest, /JavaScript.*non-JavaScript.*split.*multi-app.*custom/isu);
});
