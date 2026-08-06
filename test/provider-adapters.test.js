import assert from "node:assert/strict";
import test from "node:test";

import {
  createProviderAdapterPlan,
  executeProviderAdapters,
  PROVIDER_ADAPTER_CONTRACT,
} from "../packages/core/src/provider-adapters.js";

const PROVIDER_ROLES = Object.freeze([
  { provider: "cloudflare", role: "deployment" },
  { provider: "vercel", role: "deployment" },
]);

function approvals(plan, decision = "approved") {
  return plan.requests.map((request) => ({
    permission_id: request.permission_id,
    boundary: "provider_read",
    decision,
  }));
}

test("the v1 contract discloses fixed read-only commands, targets, and fields", () => {
  const plan = createProviderAdapterPlan(PROVIDER_ROLES);

  assert.equal(plan.contract_version, PROVIDER_ADAPTER_CONTRACT);
  assert.deepEqual(plan.requests.map((request) => ({
    provider: request.provider,
    adapter_version: request.adapter_version,
    operation: request.operation,
    target: request.target,
    command: request.command,
  })), [
    {
      provider: "cloudflare",
      adapter_version: "cloudflare-read/v1",
      operation: "read_only",
      target: "configured_worker_deployments",
      command: {
        executable: "wrangler",
        arguments: ["deployments", "list", "--json"],
      },
    },
    {
      provider: "vercel",
      adapter_version: "vercel-read/v1",
      operation: "read_only",
      target: "authenticated_scope_projects",
      command: {
        executable: "vercel",
        arguments: ["project", "ls", "--json"],
      },
    },
  ]);
  assert.ok(plan.requests.every((request) => request.requested_fields.length > 0));
  assert.doesNotMatch(JSON.stringify(plan), /login|install|token|deploy --/u);
});

test("Cloudflare and Vercel responses become minimized Machine Evidence", async () => {
  const plan = createProviderAdapterPlan(PROVIDER_ROLES);
  const secret = "secret-that-must-not-survive";
  const calls = [];
  const result = await executeProviderAdapters({
    cwd: "/tmp/example",
    plan,
    authorization_plan: approvals(plan),
    now: () => new Date("2026-08-06T12:00:00.000Z"),
    runner: async (command, cwd) => {
      calls.push({ command, cwd });
      if (command.executable === "wrangler") {
        return {
          stdout: JSON.stringify([{
            id: "deployment-id",
            created_on: "2026-08-06T11:00:00.000Z",
            source: "wrangler",
            strategy: "percentage",
            author_email: secret,
            annotations: { secret },
            versions: [{ version_id: "version-id", percentage: 100, secret }],
          }]),
        };
      }
      return {
        stdout: JSON.stringify({
          projects: [{
            id: "project-id",
            name: "web",
            framework: "nextjs",
            nodeVersion: "22.x",
            createdAt: 1,
            updatedAt: 2,
            accountId: secret,
            environmentVariables: [{ value: secret }],
          }],
        }),
      };
    },
  });

  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.cwd === "/tmp/example"));
  assert.deepEqual(result.active_adapter_versions, ["cloudflare-read/v1", "vercel-read/v1"]);
  assert.deepEqual(result.verification_gaps, []);
  assert.deepEqual(result.evidence.map((item) => item.kind), [
    "machine_evidence",
    "machine_evidence",
  ]);
  assert.ok(result.evidence.every(
    (item) => item.provenance.collector === PROVIDER_ADAPTER_CONTRACT,
  ));
  assert.ok(result.evidence.every(
    (item) => item.collected_at === "2026-08-06T12:00:00.000Z",
  ));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.deepEqual(result.evidence[0].facts, {
    deployments: [{
      id: "deployment-id",
      created_on: "2026-08-06T11:00:00.000Z",
      source: "wrangler",
      strategy: "percentage",
      versions: [{ version_id: "version-id", percentage: 100 }],
    }],
  });
  assert.deepEqual(result.evidence[1].facts, {
    projects: [{
      id: "project-id",
      name: "web",
      framework: "nextjs",
      nodeVersion: "22.x",
      createdAt: 1,
      updatedAt: 2,
    }],
  });
});

test("denied, unsupported, missing-tool, missing-login, and malformed responses are gaps", async () => {
  const deniedPlan = createProviderAdapterPlan([{ provider: "cloudflare", role: "deployment" }]);
  let calls = 0;
  const denied = await executeProviderAdapters({
    cwd: "/tmp/example",
    plan: deniedPlan,
    authorization_plan: approvals(deniedPlan, "denied"),
    runner: async () => {
      calls += 1;
      return { stdout: "[]" };
    },
  });
  assert.equal(calls, 0);
  assert.equal(denied.verification_gaps[0].reason_code, "permission_denied");

  const pending = await executeProviderAdapters({
    cwd: "/tmp/example",
    plan: deniedPlan,
    authorization_plan: [{
      permission_id: "provider_read:cloudflare",
      boundary: "provider_read",
      decision: "pending",
    }],
    runner: async () => {
      calls += 1;
      return { stdout: "[]" };
    },
  });
  assert.equal(calls, 0);
  assert.equal(pending.verification_gaps[0].reason_code, "execution_skipped");

  const unsupportedPlan = createProviderAdapterPlan([{ provider: "netlify", role: "deployment" }]);
  const unsupported = await executeProviderAdapters({
    cwd: "/tmp/example",
    plan: unsupportedPlan,
    authorization_plan: approvals(unsupportedPlan),
    runner: async () => {
      calls += 1;
      return { stdout: "[]" };
    },
  });
  assert.equal(calls, 0);
  assert.equal(unsupported.verification_gaps[0].reason_code, "unsupported_provider");

  for (const [error, reasonCode] of [
    [Object.assign(new Error("missing"), { code: "ENOENT" }), "missing_provider_tool"],
    [Object.assign(new Error("failed"), { stderr: "Please log in to continue" }), "missing_provider_login"],
    [null, "adapter_error"],
  ]) {
    const failed = await executeProviderAdapters({
      cwd: "/tmp/example",
      plan: deniedPlan,
      authorization_plan: approvals(deniedPlan),
      runner: async () => {
        if (error) throw error;
        return { stdout: "not-json" };
      },
    });
    assert.equal(failed.evidence.length, 0);
    assert.equal(failed.verification_gaps[0].reason_code, reasonCode);
  }
});

test("a deployment without Provider roles uses no Adapter and produces no Provider gap", async () => {
  const plan = createProviderAdapterPlan([]);
  const result = await executeProviderAdapters({
    cwd: "/tmp/example",
    plan,
    authorization_plan: [],
    runner: async () => {
      throw new Error("runner must not be called");
    },
  });

  assert.deepEqual(plan, {
    contract_version: PROVIDER_ADAPTER_CONTRACT,
    requests: [],
  });
  assert.deepEqual(result, {
    evidence: [],
    verification_gaps: [],
    active_adapter_versions: [],
  });
});
