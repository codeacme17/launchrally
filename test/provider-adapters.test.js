import assert from "node:assert/strict";
import { access, chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

test("in-flight Provider commands receive AbortSignal and abort instead of becoming gaps", async () => {
  const plan = createProviderAdapterPlan([{ provider: "cloudflare", role: "deployment" }]);
  const controller = new AbortController();
  let startCommand;
  const commandStarted = new Promise((resolve) => {
    startCommand = resolve;
  });
  const execution = executeProviderAdapters({
    cwd: "/tmp/example",
    plan,
    authorization_plan: approvals(plan),
    signal: controller.signal,
    runner: async (command, cwd, { signal } = {}) => new Promise((resolve, reject) => {
      startCommand();
      if (!signal) {
        setTimeout(() => resolve({ stdout: "[]" }), 300);
        return;
      }
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }),
  });

  await commandStarted;
  controller.abort();
  await assert.rejects(
    Promise.race([
      execution,
      new Promise((resolve, reject) => setTimeout(
        () => reject(new Error("Provider command did not abort promptly")),
        100,
      )),
    ]),
    (error) => error?.name === "AbortError",
  );
});

test("already-aborted Provider execution starts no command", async () => {
  const plan = createProviderAdapterPlan([{ provider: "cloudflare", role: "deployment" }]);
  const controller = new AbortController();
  controller.abort();
  let calls = 0;

  await assert.rejects(executeProviderAdapters({
    cwd: "/tmp/example",
    plan,
    authorization_plan: approvals(plan),
    signal: controller.signal,
    runner: async () => {
      calls += 1;
      return { stdout: "[]" };
    },
  }), (error) => error?.name === "AbortError");
  assert.equal(calls, 0);
});

test("the default Provider subprocess runner terminates on abort", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-provider-abort-"));
  const marker = path.join(directory, "started");
  const executable = path.join(directory, "wrangler");
  await writeFile(executable, [
    `#!${process.execPath}`,
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started");`,
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"));
  await chmod(executable, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = directory;
  const plan = createProviderAdapterPlan([{ provider: "cloudflare", role: "deployment" }]);
  const controller = new AbortController();
  let execution;

  try {
    execution = executeProviderAdapters({
      cwd: directory,
      plan,
      authorization_plan: approvals(plan),
      signal: controller.signal,
    });
    let started = false;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      try {
        await access(marker);
        started = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    controller.abort();

    assert.equal(started, true);
    await assert.rejects(execution, (error) => error?.name === "AbortError");
  } finally {
    controller.abort();
    await execution?.catch(() => {});
    process.env.PATH = originalPath;
  }
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
