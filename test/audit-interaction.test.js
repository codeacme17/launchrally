import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "packages", "cli", "bin", "rally.js");

async function createInteractionFixture() {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "launchrally-interaction-"));
  await writeFile(
    path.join(fixture, "package.json"),
    JSON.stringify({ name: "interaction-web", scripts: { build: "vite build" } }),
  );
  await writeFile(path.join(fixture, "package-lock.json"), '{"lockfileVersion":3}');
  await writeFile(
    path.join(fixture, ".env"),
    "VERCEL_ORG_ID=private-value\nSENTRY_DSN=private-value\n",
  );
  return fixture;
}

async function runAudit(fixture, options = []) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [cli, "audit", "--json", "--cwd", fixture, ...options],
    { cwd: root },
  );
  return JSON.parse(stdout);
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

test("Agent Mode asks only for unknown release intent in a versioned state", async () => {
  const fixture = await createInteractionFixture();
  const result = await runAudit(fixture);

  assert.equal(result.contract, "launchrally.dev/cli/v0");
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
  assert.deepEqual(result.audit_brief.provider_roles.candidates, [
    { provider: "sentry", role: "observability" },
    { provider: "vercel", role: "deployment" },
  ]);
  assert.deepEqual(result.audit_brief.support_layers.candidates, ["monitoring"]);
  assert.ok(result.interaction.resume_token.length > 20);
  assert.doesNotMatch(JSON.stringify(result), /private-value/);
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
      "web.baseline.lockfile",
      "web.public.endpoint",
      "provider.sentry.metadata",
      "provider.vercel.metadata",
      "web.support.monitoring.baseline",
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

test("confirmation requests public and Provider permissions as distinct boundaries", async () => {
  const fixture = await createInteractionFixture();
  const result = await reachPermission(fixture);

  assert.equal(result.status, "needs_permission");
  assert.ok(result.audit_brief.production_targets.confirmed);
  assert.deepEqual(
    result.request.permissions.map(({ permission_id, boundary, scope }) => ({
      permission_id,
      boundary,
      scope,
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
        scope: { provider: "sentry", metadata: ["observability.configuration"] },
      },
      {
        permission_id: "provider_read:vercel",
        boundary: "provider_read",
        scope: { provider: "vercel", metadata: ["deployment.configuration"] },
      },
    ],
  );
  assert.equal(result.authorization_plan[0].permission_id, "local_safe_scan");
  assert.equal(result.authorization_plan[0].decision, "granted");
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
    ["web.public.endpoint", "provider.sentry.metadata"],
  );
  assert.equal(
    completed.authorization_plan.find(
      (entry) => entry.permission_id === "provider_read:vercel",
    ).decision,
    "approved",
  );
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

test("Human Mode explains unknowns and previews the full plan before permission", async () => {
  const fixture = await createInteractionFixture();
  const { stdout: initialOutput } = await execFileAsync(
    process.execPath,
    [cli, "audit", "--cwd", fixture],
    { cwd: root },
  );
  assert.match(
    initialOutput,
    /Audit Brief[\s\S]*Project: interaction-web[\s\S]*Needs input[\s\S]*Which environment[\s\S]*Which public production URLs[\s\S]*Inferred candidates \(not confirmed\):[\s\S]*sentry \(observability\)[\s\S]*Resume token:/,
  );

  const initial = await runAudit(fixture);
  const { stdout: confirmationOutput } = await execFileAsync(
    process.execPath,
    [
      cli,
      "audit",
      "--cwd",
      fixture,
      "--resume",
      initial.interaction.resume_token,
      "--answers",
      JSON.stringify(CONFIRMED_ANSWERS),
    ],
    { cwd: root },
  );
  assert.match(
    confirmationOutput,
    /Complete plan preview[\s\S]*Environment: production[\s\S]*Target: https:\/\/example\.com\/[\s\S]*web\.public\.endpoint[\s\S]*provider\.sentry\.metadata[\s\S]*Permission preview[\s\S]*public_verification: PENDING[\s\S]*No public or Provider permission has been granted[\s\S]*Confirm this Audit Brief/,
  );
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
        contract: "launchrally.dev/cli/v0",
        status: "execution_error",
        operation: "audit",
        error: "invalid_option_json",
        message: "Audit answers and permission decisions must use valid JSON.",
      });
      return true;
    },
  );
});
