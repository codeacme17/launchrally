import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createSecureServer } from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  VERIFY_INTERACTION_SCHEMA,
  assertValidReportPackage,
  assertValidVerificationResult,
} from "../packages/contracts/src/index.js";
import {
  evaluateReportCurrentness,
  resumeAuthenticatedJourneyFromHost,
  runAudit,
  runVerify,
} from "../packages/core/src/index.js";
import {
  createAuthenticatedJourneyAttestation,
  createAuthenticatedJourneyPlan,
} from "../packages/core/src/authenticated-journeys.js";
import { runHumanVerify } from "../packages/cli/bin/human-verify.js";
import { simulateExtendedMkdtempSuffix } from "./helpers/temporary-state-token.js";

const execFileAsync = promisify(execFile);
const cli = path.resolve("packages/cli/bin/engine.js");

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

function attestedJourneyResults(plan, results, collectedAt) {
  const supplied = {
    schema_version: "launchrally.dev/authenticated-journey-results/v1",
    adapter_version: "host-agent-authenticated-journey/v1",
    results,
  };
  supplied.attestation = createAuthenticatedJourneyAttestation(plan, supplied, {
    attestation_id: "verified_host_adapter_observation_01",
    issued_at: collectedAt,
  });
  return supplied;
}

const HOST_ATTESTATION_VERIFIER = {
  verify_host_attestation: () => true,
};

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
  assert.equal(result.status, "needs_permission", JSON.stringify(result));
  assert.equal(result.operation, "verify");
  assert.equal(VERIFY_INTERACTION_SCHEMA, "launchrally.dev/verify-interaction/v2");
  assert.deepEqual(result.interaction.source_report, {
    report_id: source.report.report_id,
    role: "manifest_source",
  });
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

test("full Verify requests protected journey reads independently from public verification", async () => {
  const directory = await fixture();
  const protectedJourney = {
    schema_version: "launchrally.dev/protected-journey/v1",
    method: "GET",
    path: "/control",
    purpose: "authenticated Core Journey",
    access: {
      authentication_class: "staff",
      anonymous_status_codes: [404],
      authenticated_status_codes: [200],
    },
  };
  const source = await completeAudit(
    directory,
    { ...ANSWERS, core_journeys: [protectedJourney] },
    {
      public_verification: "denied",
      authenticated_journey_verification: "denied",
    },
  );
  await writeManifest(directory, source);

  const result = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });

  assert.equal(result.status, "needs_permission", JSON.stringify(result));
  assert.deepEqual(
    result.request.permissions.map(({ permission_id, boundary }) => ({ permission_id, boundary })),
    [
      { permission_id: "public_verification", boundary: "public_network" },
      {
        permission_id: "authenticated_journey_verification",
        boundary: "authenticated_network_read",
      },
    ],
  );
  assert.deepEqual(
    result.request.permissions[1].scope,
    createAuthenticatedJourneyPlan({
      ...ANSWERS,
      core_journeys: [protectedJourney],
    }),
  );
});

test("Human full Verify denial completes with canonical gaps and immutable Report history", async () => {
  const directory = await fixture();
  const protectedJourney = {
    schema_version: "launchrally.dev/protected-journey/v1",
    method: "GET",
    path: "/control",
    purpose: "authenticated Core Journey",
    access: {
      authentication_class: "staff",
      anonymous_status_codes: [401, 403, 404],
      authenticated_status_codes: [200],
    },
  };
  const source = await completeAudit(
    directory,
    { ...ANSWERS, core_journeys: [protectedJourney] },
    {
      public_verification: "denied",
      authenticated_journey_verification: "denied",
    },
  );
  await writeManifest(directory, source);
  const promptedPermissionIds = [];

  const outcome = await runHumanVerify({
    cwd: directory,
    version: "0.4.0",
    reportPackage: source,
    scope: "full",
    prompt: {
      async start() {},
      async respondVerify(result) {
        promptedPermissionIds.push(
          ...result.request.permissions.map(({ permission_id: permissionId }) => permissionId),
        );
        return {
          permission_decisions: Object.fromEntries(
            result.request.permissions.map(({ permission_id: permissionId }) => [
              permissionId,
              "denied",
            ]),
          ),
        };
      },
      async close() {},
    },
    runVerify,
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.status, "completed");
  assert.deepEqual(promptedPermissionIds, [
    "public_verification",
    "authenticated_journey_verification",
  ]);
  assert.deepEqual(
    outcome.result.authorization_plan
      .filter(({ decision }) => decision === "denied")
      .map(({ permission_id: permissionId }) => permissionId),
    promptedPermissionIds,
  );
  assert.ok(outcome.result.report.results.verification_gaps.some(
    ({ reason_code: reasonCode }) => reasonCode === "permission_denied",
  ));
  const recordPath = path.join(
    directory,
    ".launchrally",
    "reports",
    outcome.result.report.report_id,
    "record.json",
  );
  const persisted = JSON.parse(await readFile(recordPath, "utf8"));
  assert.equal(persisted.report_id, outcome.result.report.report_id);
  assert.doesNotMatch(JSON.stringify(persisted), /resume_token/u);
});

test("full Verify requests typed authenticated results before executing approved reads", async () => {
  const directory = await fixture();
  const protectedJourney = {
    schema_version: "launchrally.dev/protected-journey/v1",
    method: "GET",
    path: "/control",
    purpose: "authenticated Core Journey",
    access: {
      authentication_class: "staff",
      anonymous_status_codes: [404],
      authenticated_status_codes: [200],
    },
  };
  const source = await completeAudit(
    directory,
    { ...ANSWERS, core_journeys: [protectedJourney] },
    {
      public_verification: "denied",
      authenticated_journey_verification: "denied",
    },
  );
  await writeManifest(directory, source);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  let publicCollections = 0;

  const result = await runVerify(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: {
      public_verification: "approved",
      authenticated_journey_verification: "approved",
    },
  }, {
    collect_public_evidence: async () => {
      publicCollections += 1;
      return [];
    },
  });

  assert.equal(result.status, "needs_input", JSON.stringify(result));
  assert.equal(result.request.type, "authenticated_journey_results");
  assert.equal(result.request.result_schema, "launchrally.dev/authenticated-journey-results/v1");
  assert.deepEqual(result.request.attestation, {
    schema_version: "launchrally.dev/authenticated-journey-attestation/v1",
    required_for_evidence: true,
    verification: "external_host_adapter",
  });
  assert.equal(result.request.plan.schema_version, "launchrally.dev/authenticated-journey-plan/v1");
  assert.deepEqual(result.request.allowed_outcomes, [
    "completed",
    "missing_authentication",
    "insufficient_capability",
    "expired_authentication",
    "runner_unavailable",
    "unexpected_denial",
    "redirect",
    "timeout",
    "execution_failure",
  ]);
  assert.equal(publicCollections, 0);
  assert.ok(result.interaction.resume_token.length > 20);
});

test("Verify forwards cooperative cancellation to approved public Evidence collection", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const controller = new AbortController();
  let observedSignal;

  const result = await runVerify(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "approved" },
  }, {
    signal: controller.signal,
    collect_public_evidence: async (plan, { signal } = {}) => {
      observedSignal = signal;
      return [];
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(observedSignal, controller.signal);
});

test("cancelling the authenticated Verify host request aborts the GET before history persistence", async () => {
  const server = createSecureServer({
    key: await readFile(path.resolve("test/fixtures/self-signed-key.pem")),
    cert: await readFile(path.resolve("test/fixtures/self-signed-cert.pem")),
  });
  let requestStartedResolve;
  const requestStarted = new Promise((resolve) => {
    requestStartedResolve = resolve;
  });
  server.on("request", () => {
    requestStartedResolve();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const target = `https://localhost:${server.address().port}`;
  const directory = await fixture();
  const authorizationFile = path.join(directory, "authorization");
  await writeFile(authorizationFile, "Bearer cancellation-test-secret", { mode: 0o600 });
  const previousEnvironment = {
    LAUNCHRALLY_AUTHENTICATED_ORIGIN: process.env.LAUNCHRALLY_AUTHENTICATED_ORIGIN,
    LAUNCHRALLY_HOST_AUTHORIZATION_FILE: process.env.LAUNCHRALLY_HOST_AUTHORIZATION_FILE,
    LAUNCHRALLY_HOST_CA_FILE: process.env.LAUNCHRALLY_HOST_CA_FILE,
  };
  process.env.LAUNCHRALLY_AUTHENTICATED_ORIGIN = target;
  process.env.LAUNCHRALLY_HOST_AUTHORIZATION_FILE = authorizationFile;
  process.env.LAUNCHRALLY_HOST_CA_FILE = path.resolve("test/fixtures/self-signed-cert.pem");

  try {
    const protectedJourney = {
      schema_version: "launchrally.dev/protected-journey/v1",
      method: "GET",
      path: "/control",
      purpose: "authenticated Core Journey",
      access: {
        authentication_class: "staff",
        anonymous_status_codes: [401, 403, 404],
        authenticated_status_codes: [200],
      },
    };
    const source = await completeAudit(
      directory,
      {
        ...ANSWERS,
        production_targets: [target],
        core_journeys: [protectedJourney],
      },
      {
        public_verification: "denied",
        authenticated_journey_verification: "denied",
      },
    );
    await writeManifest(directory, source);
    const permission = await runVerify(directory, "0.4.0", {
      report_package: source,
      scope: "full",
    });
    const input = await runVerify(directory, "0.4.0", {
      resume_token: permission.interaction.resume_token,
      permission_decisions: {
        public_verification: "denied",
        authenticated_journey_verification: "approved",
      },
    });
    const controller = new AbortController();
    const resumed = resumeAuthenticatedJourneyFromHost({
      host: "cli",
      cwd: directory,
      version: "0.4.0",
      operation: "verify",
      resume_token: input.interaction.resume_token,
      request: input.request,
      signal: controller.signal,
    });
    await requestStarted;
    controller.abort();

    await assert.rejects(resumed, (error) => error?.name === "AbortError");
    await assert.rejects(
      readdir(path.join(directory, ".launchrally", "reports")),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

test("full Verify cannot upgrade caller-attested authenticated success", async () => {
  const directory = await fixture();
  const protectedJourney = {
    schema_version: "launchrally.dev/protected-journey/v1",
    method: "GET",
    path: "/control",
    purpose: "authenticated Core Journey",
    access: {
      authentication_class: "staff",
      anonymous_status_codes: [404],
      authenticated_status_codes: [200],
    },
  };
  const source = await completeAudit(
    directory,
    { ...ANSWERS, core_journeys: [protectedJourney] },
    {
      public_verification: "denied",
      authenticated_journey_verification: "denied",
    },
  );
  await writeManifest(directory, source);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const input = await runVerify(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: {
      public_verification: "approved",
      authenticated_journey_verification: "approved",
    },
  });
  const collectedAt = new Date(Date.now() + 1).toISOString();
  const result = await runVerify(directory, "0.1.0", {
    resume_token: input.interaction.resume_token,
    journey_results: attestedJourneyResults(input.request.plan, [{
        journey_id: "target-1:journey-1:authenticated",
        status: "passed",
        outcome: "completed",
        status_code: 200,
        collected_at: collectedAt,
      }], collectedAt),
  }, {
    ...HOST_ATTESTATION_VERIFIER,
    collect_public_evidence: async () => [{
      kind: "public_observation",
      probe_id: "target-1:journey-1:anonymous",
      probe_kind: "journey",
      target: "https://example.com/control",
      host: "example.com",
      port: 443,
      path: "/control",
      method: "GET",
      purpose: "Verify anonymous boundary for protected Core Journey: authenticated Core Journey",
      verification_mode: "protected_anonymous_boundary",
      status: "passed",
      outcome: "access_boundary_confirmed",
      collected_at: collectedAt,
      duration_ms: 1,
      details: { status_code: 404 },
      provenance: {
        collector: "public-verification/v1",
        exact_target: "https://example.com/control",
        collected_at: collectedAt,
      },
    }],
  });

  assert.equal(result.status, "completed", JSON.stringify(result));
  const journeyCheck = result.report.results.checks.find(
    ({ check_id }) => check_id === "web.public.core-journeys",
  );
  assert.equal(journeyCheck.status, "unverified");
  const authenticated = result.evidence_index.entries.find(
    ({ evidence_kind }) => evidence_kind === "authenticated_journey_machine_evidence",
  );
  assert.equal(authenticated, undefined);
  assert.doesNotMatch(
    JSON.stringify(result),
    /session=|bearer\s|"cookie"|"headers"|"token"/iu,
  );
  assertValidReportPackage(result);
  assertValidVerificationResult(result);
});

test("full Verify cannot turn caller-attested failure into normative No-Go Evidence", async () => {
  const directory = await fixture();
  const protectedJourney = {
    schema_version: "launchrally.dev/protected-journey/v1",
    method: "GET",
    path: "/control",
    purpose: "authenticated Core Journey",
    access: {
      authentication_class: "staff",
      authenticated_status_codes: [200],
    },
  };
  const source = await completeAudit(
    directory,
    { ...ANSWERS, core_journeys: [protectedJourney] },
    {
      public_verification: "denied",
      authenticated_journey_verification: "denied",
    },
  );
  await writeManifest(directory, source);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const input = await runVerify(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: {
      public_verification: "denied",
      authenticated_journey_verification: "approved",
    },
  });
  const collectedAt = new Date(Date.now() + 1).toISOString();
  const result = await runVerify(directory, "0.1.0", {
    resume_token: input.interaction.resume_token,
    journey_results: attestedJourneyResults(input.request.plan, [{
        journey_id: "target-1:journey-1:authenticated",
        status: "failed",
        outcome: "unexpected_denial",
        status_code: 403,
        collected_at: collectedAt,
      }], collectedAt),
  }, HOST_ATTESTATION_VERIFIER);

  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.assessment, "inconclusive");
  const check = result.report.results.checks.find(
    ({ check_id }) => check_id === "web.public.core-journeys",
  );
  assert.equal(check.status, "unverified");
  const entry = result.evidence_index.entries.find(
    ({ evidence_kind }) => evidence_kind === "authenticated_journey_machine_evidence",
  );
  assert.equal(entry, undefined);
  assert.doesNotMatch(
    JSON.stringify(result),
    /session=|bearer\s|"cookie"|"headers"|"token"|response_body/iu,
  );
  assertValidReportPackage(result);
  assertValidVerificationResult(result);
});

test("Verify accepts a portable token when mkdtemp preserves its placeholder", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const portableToken = await simulateExtendedMkdtempSuffix(
    permission.interaction.resume_token,
    "verify",
  );

  const result = await runVerify(directory, "0.1.0", {
    resume_token: portableToken,
    permission_decisions: { public_verification: "denied" },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.operation, "verify");
});

test("Report currentness rejects not-applicable observability that contradicts aliased intent", async () => {
  const directory = await fixture();
  const source = structuredClone(await completeAudit(directory));
  source.report.scope.release_intent.support_layers = ["Sentry"];

  const result = evaluateReportCurrentness(source, {
    cwd: directory,
    now: () => new Date(source.report.created_at),
  });

  assert.ok(result.currentness.reasons.some((reason) =>
    reason.check_id === "web.baseline.observability"
      && reason.reason_code === "applicability_evidence_invalid",
  ));
});

test("Report currentness rejects observability passes backed only by declared intent", async () => {
  const directory = await fixture();
  const source = structuredClone(await completeAudit(directory, {
    ...ANSWERS,
    support_layers: ["Sentry"],
  }));
  const check = source.report.results.checks.find(
    (candidate) => candidate.check_id === "web.baseline.observability",
  );
  const declaration = source.report.catalog.checks.find(
    (candidate) => candidate.check_id === "web.baseline.observability",
  );
  declaration.pass_evidence_requirement = {
    accepted_kinds: ["release_intent"],
    minimum_items: 1,
    provenance_required: true,
  };
  check.status = "passed";
  check.evidence = structuredClone(check.applicability.evidence);

  const result = evaluateReportCurrentness(source, {
    cwd: directory,
    now: () => new Date(source.report.created_at),
  });

  assert.ok(result.currentness.reasons.some((reason) =>
    reason.check_id === "web.baseline.observability"
      && reason.reason_code === "insufficient_evidence",
  ));
});

test("Verify normalizes equivalent support-layer aliases without reporting Manifest drift", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory, {
    ...ANSWERS,
    support_layers: ["observability"],
  });
  const manifest = await writeManifest(directory, source);
  manifest.support.layers.value = ["monitoring"];
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

  assert.equal(
    result.manifest_drift.some(({ field }) => field === "support.layers"),
    false,
  );
  assert.deepEqual(
    result.report.scope.release_intent.support_layers,
    ["observability"],
  );
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
  assert.deepEqual(result.interaction.source_report, {
    report_id: source.report.report_id,
    role: "manifest_source",
  });
  assert.deepEqual(result.interaction.current_report, {
    report_id: result.report.report_id,
    role: "current",
  });
  assert.deepEqual(result.manifest_drift, []);
  assertValidReportPackage(result);
  assertValidVerificationResult(result);
  assert.deepEqual(source, sourceBefore);
  assert.equal(Object.isFrozen(result.report), true);
  assert.equal(Object.isFrozen(result.evidence_index), true);
});

test("completed full Verify atomically persists its new immutable Report history", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });

  const result = await runVerify(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });

  assert.equal(result.status, "completed");
  const reportDirectory = path.join(
    directory,
    ".launchrally",
    "reports",
    result.report.report_id,
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(reportDirectory, "record.json"), "utf8")),
    result.report,
  );
  assert.equal(await readFile(path.join(reportDirectory, "view.md"), "utf8"), result.report_view.content);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(reportDirectory, "evidence-index.json"), "utf8")),
    result.evidence_index,
  );
  assert.equal(
    (await readdir(path.join(directory, ".launchrally", "transactions"))).length,
    0,
  );
  assert.deepEqual(
    JSON.parse(await readFile(
      path.join(directory, ".launchrally", "cache", "current-report.json"),
      "utf8",
    )),
    {
      schema_version: "launchrally.dev/local-history-pointer/v1",
      report_id: result.report.report_id,
      record_digest: (await readFile(path.join(reportDirectory, "record.sha256"), "utf8")).trim(),
    },
  );
});

test("a partial Verify history write returns recoverable output without visible half-history", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });

  const result = await runVerify(
    directory,
    "0.1.0",
    {
      resume_token: permission.interaction.resume_token,
      permission_decisions: { public_verification: "denied" },
    },
    {
      history_file_operations: {
        write_file: async (target, content, options) => {
          if (target.endsWith(`${path.sep}view.md`)) {
            const error = new Error("simulated permission failure");
            error.code = "EACCES";
            throw error;
          }
          await writeFile(target, content, options);
        },
      },
    },
  );

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "EACCES");
  assert.equal(result.recoverable, true);
  assert.ok(result.generated_report_id);
  await assert.rejects(
    readFile(path.join(
      directory,
      ".launchrally",
      "reports",
      result.generated_report_id,
      "record.json",
    )),
    { code: "ENOENT" },
  );
  assert.deepEqual(await readdir(path.join(directory, ".launchrally", "transactions")), []);
  assert.deepEqual(
    await readdir(path.join(directory, ".launchrally", "evidence", "sha256")),
    [],
  );
});

test("a cache permission failure cannot turn committed Verify history into false failure", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });

  const result = await runVerify(
    directory,
    "0.1.0",
    {
      resume_token: permission.interaction.resume_token,
      permission_decisions: { public_verification: "denied" },
    },
    {
      history_file_operations: {
        mkdir: async (target, options) => {
          if (target.endsWith(`${path.sep}.launchrally${path.sep}cache`)) {
            const error = new Error("cache is read-only");
            error.code = "EACCES";
            throw error;
          }
          await mkdir(target, options);
        },
      },
    },
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(
    JSON.parse(await readFile(path.join(
      directory,
      ".launchrally",
      "reports",
      result.report.report_id,
      "record.json",
    ), "utf8")),
    result.report,
  );
  await assert.rejects(
    readFile(path.join(directory, ".launchrally", "cache", "current-report.json")),
    { code: "ENOENT" },
  );
});

test("a writer-lock release failure cannot create false failure or block recovery", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  let releaseFailed = false;
  const first = await runVerify(
    directory,
    "0.1.0",
    {
      resume_token: permission.interaction.resume_token,
      permission_decisions: { public_verification: "denied" },
    },
    {
      history_file_operations: {
        remove: async (target, options) => {
          if (!releaseFailed && target.endsWith(`${path.sep}history-writer.lock`)) {
            releaseFailed = true;
            const error = new Error("simulated lock release failure");
            error.code = "EACCES";
            throw error;
          }
          return rm(target, options);
        },
      },
    },
  );
  assert.equal(first.status, "completed");
  assert.equal(releaseFailed, true);
  const retryPermission = await runVerify(directory, "0.1.0", {
    report_package: first,
    scope: "full",
  });

  const retry = await runVerify(directory, "0.1.0", {
    resume_token: retryPermission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });

  assert.equal(retry.status, "completed");
});

test("Verify refuses a symlinked lock root before history acquisition", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const outside = await mkdtemp(path.join(os.tmpdir(), "launchrally-history-lock-outside-"));
  await symlink(outside, path.join(directory, ".launchrally", "locks"));
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });

  const result = await runVerify(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });

  assert.equal(result.error, "unsafe_history_path");
  assert.deepEqual(await readdir(outside), []);
});

test("Verify recovers a validated crashed transaction created under an earlier Report ID", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const transactions = path.join(directory, ".launchrally", "transactions");
  const crashedId = randomUUID();
  const crashed = path.join(transactions, `report-${crashedId}`);
  const orphanContent = "{\"kind\":\"release_intent\",\"field\":\"orphan\",\"value\":\"safe\"}";
  const orphanDigest = `sha256:${createHash("sha256").update(orphanContent).digest("hex")}`;
  const orphanRelativePath = `.launchrally/evidence/sha256/${orphanDigest.slice(7)}.json`;
  const orphanPath = path.join(directory, orphanRelativePath);
  await mkdir(path.dirname(orphanPath), { recursive: true });
  await mkdir(path.join(crashed, "bundle"), { recursive: true });
  const stagedOrphan = path.join(crashed, "evidence", `${orphanDigest.slice(7)}.json`);
  await mkdir(path.dirname(stagedOrphan), { recursive: true });
  await writeFile(stagedOrphan, orphanContent);
  await link(stagedOrphan, orphanPath);
  await writeFile(path.join(crashed, "transaction.json"), `${JSON.stringify({
    schema_version: "launchrally.dev/local-history-transaction/v1",
    transaction_id: crashedId,
    report_id: "crashed-old-report",
    record_digest: `sha256:${"1".repeat(64)}`,
    new_evidence: [{ path: orphanRelativePath, digest: orphanDigest }],
    state: "staging",
    owner_pid: 2_147_483_647,
  })}\n`);
  let nextId = 0;

  const result = await runVerify(
    directory,
    "0.1.0",
    {
      resume_token: permission.interaction.resume_token,
      permission_decisions: { public_verification: "denied" },
    },
    { id: () => ["recovery-report", "recovery-index"][nextId++] },
  );

  assert.equal(result.status, "completed");
  await assert.rejects(readFile(path.join(crashed, "transaction.json")), { code: "ENOENT" });
  await assert.rejects(readFile(orphanPath), { code: "ENOENT" });
});

test("Verify fails closed without passing a live transaction for another Report ID", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const transactionId = randomUUID();
  const transaction = path.join(
    directory,
    ".launchrally",
    "transactions",
    `report-${transactionId}`,
  );
  await mkdir(transaction, { recursive: true });
  await writeFile(path.join(transaction, "transaction.json"), `${JSON.stringify({
    schema_version: "launchrally.dev/local-history-transaction/v1",
    transaction_id: transactionId,
    report_id: "unrelated-live-report",
    record_digest: `sha256:${"2".repeat(64)}`,
    new_evidence: [],
    state: "staging",
    owner_pid: process.pid,
  })}\n`);

  const result = await runVerify(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });

  assert.equal(result.error, "history_transaction_busy");
  assert.equal(
    JSON.parse(await readFile(path.join(transaction, "transaction.json"), "utf8")).owner_pid,
    process.pid,
  );
});

test("Verify preserves transaction Evidence when visible final history is incomplete", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const transactionId = randomUUID();
  const reportId = "incomplete-visible-report";
  const transaction = path.join(
    directory,
    ".launchrally",
    "transactions",
    `report-${transactionId}`,
  );
  const content = "{\"kind\":\"release_intent\",\"field\":\"baseline\",\"value\":\"web-application-baseline/v1\"}";
  const evidenceDigest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const evidencePath = path.join(
    directory,
    ".launchrally",
    "evidence",
    "sha256",
    `${evidenceDigest.slice(7)}.json`,
  );
  const staged = path.join(transaction, "evidence", `${evidenceDigest.slice(7)}.json`);
  await mkdir(path.dirname(staged), { recursive: true });
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(staged, content);
  await link(staged, evidencePath);
  await writeFile(path.join(transaction, "transaction.json"), `${JSON.stringify({
    schema_version: "launchrally.dev/local-history-transaction/v1",
    transaction_id: transactionId,
    report_id: reportId,
    record_digest: `sha256:${"3".repeat(64)}`,
    new_evidence: [{
      path: `.launchrally/evidence/sha256/${evidenceDigest.slice(7)}.json`,
      digest: evidenceDigest,
    }],
    state: "staging",
    owner_pid: 2_147_483_647,
  })}\n`);
  const finalReport = path.join(directory, ".launchrally", "reports", reportId);
  await mkdir(finalReport, { recursive: true });
  await writeFile(path.join(finalReport, "record.json"), "{}\n");

  const result = await runVerify(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });

  assert.equal(result.error, "history_collision");
  assert.equal(await readFile(evidencePath, "utf8"), content);
  assert.equal(JSON.parse(await readFile(path.join(transaction, "transaction.json"), "utf8")).report_id, reportId);
});

test("Verify recovery refuses a symlinked historical Report directory before bundle reads", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const transactionId = randomUUID();
  const reportId = "symlinked-stale-report";
  const transaction = path.join(
    directory,
    ".launchrally",
    "transactions",
    `report-${transactionId}`,
  );
  await mkdir(transaction, { recursive: true });
  await writeFile(path.join(transaction, "transaction.json"), `${JSON.stringify({
    schema_version: "launchrally.dev/local-history-transaction/v1",
    transaction_id: transactionId,
    report_id: reportId,
    record_digest: `sha256:${"7".repeat(64)}`,
    new_evidence: [],
    state: "staging",
    owner_pid: 2_147_483_647,
  })}\n`);
  const outside = await mkdtemp(path.join(os.tmpdir(), "launchrally-report-symlink-outside-"));
  await writeFile(path.join(outside, "marker"), "outside\n");
  const reports = path.join(directory, ".launchrally", "reports");
  await mkdir(reports, { recursive: true });
  await symlink(outside, path.join(reports, reportId));

  const result = await runVerify(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });

  assert.equal(result.error, "unsafe_history_path");
  assert.equal(await readFile(path.join(outside, "marker"), "utf8"), "outside\n");
  assert.equal(
    JSON.parse(await readFile(path.join(transaction, "transaction.json"), "utf8")).report_id,
    reportId,
  );
});

test("Verify never deletes Evidence referenced by committed history from a forged stale journal", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const firstPermission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const first = await runVerify(directory, "0.1.0", {
    resume_token: firstPermission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });
  const entry = first.evidence_index.entries[0];
  const evidencePath = path.join(
    directory,
    ".launchrally",
    "evidence",
    "sha256",
    `${entry.digest.slice(7)}.json`,
  );
  const content = await readFile(evidencePath, "utf8");
  const transactionId = randomUUID();
  const transaction = path.join(
    directory,
    ".launchrally",
    "transactions",
    `report-${transactionId}`,
  );
  const staged = path.join(transaction, "evidence", `${entry.digest.slice(7)}.json`);
  await mkdir(path.dirname(staged), { recursive: true });
  await link(evidencePath, staged);
  await writeFile(path.join(transaction, "transaction.json"), `${JSON.stringify({
    schema_version: "launchrally.dev/local-history-transaction/v1",
    transaction_id: transactionId,
    report_id: "forged-stale-report",
    record_digest: `sha256:${"4".repeat(64)}`,
    new_evidence: [{
      path: `.launchrally/evidence/sha256/${entry.digest.slice(7)}.json`,
      digest: entry.digest,
    }],
    state: "staging",
    owner_pid: 2_147_483_647,
  })}\n`);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: first,
    scope: "full",
  });

  const result = await runVerify(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });

  assert.equal(result.error, "invalid_history_transaction");
  assert.equal(await readFile(evidencePath, "utf8"), content);
  assert.equal(JSON.parse(await readFile(path.join(transaction, "transaction.json"), "utf8")).report_id, "forged-stale-report");
});

test("Verify preserves Evidence when any visible Evidence Index is malformed during recovery", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const firstPermission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const first = await runVerify(directory, "0.1.0", {
    resume_token: firstPermission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });
  const entry = first.evidence_index.entries[0];
  const evidencePath = path.join(
    directory,
    ".launchrally",
    "evidence",
    "sha256",
    `${entry.digest.slice(7)}.json`,
  );
  const content = await readFile(evidencePath, "utf8");
  await writeFile(path.join(
    directory,
    ".launchrally",
    "reports",
    first.report.report_id,
    "evidence-index.json",
  ), "{malformed\n");
  const transactionId = randomUUID();
  const transaction = path.join(
    directory,
    ".launchrally",
    "transactions",
    `report-${transactionId}`,
  );
  const staged = path.join(transaction, "evidence", `${entry.digest.slice(7)}.json`);
  await mkdir(path.dirname(staged), { recursive: true });
  await link(evidencePath, staged);
  await writeFile(path.join(transaction, "transaction.json"), `${JSON.stringify({
    schema_version: "launchrally.dev/local-history-transaction/v1",
    transaction_id: transactionId,
    report_id: "malformed-index-recovery",
    record_digest: `sha256:${"5".repeat(64)}`,
    new_evidence: [{
      path: `.launchrally/evidence/sha256/${entry.digest.slice(7)}.json`,
      digest: entry.digest,
    }],
    state: "staging",
    owner_pid: 2_147_483_647,
  })}\n`);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: first,
    scope: "full",
  });

  const result = await runVerify(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });

  assert.equal(result.error, "history_collision");
  assert.equal(await readFile(evidencePath, "utf8"), content);
  assert.equal(JSON.parse(await readFile(path.join(transaction, "transaction.json"), "utf8")).report_id, "malformed-index-recovery");
});

test("Verify rejects a well-formed Evidence Index that omits canonical Record references before cleanup", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const firstPermission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const first = await runVerify(directory, "0.1.0", {
    resume_token: firstPermission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });
  const entry = first.evidence_index.entries[0];
  const evidencePath = path.join(
    directory,
    ".launchrally",
    "evidence",
    "sha256",
    `${entry.digest.slice(7)}.json`,
  );
  const content = await readFile(evidencePath, "utf8");
  await writeFile(path.join(
    directory,
    ".launchrally",
    "reports",
    first.report.report_id,
    "evidence-index.json",
  ), `${JSON.stringify({ ...first.evidence_index, entries: [] })}\n`);
  const transactionId = randomUUID();
  const transaction = path.join(
    directory,
    ".launchrally",
    "transactions",
    `report-${transactionId}`,
  );
  const staged = path.join(transaction, "evidence", `${entry.digest.slice(7)}.json`);
  await mkdir(path.dirname(staged), { recursive: true });
  await link(evidencePath, staged);
  await writeFile(path.join(transaction, "transaction.json"), `${JSON.stringify({
    schema_version: "launchrally.dev/local-history-transaction/v1",
    transaction_id: transactionId,
    report_id: "semantic-index-tamper-recovery",
    record_digest: `sha256:${"6".repeat(64)}`,
    new_evidence: [{
      path: `.launchrally/evidence/sha256/${entry.digest.slice(7)}.json`,
      digest: entry.digest,
    }],
    state: "staging",
    owner_pid: 2_147_483_647,
  })}\n`);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: first,
    scope: "full",
  });

  const result = await runVerify(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });

  assert.equal(result.error, "history_collision");
  assert.equal(await readFile(evidencePath, "utf8"), content);
  assert.equal(
    JSON.parse(await readFile(path.join(transaction, "transaction.json"), "utf8")).report_id,
    "semantic-index-tamper-recovery",
  );
});

test("Verify fails closed on a transaction prefix lookalike and preserves it", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const lookalike = path.join(
    directory,
    ".launchrally",
    "transactions",
    `report-${randomUUID()}-extra`,
  );
  await mkdir(lookalike, { recursive: true });
  await writeFile(path.join(lookalike, "transaction.json"), "{}\n");

  const result = await runVerify(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "invalid_history_transaction");
  assert.equal(await readFile(path.join(lookalike, "transaction.json"), "utf8"), "{}\n");
});

test("synchronized stale-lock contenders cannot remove a replacement history owner", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const permissions = await Promise.all([0, 1].map(() => runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  })));
  const token = randomUUID();
  const locks = path.join(directory, ".launchrally", "locks");
  const owners = path.join(locks, "owners");
  const staleOwner = path.join(owners, `history-writer-${token}.lock`);
  const canonical = path.join(locks, "history-writer.lock");
  const takeover = path.join(owners, `history-writer-${token}.takeover.lock`);
  await mkdir(owners, { recursive: true });
  await writeFile(staleOwner, `${JSON.stringify({
    schema_version: "launchrally.dev/owned-lock/v1",
    name: "history-writer",
    token,
    owner_pid: 2_147_483_647,
  })}\n`);
  await link(staleOwner, canonical);
  let claimants = 0;
  let releaseClaimants;
  const bothClaiming = new Promise((resolve) => { releaseClaimants = resolve; });
  const createLink = async (source, target) => {
    if (target === takeover) {
      claimants += 1;
      if (claimants === 2) releaseClaimants();
      await bothClaiming;
    }
    return link(source, target);
  };

  const results = await Promise.all(permissions.map((permission) => runVerify(
    directory,
    "0.1.0",
    {
      resume_token: permission.interaction.resume_token,
      permission_decisions: { public_verification: "denied" },
    },
    { history_file_operations: { link: createLink } },
  )));

  assert.ok(results.some(({ status }) => status === "completed"));
  assert.ok(results.every((result) =>
    result.status === "completed" || result.error === "history_writer_busy"),
  JSON.stringify(results.map((result) => ({
    status: result.status,
    error: result.error,
    message: result.message,
  }))));
  for (const result of results.filter(({ status }) => status === "completed")) {
    assert.deepEqual(
      JSON.parse(await readFile(path.join(
        directory,
        ".launchrally",
        "reports",
        result.report.report_id,
        "record.json",
      ), "utf8")),
      result.report,
    );
  }
});

test("Verify detects tampered digest-addressed Evidence and never overwrites it", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const first = await runVerify(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });
  const entry = first.evidence_index.entries.find(({ evidence_kind }) => evidence_kind === "file");
  const evidencePath = path.join(
    directory,
    ".launchrally",
    "evidence",
    "sha256",
    `${entry.digest.slice(7)}.json`,
  );
  const tampered = "{\"tampered\":true}\n";
  await writeFile(evidencePath, tampered);
  const secondPermission = await runVerify(directory, "0.1.0", {
    report_package: first,
    scope: "full",
  });

  const result = await runVerify(directory, "0.1.0", {
    resume_token: secondPermission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "history_collision");
  assert.equal(result.recoverable, true);
  assert.equal(await readFile(evidencePath, "utf8"), tampered);
});

test("Verify refuses a colliding Report ID without overwriting the existing Record", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const collisionDirectory = path.join(
    directory,
    ".launchrally",
    "reports",
    "collision-report",
  );
  await mkdir(collisionDirectory, { recursive: true });
  const collisionPath = path.join(collisionDirectory, "record.json");
  const existing = "{\"existing\":true}\n";
  await writeFile(collisionPath, existing);
  let nextId = 0;

  const result = await runVerify(
    directory,
    "0.1.0",
    {
      resume_token: permission.interaction.resume_token,
      permission_decisions: { public_verification: "denied" },
    },
    { id: () => ["collision-report", "collision-index"][nextId++] },
  );

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "history_collision");
  assert.equal(result.recoverable, true);
  assert.equal(await readFile(collisionPath, "utf8"), existing);
});

test("Verify treats an unexpected Report bundle child as a collision", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const firstPermission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const secondPermission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const createdAt = "2026-08-06T12:00:00.000Z";
  const dependencies = () => {
    let nextId = 0;
    return {
      now: () => new Date(createdAt),
      id: () => ["exact-child-report", "exact-child-index"][nextId++],
    };
  };
  const first = await runVerify(
    directory,
    "0.1.0",
    {
      resume_token: firstPermission.interaction.resume_token,
      permission_decisions: { public_verification: "denied" },
    },
    dependencies(),
  );
  assert.equal(first.status, "completed");
  const unexpected = path.join(
    directory,
    ".launchrally",
    "reports",
    first.report.report_id,
    "unexpected.json",
  );
  await writeFile(unexpected, "{}\n");

  const result = await runVerify(
    directory,
    "0.1.0",
    {
      resume_token: secondPermission.interaction.resume_token,
      permission_decisions: { public_verification: "denied" },
    },
    dependencies(),
  );

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "history_collision");
  assert.equal(await readFile(unexpected, "utf8"), "{}\n");
});

test("Verify reconciles a rename that commits successfully before returning EIO", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const permission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  let raced = false;

  const result = await runVerify(
    directory,
    "0.1.0",
    {
      resume_token: permission.interaction.resume_token,
      permission_decisions: { public_verification: "denied" },
    },
    {
      history_file_operations: {
        rename: async (sourcePath, targetPath) => {
          if (!raced && targetPath.includes(`${path.sep}.launchrally${path.sep}reports${path.sep}`)) {
            raced = true;
            await rename(sourcePath, targetPath);
            const error = new Error("rename reported an I/O error after commit");
            error.code = "EIO";
            throw error;
          }
          await rename(sourcePath, targetPath);
        },
      },
    },
  );

  assert.equal(raced, true);
  assert.equal(result.status, "completed");
  assert.deepEqual(
    JSON.parse(await readFile(path.join(
      directory,
      ".launchrally",
      "reports",
      result.report.report_id,
      "record.json",
    ), "utf8")),
    result.report,
  );
});

test("repeated full Verify retains every historical Report and Evidence object", async () => {
  const directory = await fixture();
  const source = await completeAudit(directory);
  await writeManifest(directory, source);
  const firstPermission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const first = await runVerify(directory, "0.1.0", {
    resume_token: firstPermission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });
  const secondPermission = await runVerify(directory, "0.1.0", {
    report_package: first,
    scope: "full",
  });
  const second = await runVerify(directory, "0.1.0", {
    resume_token: secondPermission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });

  assert.equal(second.status, "completed");
  const reports = await readdir(path.join(directory, ".launchrally", "reports"));
  assert.ok(reports.includes(first.report.report_id));
  assert.ok(reports.includes(second.report.report_id));
  const retainedEvidence = await readdir(
    path.join(directory, ".launchrally", "evidence", "sha256"),
  );
  const historicalDigests = new Set([
    ...first.evidence_index.entries.map(({ digest }) => digest.slice(7)),
    ...second.evidence_index.entries.map(({ digest }) => digest.slice(7)),
  ]);
  assert.ok([...historicalDigests].every((digest) => retainedEvidence.includes(`${digest}.json`)));
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

test("targeted Agent Verify remains resumable while non-TTY Human Verify exits with guidance", async () => {
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

  assert.equal(agent.status, "needs_permission");
  assert.deepEqual(agent.verification_scope.check_ids, ["web.public.availability"]);
  await assert.rejects(
    execFileAsync(process.execPath, [cli, ...commonArgs]),
    (error) => {
      assert.equal(error.code, 2);
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /Non-TTY Human Mode cannot prompt safely/u);
      assert.match(error.stderr, /rally verify --json/u);
      assert.match(error.stderr, /--scope targeted/u);
      assert.doesNotMatch(error.stderr, /resume token/iu);
      return true;
    },
  );

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
  const authorityBackslashResult = structuredClone(result);
  const authorityBackslashTarget = "https://example.com\\evil/control";
  authorityBackslashResult.targeted_result.evidence = [{
    kind: "authenticated_journey_observation",
    journey_id: "target-1:journey-1:authenticated",
    target: authorityBackslashTarget,
    method: "GET",
    purpose: "authenticated Core Journey",
    authentication_class: "user",
    status: "unverified",
    outcome: "runner_unavailable",
    status_code: null,
    collected_at: "2026-08-12T06:00:00.000Z",
    provenance: {
      collector: "host-agent-authenticated-journey/v1",
      exact_target: authorityBackslashTarget,
      collected_at: "2026-08-12T06:00:00.000Z",
    },
  }];

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
  assert.throws(
    () => assertValidVerificationResult(authorityBackslashResult),
    /incomplete or invalid/u,
  );

  const fullPermission = await runVerify(directory, "0.1.0", {
    report_package: source,
    scope: "full",
  });
  const fullResult = await runVerify(directory, "0.1.0", {
    resume_token: fullPermission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
  });
  const historicalV2 = structuredClone(fullResult);
  historicalV2.interaction.schema_version = "launchrally.dev/verify-interaction/v1";
  delete historicalV2.interaction.source_report;
  delete historicalV2.interaction.current_report;
  assert.equal(assertValidVerificationResult(historicalV2), true);

  const malformedCurrentIdentity = structuredClone(fullResult);
  malformedCurrentIdentity.interaction.current_report.report_id = "different-report";
  assert.throws(
    () => assertValidVerificationResult(malformedCurrentIdentity),
    /incomplete or invalid/u,
  );
});
