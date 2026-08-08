import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { createPlainPromptAdapter } from "../packages/cli/bin/prompt-adapters.js";
import { createPublicVerificationPlan } from "../packages/core/src/public-verification.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "packages", "cli", "bin", "rally.js");

async function createInteractionFixture({ providerSignals = true } = {}) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "launchrally-interaction-"));
  await writeFile(
    path.join(fixture, "package.json"),
    JSON.stringify({ name: "interaction-web", scripts: { build: "vite build" } }),
  );
  await writeFile(path.join(fixture, "package-lock.json"), '{"lockfileVersion":3}');
  if (providerSignals) {
    await writeFile(
      path.join(fixture, ".env"),
      "VERCEL_ORG_ID=private-value\nSENTRY_DSN=private-value\n",
    );
  }
  return fixture;
}

async function runAudit(fixture, options = []) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [cli, "audit", "--json", "--cwd", fixture, ...options],
    { cwd: root, env: { ...process.env, PATH: "" } },
  );
  return JSON.parse(stdout);
}

function publicEvidence(result) {
  return result.evidence_index.entries
    .filter((entry) => entry.evidence_kind === "public_observation")
    .map((entry) => entry.normalized_artifact);
}

const CONFIRMED_ANSWERS = Object.freeze({
  intended_environment: "production",
  production_targets: ["https://example.com"],
  core_journeys: ["visitor can sign up", "customer can check out"],
  provider_roles: [
    { provider: "sentry", role: "observability" },
    { provider: "vercel", role: "deployment" },
  ],
  support_layers: ["monitoring"],
});

async function reachConfirmation(fixture) {
  const initial = await runAudit(fixture);
  return runAudit(fixture, [
    "--resume",
    initial.interaction.resume_token,
    "--answers",
    JSON.stringify(CONFIRMED_ANSWERS),
  ]);
}

async function reachPermission(fixture) {
  const confirmation = await reachConfirmation(fixture);
  return runAudit(fixture, [
    "--resume",
    confirmation.interaction.resume_token,
    "--confirm",
    "confirm",
  ]);
}

async function completeAudit(fixture, answers, publicDecision = "approved") {
  const initial = await runAudit(fixture);
  const confirmation = await runAudit(fixture, [
    "--resume",
    initial.interaction.resume_token,
    "--answers",
    JSON.stringify(answers),
  ]);
  const permission = await runAudit(fixture, [
    "--resume",
    confirmation.interaction.resume_token,
    "--confirm",
    "confirm",
  ]);
  return runAudit(fixture, [
    "--resume",
    permission.interaction.resume_token,
    "--permissions",
    JSON.stringify({ public_verification: publicDecision }),
  ]);
}

test("Agent Mode asks only for unknown release intent in a versioned state", async () => {
  const fixture = await createInteractionFixture();
  const result = await runAudit(fixture);

  assert.equal(result.contract, "launchrally.dev/cli/v2");
  assert.equal(result.status, "needs_input");
  assert.equal(result.operation, "audit");
  assert.equal(result.interaction.schema_version, "launchrally.dev/audit-interaction/v1");
  assert.equal(result.audit_brief.schema_version, "launchrally.dev/audit-brief/v1");
  assert.deepEqual(result.audit_brief.project, {
    name: "interaction-web",
    type: "web",
    package_manager: "npm",
    source: "discovered",
    confirmed: true,
  });
  assert.deepEqual(
    result.request.fields.map((field) => field.field_id),
    [
      "intended_environment",
      "production_targets",
      "core_journeys",
      "provider_roles",
      "support_layers",
    ],
  );
  assert.equal(
    result.request.fields.find((field) => field.field_id === "production_targets").prompt,
    "Which confirmed public target URLs are in scope?",
  );
  for (const field of result.request.fields) {
    assert.deepEqual(Object.keys(field), [
      "field_id",
      "value_type",
      "prompt",
      "candidates",
      "current_value",
    ]);
  }
  assert.deepEqual(result.audit_brief.provider_roles.candidates, [
    { provider: "sentry", role: "observability" },
    { provider: "vercel", role: "deployment" },
  ]);
  assert.deepEqual(result.audit_brief.support_layers.candidates, ["observability"]);
  assert.ok(result.interaction.resume_token.length > 20);
  assert.doesNotMatch(JSON.stringify(result), /private-value/);
});

test("Core offers only safely detected static routes as Journey candidates", async () => {
  const fixture = await createInteractionFixture();
  for (const relativePath of [
    "app/page.tsx",
    "app/dashboard/page.tsx",
    "app/feed/(.)photo/page.tsx",
    "app/users/[id]/page.tsx",
    "src/routes/pricing/+page.svelte",
    "app/routes/docs._index.tsx",
  ]) {
    const absolutePath = path.join(fixture, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, "export default function Page() {}\n");
  }

  const result = await runAudit(fixture);
  const field = result.request.fields.find(({ field_id }) => field_id === "core_journeys");
  assert.deepEqual(field.candidates, [
    "GET / — homepage loads",
    "GET /dashboard — dashboard page loads",
    "GET /docs — docs page loads",
    "GET /pricing — pricing page loads",
  ]);
  assert.doesNotMatch(JSON.stringify(field.candidates), /\[id\]/u);
  assert.doesNotMatch(JSON.stringify(field.candidates), /\(\.\)photo/u);
});

test("Agent Mode previews the complete unconfirmed plan before permission", async () => {
  const fixture = await createInteractionFixture();
  const result = await reachConfirmation(fixture);

  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.audit_brief.intended_environment.value, "production");
  assert.equal(result.audit_brief.intended_environment.confirmed, false);
  assert.deepEqual(result.audit_brief.production_targets.values, ["https://example.com/"]);
  assert.deepEqual(
    result.audit_brief.planned_checks.map((check) => check.check_id),
    [
      "web.baseline.package-manifest",
      "web.baseline.lockfile",
      "web.baseline.runtime-inputs",
      "web.baseline.build-command",
      "web.public.availability",
      "web.public.transport-security",
      "web.baseline.data-state",
      "web.baseline.observability",
      "web.public.core-journeys",
      "provider.sentry.metadata",
      "provider.vercel.metadata",
    ],
  );
  assert.deepEqual(
    result.authorization_plan.map(({ permission_id, decision }) => ({ permission_id, decision })),
    [
      { permission_id: "local_safe_scan", decision: "granted" },
      { permission_id: "public_verification", decision: "pending" },
      { permission_id: "provider_read:sentry", decision: "pending" },
      { permission_id: "provider_read:vercel", decision: "pending" },
    ],
  );
  assert.deepEqual(result.request, {
    type: "confirmation",
    confirmation_id: "audit_scope",
    prompt: "Confirm this Audit Brief and complete Check plan before permissions are requested.",
    choices: ["confirm", "revise", "cancel"],
  });
});

test("an explicit empty Journey scope can proceed to confirmation", async () => {
  const fixture = await createInteractionFixture();
  const initial = await runAudit(fixture);
  const result = await runAudit(fixture, [
    "--resume",
    initial.interaction.resume_token,
    "--answers",
    JSON.stringify({ ...CONFIRMED_ANSWERS, core_journeys: [] }),
  ]);

  assert.equal(result.status, "needs_confirmation");
  assert.deepEqual(result.audit_brief.core_journeys.values, []);
  assert.equal(result.audit_brief.core_journeys.confirmed, false);
});

test("Agent Mode normalizes declared observability aliases before confirmation", async () => {
  const fixture = await createInteractionFixture();
  const initial = await runAudit(fixture);
  const result = await runAudit(fixture, [
    "--resume",
    initial.interaction.resume_token,
    "--answers",
    JSON.stringify({
      ...CONFIRMED_ANSWERS,
      provider_roles: [],
      support_layers: ["  Sentry   observability  ", "Sentry", "monitoring", "observability"],
    }),
  ]);

  assert.equal(result.status, "needs_confirmation");
  assert.deepEqual(result.audit_brief.support_layers.values, ["observability"]);
});

test("Agent Mode rejects unknown support layers with revision guidance", async () => {
  const fixture = await createInteractionFixture();
  const initial = await runAudit(fixture);
  const result = await runAudit(fixture, [
    "--resume",
    initial.interaction.resume_token,
    "--answers",
    JSON.stringify({
      ...CONFIRMED_ANSWERS,
      support_layers: ["unknown incident service"],
    }),
  ]);

  assert.equal(result.status, "needs_input");
  assert.deepEqual(result.request.validation_errors, [
    {
      field_id: "support_layers",
      code: "unsupported_support_layer",
      supported_categories: ["analytics", "observability"],
      guidance: "Choose a supported category or revise the support-layer selection.",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /unknown incident service/u);
});

test("Agent Mode classifies known support provider names", async () => {
  const fixture = await createInteractionFixture();
  const initial = await runAudit(fixture);
  const result = await runAudit(fixture, [
    "--resume",
    initial.interaction.resume_token,
    "--answers",
    JSON.stringify({
      ...CONFIRMED_ANSWERS,
      provider_roles: [],
      support_layers: ["PostHog", "PostHog analytics"],
    }),
  ]);

  assert.equal(result.status, "needs_confirmation");
  assert.deepEqual(result.audit_brief.support_layers.values, ["analytics"]);
});

test("declared observability intent is applicable but unverified without qualifying evidence", async () => {
  const fixture = await createInteractionFixture({ providerSignals: false });
  const result = await completeAudit(
    fixture,
    {
      ...CONFIRMED_ANSWERS,
      provider_roles: [],
      support_layers: ["Sentry observability"],
    },
    "denied",
  );

  const check = result.report.results.checks.find(
    (candidate) => candidate.check_id === "web.baseline.observability",
  );
  assert.equal(check.applicability.status, "applicable");
  assert.equal(check.status, "unverified");
});

test("Agent Mode requires an explicit Journey array even though an empty array means Skip", async () => {
  const fixture = await createInteractionFixture();
  const initial = await runAudit(fixture);
  const { core_journeys: _journeys, ...answersWithoutJourneys } = CONFIRMED_ANSWERS;
  const result = await runAudit(fixture, [
    "--resume",
    initial.interaction.resume_token,
    "--answers",
    JSON.stringify(answersWithoutJourneys),
  ]);

  assert.equal(result.status, "needs_input");
  assert.deepEqual(result.request.validation_errors, [
    { field_id: "core_journeys", code: "required" },
  ]);
});

test("skipping public Journeys completes with an unresolved Verification Gap", async () => {
  const fixture = await createInteractionFixture();
  const result = await completeAudit(
    fixture,
    {
      ...CONFIRMED_ANSWERS,
      core_journeys: [],
      provider_roles: [],
      support_layers: [],
    },
    "denied",
  );

  assert.equal(result.status, "completed");
  const journeyCheck = result.report.results.checks.find(
    (check) => check.check_id === "web.public.core-journeys",
  );
  assert.equal(journeyCheck.status, "unverified");
  assert.match(journeyCheck.summary, /Confirmed core journeys are required/u);
  assert.ok(result.report.results.verification_gaps.some((gap) =>
    gap.check_id === "web.public.core-journeys"
      && gap.reason_code === "applicability_unresolved",
  ));
});

test("Agent Mode discloses every read-only public probe before approval", async () => {
  const fixture = await createInteractionFixture();
  const result = await reachConfirmation(fixture);

  assert.deepEqual(result.audit_brief.public_verification, {
    collector_version: "public-verification/v1",
    targets: ["https://example.com/"],
    probes: [
      {
        probe_id: "target-1:dns",
        kind: "dns",
        target: "https://example.com/",
        host: "example.com",
        port: 443,
        path: "/",
        method: "DNS_LOOKUP",
        purpose: "Resolve the production target host.",
        timeout_ms: 5000,
      },
      {
        probe_id: "target-1:tls",
        kind: "tls",
        target: "https://example.com/",
        host: "example.com",
        port: 443,
        path: "/",
        method: "TLS_HANDSHAKE",
        purpose: "Verify the production target certificate and TLS handshake.",
        timeout_ms: 5000,
      },
      {
        probe_id: "target-1:http",
        kind: "http",
        target: "https://example.com/",
        host: "example.com",
        port: 443,
        path: "/",
        method: "GET",
        purpose: "Verify HTTP reachability without following redirects.",
        timeout_ms: 5000,
      },
      {
        probe_id: "target-1:health",
        kind: "health",
        target: "https://example.com/health",
        host: "example.com",
        port: 443,
        path: "/health",
        method: "GET",
        purpose: "Verify the conventional public health endpoint.",
        timeout_ms: 5000,
      },
      {
        probe_id: "target-1:journey-1",
        kind: "journey",
        target: "https://example.com/",
        host: "example.com",
        port: 443,
        path: "/",
        method: "GET",
        purpose: "Verify declared core journey: customer can check out",
        timeout_ms: 5000,
        verification_mode: "description_only",
      },
      {
        probe_id: "target-1:journey-2",
        kind: "journey",
        target: "https://example.com/",
        host: "example.com",
        port: 443,
        path: "/",
        method: "GET",
        purpose: "Verify declared core journey: visitor can sign up",
        timeout_ms: 5000,
        verification_mode: "description_only",
      },
    ],
  });
  const publicPermissions = result.authorization_plan.filter(
    (permission) => permission.permission_id === "public_verification",
  );
  assert.equal(publicPermissions.length, 1);
  assert.deepEqual(publicPermissions[0].scope, {
    targets: result.audit_brief.public_verification.targets,
    probes: result.audit_brief.public_verification.probes,
  });
});

test("Agent Mode probe purposes use the confirmed intended environment", async () => {
  const fixture = await createInteractionFixture();
  const initial = await runAudit(fixture);
  const result = await runAudit(fixture, [
    "--resume",
    initial.interaction.resume_token,
    "--answers",
    JSON.stringify({ ...CONFIRMED_ANSWERS, intended_environment: "staging" }),
  ]);

  assert.equal(result.status, "needs_confirmation");
  assert.equal(
    result.audit_brief.public_verification.probes.find((probe) => probe.kind === "dns").purpose,
    "Resolve the staging target host.",
  );
  assert.equal(
    result.audit_brief.public_verification.probes.find((probe) => probe.kind === "tls").purpose,
    "Verify the staging target certificate and TLS handshake.",
  );
  assert.doesNotMatch(
    JSON.stringify(result.audit_brief.public_verification.probes),
    /production target|production host/u,
  );
});

test("public probe purposes support custom and unknown environment labels", () => {
  const answers = {
    production_targets: ["https://example.com/"],
    core_journeys: [],
  };
  const custom = createPublicVerificationPlan({
    ...answers,
    intended_environment: "QA East",
  });
  assert.equal(
    custom.probes.find((probe) => probe.kind === "tls").purpose,
    "Verify the QA East target certificate and TLS handshake.",
  );

  const unknown = createPublicVerificationPlan(answers);
  assert.equal(
    unknown.probes.find((probe) => probe.kind === "dns").purpose,
    "Resolve the confirmed target host.",
  );
  assert.equal(
    unknown.probes.find((probe) => probe.kind === "tls").purpose,
    "Verify the confirmed target certificate and TLS handshake.",
  );
});

test("confirmation requests public and Provider permissions as distinct boundaries", async () => {
  const fixture = await createInteractionFixture();
  const result = await reachPermission(fixture);

  assert.equal(result.status, "needs_permission");
  assert.ok(result.audit_brief.production_targets.confirmed);
  assert.deepEqual(
    result.request.permissions.map(({ permission_id, boundary, scope }) => ({
      permission_id,
      boundary,
      scope: boundary === "public_network" ? { targets: scope.targets } : scope,
    })),
    [
      {
        permission_id: "public_verification",
        boundary: "public_network",
        scope: { targets: ["https://example.com/"] },
      },
      {
        permission_id: "provider_read:sentry",
        boundary: "provider_read",
        scope: {
          provider: "sentry",
          adapter_version: null,
          operation: "read_only",
          target: "declared_provider_role_metadata",
          requested_fields: ["observability.configuration"],
          command: null,
        },
      },
      {
        permission_id: "provider_read:vercel",
        boundary: "provider_read",
        scope: {
          provider: "vercel",
          adapter_version: "vercel-read/v1",
          operation: "read_only",
          target: "authenticated_scope_projects",
          requested_fields: [
            "projects[].id",
            "projects[].name",
            "projects[].framework",
            "projects[].nodeVersion",
            "projects[].createdAt",
            "projects[].updatedAt",
          ],
          command: {
            executable: "vercel",
            arguments: ["project", "ls", "--json"],
          },
        },
      },
    ],
  );
  assert.equal(result.authorization_plan[0].permission_id, "local_safe_scan");
  assert.equal(result.authorization_plan[0].decision, "granted");
});

test("approved public probes collect fresh read-only evidence through the CLI contract", async () => {
  const fixture = await createInteractionFixture();
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(request.url === "/health" ? 204 : 200);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const target = `http://127.0.0.1:${port}/`;
    const journey = { purpose: "homepage loads", path: "/", method: "GET" };
    const result = await completeAudit(fixture, {
      intended_environment: "production",
      production_targets: [target],
      core_journeys: [journey],
      provider_roles: [],
      support_layers: [],
    });
    const evidence = publicEvidence(result);
    const publicEntries = result.evidence_index.entries.filter(
      (entry) => entry.evidence_kind === "public_observation",
    );

    assert.deepEqual(evidence.map(({ probe_kind, status, outcome }) => ({
      probe_kind,
      status,
      outcome,
    })), [
      { probe_kind: "dns", status: "passed", outcome: "resolved" },
      { probe_kind: "http", status: "passed", outcome: "reachable" },
      { probe_kind: "health", status: "passed", outcome: "healthy" },
      { probe_kind: "journey", status: "passed", outcome: "completed" },
    ]);
    assert.ok(evidence.every((item) => item.kind === "public_observation"));
    assert.ok(evidence.every((item) => item.target.startsWith(target.slice(0, -1))));
    assert.ok(evidence.every((item) => !Number.isNaN(Date.parse(item.collected_at))));
    assert.ok(evidence.every((item) => item.provenance.collector === "public-verification/v1"));
    assert.equal(result.report.results.public_evidence_refs.length, evidence.length);
    assert.deepEqual(
      result.report.results.public_evidence_refs.map((reference) => reference.digest),
      publicEntries.map((entry) => entry.digest),
    );
    assert.ok(publicEntries.every((entry) => entry.freshness_class === "audit_time"));
    assert.ok(publicEntries.every((entry) => entry.redaction_state === "normalized"));
    assert.doesNotMatch(JSON.stringify(result.report.results), /public_observation/u);
    assert.equal(
      result.report.results.checks.find(
        (check) => check.check_id === "web.public.availability",
      ).status,
      "passed",
    );
    assert.equal(
      result.report.results.checks.find(
        (check) => check.check_id === "web.public.transport-security",
      ).status,
      "failed",
    );
    assert.equal(
      result.report.results.checks.find(
        (check) => check.check_id === "web.public.core-journeys",
      ).status,
      "passed",
    );
    assert.deepEqual(result.report.scope.public_verification, {
      decision: "approved",
      targets: [target],
    });
    assert.equal(result.report.scope.access, "local_and_public_read_only");
    assert.ok(!result.report.scope.excluded.includes("public_network"));
    const secondResult = await completeAudit(fixture, {
      intended_environment: "production",
      production_targets: [target],
      core_journeys: [journey],
      provider_roles: [],
      support_layers: [],
    });
    assert.notDeepEqual(
      publicEvidence(secondResult).map((item) => item.collected_at),
      evidence.map((item) => item.collected_at),
    );
    assert.deepEqual(requests, [
      { method: "GET", url: "/" },
      { method: "GET", url: "/health" },
      { method: "GET", url: "/" },
      { method: "GET", url: "/" },
      { method: "GET", url: "/health" },
      { method: "GET", url: "/" },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("public verification records redirects without following undisclosed paths", async () => {
  const fixture = await createInteractionFixture();
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    if (request.url === "/health") {
      response.writeHead(204);
    } else {
      response.writeHead(302, {
        location: "http://example.invalid/mutating?token=must-not-be-retained",
      });
    }
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const result = await completeAudit(fixture, {
      intended_environment: "production",
      production_targets: [`http://127.0.0.1:${port}/start`],
      core_journeys: ["start page loads"],
      provider_roles: [],
      support_layers: [],
    });
    const redirects = publicEvidence(result).filter(
      (item) => item.outcome === "target_mismatch",
    );

    assert.equal(redirects.length, 2);
    assert.ok(redirects.every((item) => item.status === "failed"));
    assert.ok(redirects.every(
      (item) => item.details.redirect_target === "http://example.invalid/mutating",
    ));
    assert.deepEqual(requests, [
      { method: "GET", url: "/start" },
      { method: "GET", url: "/health" },
      { method: "GET", url: "/start" },
    ]);
    assert.doesNotMatch(JSON.stringify(result), /must-not-be-retained/u);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("timeouts are bounded and partial reachability becomes reasoned gaps", async () => {
  const fixture = await createInteractionFixture();
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(204);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const startedAt = Date.now();
    const result = await completeAudit(fixture, {
      intended_environment: "production",
      production_targets: [`http://127.0.0.1:${port}/`],
      core_journeys: ["homepage loads"],
      provider_roles: [],
      support_layers: [],
    });
    const elapsed = Date.now() - startedAt;
    const timeouts = publicEvidence(result).filter(
      (item) => item.outcome === "timeout",
    );

    assert.equal(result.status, "completed");
    assert.ok(elapsed >= 5000 && elapsed < 7000, `Audit took ${elapsed}ms`);
    assert.equal(timeouts.length, 2);
    assert.ok(timeouts.every((item) => item.status === "unverified"));
    assert.deepEqual(
      result.report.results.verification_gaps
        .filter((gap) => gap.reason_code === "partial_public_evidence")
        .map((gap) => gap.check_id),
      ["web.public.availability", "web.public.core-journeys"],
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("certificate failures are deterministic and never become Passed", async () => {
  const fixture = await createInteractionFixture();
  const [key, cert] = await Promise.all([
    readFile(path.join(root, "test", "fixtures", "self-signed-key.pem")),
    readFile(path.join(root, "test", "fixtures", "self-signed-cert.pem")),
  ]);
  const requests = [];
  const server = createHttpsServer({ key, cert }, (request, response) => {
    requests.push(request.url);
    response.writeHead(200);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const result = await completeAudit(fixture, {
      intended_environment: "production",
      production_targets: [`https://127.0.0.1:${port}/`],
      core_journeys: ["homepage loads"],
      provider_roles: [],
      support_layers: [],
    });
    const tlsEvidence = publicEvidence(result).find(
      (item) => item.probe_kind === "tls",
    );

    assert.equal(tlsEvidence.status, "failed");
    assert.equal(tlsEvidence.outcome, "certificate_failure");
    assert.equal(
      result.report.results.checks.find(
        (check) => check.check_id === "web.public.transport-security",
      ).status,
      "failed",
    );
    assert.deepEqual(requests, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("unreachable targets return complete deterministic evidence", async () => {
  const fixture = await createInteractionFixture();
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));

  const result = await completeAudit(fixture, {
    intended_environment: "production",
    production_targets: [`http://127.0.0.1:${port}/`],
    core_journeys: ["homepage loads"],
    provider_roles: [],
    support_layers: [],
  });
  const unreachable = publicEvidence(result).filter(
    (item) => item.outcome === "unreachable",
  );

  assert.equal(result.status, "completed");
  assert.equal(publicEvidence(result).length, 4);
  assert.equal(unreachable.length, 3);
  assert.ok(unreachable.every((item) => item.status === "failed"));
  assert.equal(
    result.report.results.checks.find(
      (check) => check.check_id === "web.public.availability",
    ).status,
    "failed",
  );
});

test("public probe concurrency is bounded per Audit", async () => {
  const fixture = await createInteractionFixture();
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const server = createServer((_request, response) => {
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    setTimeout(() => {
      response.writeHead(200);
      response.end();
      activeRequests -= 1;
    }, 50);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const result = await completeAudit(fixture, {
      intended_environment: "production",
      production_targets: [`http://127.0.0.1:${port}/`],
      core_journeys: Array.from({ length: 8 }, (_, index) => `journey ${index + 1}`),
      provider_roles: [],
      support_layers: [],
    });

    assert.equal(result.status, "completed");
    assert.ok(maxActiveRequests <= 4, `Observed ${maxActiveRequests} concurrent requests`);
    assert.ok(publicEvidence(result)
      .filter((item) => item.probe_kind === "journey")
      .every((item) =>
        item.status === "unverified"
        && item.outcome === "journey_definition_incomplete",
      ));
    assert.equal(
      result.report.results.checks.find(
        (check) => check.check_id === "web.public.core-journeys",
      ).status,
      "unverified",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("public probes stop after response headers and never consume streaming bodies", async () => {
  const fixture = await createInteractionFixture();
  const server = createServer((_request, response) => {
    response.writeHead(200);
    const stream = setInterval(() => response.write("ignored-public-body"), 20);
    const finish = setTimeout(() => response.end(), 1500);
    response.once("close", () => {
      clearInterval(stream);
      clearTimeout(finish);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const startedAt = Date.now();
    const result = await completeAudit(fixture, {
      intended_environment: "production",
      production_targets: [`http://127.0.0.1:${port}/`],
      core_journeys: [{ purpose: "homepage loads", path: "/", method: "GET" }],
      provider_roles: [],
      support_layers: [],
    });
    const elapsed = Date.now() - startedAt;

    assert.equal(result.status, "completed");
    assert.ok(elapsed < 1000, `Audit consumed response bodies for ${elapsed}ms`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("revising preserves the unconfirmed scope and grants no permission", async () => {
  const fixture = await createInteractionFixture();
  const confirmation = await reachConfirmation(fixture);
  const result = await runAudit(fixture, [
    "--resume",
    confirmation.interaction.resume_token,
    "--confirm",
    "revise",
  ]);

  assert.equal(result.status, "needs_input");
  assert.deepEqual(result.audit_brief.production_targets.values, ["https://example.com/"]);
  assert.equal(result.audit_brief.production_targets.confirmed, false);
  assert.deepEqual(
    result.request.fields.find((field) => field.field_id === "provider_roles").current_value,
    CONFIRMED_ANSWERS.provider_roles,
  );
  assert.equal("authorization_plan" in result, false);
});

test("permission decisions resume independently and denials become Unverified gaps", async () => {
  const fixture = await createInteractionFixture();
  const permission = await reachPermission(fixture);

  const partial = await runAudit(fixture, [
    "--resume",
    permission.interaction.resume_token,
    "--permissions",
    JSON.stringify({ public_verification: "denied" }),
  ]);

  assert.equal(partial.status, "needs_permission");
  assert.deepEqual(
    partial.request.permissions.map((request) => request.permission_id),
    ["provider_read:sentry", "provider_read:vercel"],
  );
  assert.equal(
    partial.authorization_plan.find(
      (entry) => entry.permission_id === "public_verification",
    ).decision,
    "denied",
  );

  const completed = await runAudit(fixture, [
    "--resume",
    partial.interaction.resume_token,
    "--permissions",
    JSON.stringify({
      "provider_read:sentry": "denied",
      "provider_read:vercel": "approved",
    }),
  ]);

  assert.equal(completed.status, "completed");
  assert.equal(completed.report.assessment, "inconclusive");
  assert.deepEqual(
    completed.report.results.verification_gaps
      .filter((gap) => gap.reason_code === "permission_denied")
      .map((gap) => gap.check_id),
    [
      "web.public.availability",
      "web.public.transport-security",
      "web.public.core-journeys",
      "provider.sentry.metadata",
    ],
  );
  assert.equal(
    completed.authorization_plan.find(
      (entry) => entry.permission_id === "provider_read:vercel",
    ).decision,
    "approved",
  );
  assert.equal(
    completed.report.results.verification_gaps.find(
      (gap) => gap.check_id === "provider.vercel.metadata",
    ).reason_code,
    "missing_provider_tool",
  );
  assert.deepEqual(completed.report.results.provider_evidence_refs, []);
  assert.deepEqual(completed.report.provenance.active_adapter_versions, ["vercel-read/v1"]);
  assert.deepEqual(completed.report.catalog.versions.active_adapters, ["vercel-read/v1"]);
});

test("resuming cannot change repository scope or an existing permission decision", async () => {
  const fixture = await createInteractionFixture();
  const otherFixture = await createInteractionFixture();
  const confirmation = await reachConfirmation(fixture);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        cli,
        "audit",
        "--json",
        "--cwd",
        otherFixture,
        "--resume",
        confirmation.interaction.resume_token,
      ],
      { cwd: root },
    ),
    (error) => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.status, "execution_error");
      assert.equal(result.error, "resume_scope_mismatch");
      return true;
    },
  );

  const permission = await reachPermission(fixture);
  const partial = await runAudit(fixture, [
    "--resume",
    permission.interaction.resume_token,
    "--permissions",
    JSON.stringify({ public_verification: "denied" }),
  ]);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        cli,
        "audit",
        "--json",
        "--cwd",
        fixture,
        "--resume",
        partial.interaction.resume_token,
        "--permissions",
        JSON.stringify({ public_verification: "approved" }),
      ],
      { cwd: root },
    ),
    (error) => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.status, "execution_error");
      assert.equal(result.error, "permission_decision_conflict");
      return true;
    },
  );
});

test("Human Mode previews the full plan before permission without exposing a resume token", async () => {
  const fixture = await createInteractionFixture();
  const confirmation = await reachConfirmation(fixture);
  const input = new PassThrough();
  const output = new PassThrough();
  let confirmationOutput = "";
  output.on("data", (chunk) => {
    confirmationOutput += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });
  await prompt.start();
  setTimeout(() => input.write("1\n"), 10);
  const response = await prompt.respond(confirmation);
  await prompt.close();

  assert.deepEqual(response, { confirmation: "confirm" });
  assert.match(
    confirmationOutput,
    /Audit Brief[\s\S]*Environment: production[\s\S]*https:\/\/example\.com\/[\s\S]*visitor can sign up[\s\S]*sentry:observability[\s\S]*observability[\s\S]*Planned Checks:[\s\S]*web\.public\.availability \[public_verification\][\s\S]*provider\.sentry\.metadata \[provider_read:sentry\][\s\S]*Confirm this Audit Brief/,
  );
  assert.doesNotMatch(confirmationOutput, /resume token/iu);
});

test("Agent Mode reports malformed interaction input as a structured execution error", async () => {
  const fixture = await createInteractionFixture();
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [cli, "audit", "--json", "--cwd", fixture, "--answers", "{invalid"],
      { cwd: root },
    ),
    (error) => {
      assert.deepEqual(JSON.parse(error.stdout), {
        contract: "launchrally.dev/cli/v2",
        status: "execution_error",
        operation: "audit",
        error: "invalid_option_json",
        message: "Audit answers and permission decisions must use valid JSON.",
      });
      return true;
    },
  );
});

test("public targets reject credentials and query data before they enter Audit state", async () => {
  const fixture = await createInteractionFixture();
  const initial = await runAudit(fixture);
  const secret = "do-not-retain-this-value";
  const result = await runAudit(fixture, [
    "--resume",
    initial.interaction.resume_token,
    "--answers",
    JSON.stringify({
      ...CONFIRMED_ANSWERS,
      production_targets: [`https://user:${secret}@example.com/?token=${secret}`],
    }),
  ]);

  assert.equal(result.status, "needs_input");
  assert.deepEqual(result.request.validation_errors, [
    { field_id: "production_targets", code: "unsafe_public_target" },
  ]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("public journeys reject mutating methods and sensitive paths", async () => {
  const fixture = await createInteractionFixture();
  const initial = await runAudit(fixture);
  const result = await runAudit(fixture, [
    "--resume",
    initial.interaction.resume_token,
    "--answers",
    JSON.stringify({
      ...CONFIRMED_ANSWERS,
      core_journeys: [
        { purpose: "submit checkout", path: "/checkout?token=secret", method: "POST" },
      ],
    }),
  ]);

  assert.equal(result.status, "needs_input");
  assert.deepEqual(result.request.validation_errors, [
    { field_id: "core_journeys", code: "invalid_public_journey" },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /token=secret/u);
});

test("public Journey strings cannot disguise a mutating method as a description", async () => {
  const fixture = await createInteractionFixture();
  const initial = await runAudit(fixture);
  const result = await runAudit(fixture, [
    "--resume",
    initial.interaction.resume_token,
    "--answers",
    JSON.stringify({
      ...CONFIRMED_ANSWERS,
      core_journeys: ["POST /admin — destructive action"],
    }),
  ]);

  assert.equal(result.status, "needs_input");
  assert.deepEqual(result.request.validation_errors, [
    { field_id: "core_journeys", code: "invalid_public_journey" },
  ]);
});

test("public journey paths cannot resolve outside confirmed target origins", async () => {
  const fixture = await createInteractionFixture();
  const initial = await runAudit(fixture);
  const result = await runAudit(fixture, [
    "--resume",
    initial.interaction.resume_token,
    "--answers",
    JSON.stringify({
      ...CONFIRMED_ANSWERS,
      core_journeys: [
        { purpose: "off-target path", path: "/\\example.invalid/x", method: "GET" },
      ],
    }),
  ]);

  assert.equal(result.status, "needs_input");
  assert.deepEqual(result.request.validation_errors, [
    { field_id: "core_journeys", code: "invalid_public_journey" },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /example\.invalid/u);
});
