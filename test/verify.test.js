import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertValidReportPackage,
  assertValidVerificationResult,
} from "../packages/contracts/src/index.js";
import { runAudit, runVerify } from "../packages/core/src/index.js";

const execFileAsync = promisify(execFile);
const cli = path.resolve("packages/cli/bin/rally.js");

const ANSWERS = Object.freeze({
  intended_environment: "production",
  production_targets: ["https://example.com"],
  core_journeys: [{ method: "GET", path: "/", purpose: "homepage loads" }],
  provider_roles: [],
  support_layers: [],
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-verify-"));
  await writeFile(path.join(directory, "package.json"), `${JSON.stringify({
    name: "verify-web",
    scripts: { build: "node build.js" },
  }, null, 2)}\n`);
  await writeFile(path.join(directory, "package-lock.json"), `${JSON.stringify({
    name: "verify-web",
    lockfileVersion: 3,
  }, null, 2)}\n`);
  return directory;
}

async function completeAudit(
  directory,
  answers = ANSWERS,
  permissionDecisions = { public_verification: "denied" },
) {
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

function declared(value) {
  return { state: "declared", value: structuredClone(value) };
}

async function writeManifest(directory, source) {
  const intent = source.report.scope.release_intent;
  const manifest = {
    schema_version: "launchrally.dev/manifest/v2",
    project: {
      name: declared(source.report.scope.project.name),
      type: declared(source.report.scope.project.type),
      package_manager: declared(source.report.scope.project.package_manager),
    },
    release: {
      intended_environment: declared(intent.intended_environment),
      production_targets: declared(intent.production_targets),
      core_journeys: declared(intent.core_journeys),
    },
    execution: {
      source_report_id: declared(source.report.report_id),
      assessment: declared(source.report.assessment),
      public_verification: declared(source.report.scope.public_verification),
    },
    support: { layers: declared(intent.support_layers) },
    providers: { roles: declared(intent.provider_roles) },
  };
  await mkdir(path.join(directory, ".launchrally"));
  await writeFile(
    path.join(directory, ".launchrally", "manifest.yaml"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

test("full Verify discloses fresh Evidence permissions without mutating history or intent", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  const manifest = await writeManifest(directory, source);
  const sourceBefore = structuredClone(source);
  const manifestBefore = structuredClone(manifest);

  const result = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });

  assert.equal(result.contract, "launchrally.dev/cli/v2");
  assert.equal(result.status, "needs_permission");
  assert.equal(result.operation, "verify");
  assert.deepEqual(result.verification_scope, {
    mode: "full",
    whole_release: true,
    check_ids: source.report.execution.planned_checks.map(({ check_id }) => check_id),
  });
  assert.deepEqual(
    result.request.permissions.map(({ permission_id, decision }) => ({ permission_id, decision })),
    [{ permission_id: "public_verification", decision: "pending" }],
  );
  assert.ok(result.interaction.resume_token.length > 20);
  assert.equal(result.history.source_report_id, source.report.report_id);
  assert.equal(result.history.source_evidence_index_id, source.evidence_index.index_id);
  assert.deepEqual(source, sourceBefore);
  assert.deepEqual(manifest, manifestBefore);
});

test("full Verify accepts structurally valid non-current history so it can refresh it", async () => {
  const directory = await fixture();
  const source = structuredClone(await completeAudit(directory));
  source.report.policy.current = false;
  source.report.policy.currentness = {
    status: "non_current",
    evaluated_at: source.report.created_at,
    reasons: [{ reason_code: "content_changed", change: "package_manifest_changed" }],
  };
  source.report.assessment = null;
  delete source.report.verification_context;
  await writeManifest(directory, source);

  const result = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });

  assert.equal(result.status, "needs_permission");
  assert.equal(result.operation, "verify");
});

function successfulPublicEvidence(plan, collectedAt) {
  const outcomes = {
    dns: "resolved",
    tls: "secure",
    http: "reachable",
    health: "healthy",
    journey: "completed",
  };
  return plan.probes.map((probe) => ({
    kind: "public_observation",
    probe_id: probe.probe_id,
    probe_kind: probe.kind,
    target: probe.target,
    host: probe.host,
    port: probe.port,
    path: probe.path,
    method: probe.method,
    purpose: probe.purpose,
    ...(probe.verification_mode ? { verification_mode: probe.verification_mode } : {}),
    status: "passed",
    outcome: outcomes[probe.kind],
    collected_at: collectedAt,
    duration_ms: 1,
    details: {},
    provenance: {
      collector: "public-verification/v1",
      exact_target: probe.target,
      collected_at: collectedAt,
    },
  }));
}

test("full Verify recollects Evidence and creates a distinct immutable comparable Report", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const sourceBefore = structuredClone(source);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const collectedAt = "2026-08-06T12:00:00.000Z";
  let publicCollections = 0;
  let nextId = 0;

  const result = await runVerify(
    directory,
    "0.1.0",
    {
      resume_token: permission.interaction.resume_token,
      permission_decisions: { public_verification: "approved" },
    },
    {
      collect_public_evidence: async (plan) => {
        publicCollections += 1;
        return successfulPublicEvidence(plan, collectedAt);
      },
      now: () => new Date(collectedAt),
      id: () => `verify-id-${++nextId}`,
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.operation, "verify");
  assert.equal(result.schema_version, "launchrally.dev/verification-result/v2");
  assert.equal(result.verification_scope.whole_release, true);
  assert.equal(result.assessment_scope, "whole_release");
  assert.equal(result.assessment, result.report.assessment);
  assert.equal(publicCollections, 1);
  assert.notEqual(result.report.report_id, source.report.report_id);
  assert.notEqual(result.evidence_index.index_id, source.evidence_index.index_id);
  assert.equal(result.history.source_report_id, source.report.report_id);
  assert.equal(result.history.current_report_id, result.report.report_id);
  assert.equal(result.comparison.source_report_id, source.report.report_id);
  assert.equal(result.comparison.current_report_id, result.report.report_id);
  assert.deepEqual(result.manifest_drift, []);
  assertValidReportPackage(result);
  assertValidVerificationResult(result);
  assert.deepEqual(source, sourceBefore);
  assert.equal(Object.isFrozen(result.report), true);
  assert.equal(Object.isFrozen(result.evidence_index), true);
});

test("targeted Verify limits collection and cannot represent the whole release as ready", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const checkId = "web.public.availability";
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "targeted",
    check_ids: [checkId],
  });

  assert.deepEqual(permission.verification_scope, {
    mode: "targeted",
    whole_release: false,
    check_ids: [checkId],
  });
  assert.deepEqual(
    permission.request.permissions[0].scope.probes.map(({ kind }) => kind),
    ["dns", "http", "health"],
  );
  let collectedKinds;
  let nextId = 0;
  const collectedAt = "2026-08-06T12:00:00.000Z";
  const result = await runVerify(
    directory,
    "0.1.0",
    {
      resume_token: permission.interaction.resume_token,
      permission_decisions: { public_verification: "approved" },
    },
    {
      collect_public_evidence: async (plan) => {
        collectedKinds = plan.probes.map(({ kind }) => kind);
        return successfulPublicEvidence(plan, collectedAt);
      },
      now: () => new Date(collectedAt),
      id: () => `targeted-id-${++nextId}`,
    },
  );

  assert.deepEqual(collectedKinds, ["dns", "http", "health"]);
  assert.equal(result.status, "completed");
  assert.equal(result.assessment, null);
  assert.equal(result.assessment_scope, "targeted_only");
  assert.equal(result.verification_scope.whole_release, false);
  assert.equal(result.report, undefined);
  assert.deepEqual(result.targeted_result.checks.map(({ check_id }) => check_id), [checkId]);
  assert.equal(result.targeted_result.checks[0].status, "passed");
  assert.equal(result.history.source_report_id, source.report.report_id);
  assert.equal(result.history.current_result_id, result.targeted_result.result_id);
  assert.equal(Object.isFrozen(result.targeted_result), true);
  assertValidVerificationResult(result);
  assert.throws(() => assertValidReportPackage(result), /incomplete or invalid/u);
});

test("local targeted Verify completes at the granted local boundary with digest-bound Evidence", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);

  const result = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "targeted",
    check_ids: ["web.baseline.lockfile"],
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(
    result.authorization_plan.map(({ permission_id, decision }) => ({ permission_id, decision })),
    [{ permission_id: "local_safe_scan", decision: "granted" }],
  );
  const evidence = result.targeted_result.checks[0].evidence[0];
  assert.equal(evidence.kind, "file");
  assert.match(evidence.content_digest, /^sha256:[a-f0-9]{64}$/u);
});

test("targeted Manifest Drift makes the limited result non-current", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  const manifest = await writeManifest(directory, source);
  manifest.project.name.value = "different-project";
  await writeFile(
    path.join(directory, ".launchrally", "manifest.yaml"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const result = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "targeted",
    check_ids: ["web.baseline.lockfile"],
  });

  assert.equal(result.targeted_result.current, false);
  assert.deepEqual(result.targeted_result.currentness.reasons, [{
    reason_code: "manifest_drift",
    field: "project.name",
  }]);
});

test("content-bound Evidence is invalidated when a relevant lockfile digest changes", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const sourceLockfile = source.evidence_index.entries.find(
    ({ target }) => target === "repository:package-lock.json",
  );
  assert.match(sourceLockfile.normalized_artifact.content_digest, /^sha256:[a-f0-9]{64}$/u);
  await writeFile(path.join(directory, "package-lock.json"), `${JSON.stringify({
    name: "verify-web",
    lockfileVersion: 3,
    packages: { "": { version: "2.0.0" } },
  }, null, 2)}\n`);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });

  const result = await runVerify(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });

  const invalidation = result.comparison.invalidated_evidence.find(
    ({ target }) => target === "repository:package-lock.json",
  );
  assert.equal(invalidation.reason_code, "content_changed");
  assert.equal(invalidation.previous_digest, sourceLockfile.digest);
  assert.notEqual(invalidation.current_digest, sourceLockfile.digest);
  assert.equal(sourceLockfile.current, true);
});

test("legacy file Evidence without a content baseline is not falsely reported as changed", async () => {
  const directory = await fixture();
  const source = structuredClone(await completeAudit(directory));
  await writeManifest(directory, source);
  const legacyEntry = source.evidence_index.entries.find(
    ({ target }) => target === "repository:package-lock.json",
  );
  delete legacyEntry.normalized_artifact.content_digest;
  delete source.report.verification_context;

  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const result = await runVerify(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });
  const invalidation = result.comparison.invalidated_evidence.find(
    ({ target }) => target === "repository:package-lock.json",
  );

  assert.equal(invalidation.reason_code, "digest_baseline_unavailable");
  assert.equal(invalidation.previous_digest, legacyEntry.digest);
});

test("an unreferenced configuration digest change still invalidates the historical scope baseline", async () => {
  const directory = await fixture();
  await writeFile(path.join(directory, "vite.config.json"), '{"mode":"before"}\n');
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  await writeFile(path.join(directory, "vite.config.json"), '{"mode":"after"}\n');
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const result = await runVerify(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });

  const invalidation = result.comparison.invalidated_evidence.find(
    ({ target }) => target === "repository:vite.config.json",
  );
  assert.equal(invalidation.reason_code, "scope_digest_changed");
  assert.match(invalidation.previous_digest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(invalidation.current_digest, /^sha256:[a-f0-9]{64}$/u);
  assert.notEqual(invalidation.previous_digest, invalidation.current_digest);
});

test("a newly added configuration file appears in the digest comparison", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  await writeFile(path.join(directory, "vite.config.json"), '{"mode":"new"}\n');
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const result = await runVerify(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });

  const invalidation = result.comparison.invalidated_evidence.find(
    ({ target }) => target === "repository:vite.config.json",
  );
  assert.equal(invalidation.reason_code, "scope_digest_added");
  assert.equal(invalidation.previous_digest, null);
  assert.match(invalidation.current_digest, /^sha256:[a-f0-9]{64}$/u);
});

test("Manifest intent conflicts are explicit drift and prevent a current Launch Assessment", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  const manifest = await writeManifest(directory, source);
  manifest.release.production_targets.value = ["https://other.example.com/"];
  await writeFile(
    path.join(directory, ".launchrally", "manifest.yaml"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  assert.deepEqual(
    permission.request.permissions[0].scope.targets,
    ["https://other.example.com/"],
  );
  const result = await runVerify(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });

  assert.deepEqual(result.manifest_drift, [{
    field: "release.production_targets",
    manifest_value: ["https://other.example.com/"],
    observed_value: ["https://example.com/"],
    observed_source: "source_report",
  }]);
  assert.equal(result.assessment, null);
  assert.equal(result.report.assessment, null);
  assert.equal(result.report.policy.current, false);
  assert.deepEqual(result.report.policy.currentness.reasons, [{
    reason_code: "manifest_drift",
    field: "release.production_targets",
  }]);
});

test("not-applicable Manifest intent cannot silently remove historical scope or Checks", async () => {
  const directory = await fixture();
  const answers = {
    ...ANSWERS,
    provider_roles: [{ provider: "vercel", role: "deployment" }],
  };
  const source = await completeAudit(directory, answers, {
    public_verification: "denied",
    "provider_read:vercel": "denied",
  });
  const manifest = await writeManifest(directory, source);
  manifest.providers.roles = {
    state: "not_applicable",
    reason: "Provider was removed from current intent.",
    evidence: [{
      source_report_id: source.report.report_id,
      field: "scope.release_intent.provider_roles",
    }],
  };
  await writeFile(
    path.join(directory, ".launchrally", "manifest.yaml"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const result = await runVerify(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });

  assert.deepEqual(result.manifest_drift.find(({ field }) => field === "providers.roles"), {
    field: "providers.roles",
    manifest_value: [],
    observed_value: [{ provider: "vercel", role: "deployment" }],
    observed_source: "source_report",
  });
  assert.deepEqual(
    result.comparison.checks.find(({ check_id }) => check_id === "provider.vercel.metadata"),
    {
      check_id: "provider.vercel.metadata",
      before: "unverified",
      after: null,
      changed: true,
    },
  );
  assert.equal(result.report.assessment, null);
});

test("Verify fails closed when Manifest intent changes after the permission preview", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  const manifest = await writeManifest(directory, source);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  manifest.release.production_targets.value = ["https://changed.example.com/"];
  await writeFile(
    path.join(directory, ".launchrally", "manifest.yaml"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const result = await runVerify(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "approved" },
  });

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "verification_scope_stale");
});

test("Verify rejects a malformed supported-major Manifest before planning reads", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  const manifest = await writeManifest(directory, source);
  delete manifest.release.core_journeys;
  await writeFile(
    path.join(directory, ".launchrally", "manifest.yaml"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const result = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "invalid_manifest");
});

test("fresh collection cannot make stale live-state Evidence current or Ready", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const evaluatedAt = "2026-08-06T12:00:00.000Z";
  const staleAt = "2026-08-06T11:00:00.000Z";
  const result = await runVerify(
    directory,
    "0.1.0",
    {
      resume_token: permission.interaction.resume_token,
      permission_decisions: { public_verification: "approved" },
    },
    {
      collect_public_evidence: async (plan) => successfulPublicEvidence(plan, staleAt),
      now: () => new Date(evaluatedAt),
    },
  );

  assert.equal(result.report.policy.current, false);
  assert.equal(result.report.assessment, null);
  assert.equal(result.assessment, null);
  assert.equal(
    result.report.policy.currentness.reasons.some(
      ({ reason_code }) => reason_code === "live_evidence_stale",
    ),
    true,
  );
});

test("Agent and Human CLI modes expose the same targeted Verify scope and permission boundary", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const reportPath = path.join(directory, "source-audit.json");
  await writeFile(reportPath, JSON.stringify(source));
  const commonArgs = [
    "verify",
    "--cwd",
    directory,
    "--report",
    reportPath,
    "--scope",
    "targeted",
    "--checks",
    '["web.public.availability"]',
  ];

  const agent = JSON.parse((await execFileAsync(
    process.execPath,
    [cli, ...commonArgs, "--json"],
  )).stdout);
  const human = (await execFileAsync(process.execPath, [cli, ...commonArgs])).stdout;

  assert.equal(agent.status, "needs_permission");
  assert.deepEqual(agent.verification_scope.check_ids, ["web.public.availability"]);
  assert.match(human, /^LaunchRally Targeted Verification/mu);
  assert.match(human, /Whole release: NO/u);
  assert.match(human, /web\.public\.availability/u);
  assert.match(human, /Public verification: https:\/\/example\.com\//u);

  const completed = JSON.parse((await execFileAsync(process.execPath, [
    cli,
    "verify",
    "--json",
    "--cwd",
    directory,
    "--resume",
    agent.interaction.resume_token,
    "--permissions",
    '{"public_verification":"denied"}',
  ])).stdout);
  assert.equal(completed.status, "completed");
  assert.equal(completed.assessment_scope, "targeted_only");
  assert.equal(completed.assessment, null);
});

test("Verification Result validation rejects malformed history and drift structures", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const result = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "targeted",
    check_ids: ["web.baseline.lockfile"],
  });
  const malformedHistory = structuredClone(result);
  malformedHistory.comparison.source_report_id = "different-report";
  const malformedDrift = structuredClone(result);
  malformedDrift.manifest_drift = [{ field: "project.name" }];
  const malformedEvidence = structuredClone(result);
  malformedEvidence.targeted_result.evidence = [{ kind: "public_observation" }];

  assert.throws(
    () => assertValidVerificationResult(malformedHistory),
    /incomplete or invalid/u,
  );
  assert.throws(
    () => assertValidVerificationResult(malformedDrift),
    /incomplete or invalid/u,
  );
  assert.throws(
    () => assertValidVerificationResult(malformedEvidence),
    /incomplete or invalid/u,
  );
});
