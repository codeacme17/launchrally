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
import { isSafeEvidenceArtifact } from "../packages/core/src/evidence-artifact.js";

const PROVIDER_ROLES = Object.freeze([
  { provider: "cloudflare", role: "deployment" },
  { provider: "vercel", role: "deployment" },
]);

const NEW_PROVIDER_ROLES = Object.freeze([
  { provider: "clerk", role: "authentication" },
  { provider: "neon", role: "data" },
  { provider: "resend", role: "email" },
  { provider: "sentry", role: "observability" },
]);

function approvals(plan, decision = "approved") {
  return plan.requests.map((request) => ({
    permission_id: request.permission_id,
    boundary: "provider_read",
    decision,
  }));
}

test("legacy Adapters disclose fixed read-only commands, targets, and fields", () => {
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

test("the versioned contract discloses every new Provider read before approval", () => {
  const plan = createProviderAdapterPlan(NEW_PROVIDER_ROLES);

  assert.equal(plan.contract_version, "provider-adapter-contract/v2");
  assert.deepEqual(plan.requests.map((request) => ({
    provider: request.provider,
    adapter_version: request.adapter_version,
    operation: request.operation,
    target: request.target,
    requested_fields: request.requested_fields,
    commands: request.commands,
  })), [
    {
      provider: "clerk",
      adapter_version: "clerk-read/v1",
      operation: "read_only",
      target: "authenticated_workspace_applications",
      requested_fields: [
        "applications[].application_id",
        "applications[].name",
        "applications[].instances[].instance_id",
        "applications[].instances[].environment_type",
      ],
      commands: [{
        executable: "clerk",
        arguments: ["apps", "list", "--json"],
      }],
    },
    {
      provider: "neon",
      adapter_version: "neon-read/v1",
      operation: "read_only",
      target: "authenticated_scope_and_linked_project_metadata",
      requested_fields: [
        "projects[].id",
        "projects[].name",
        "projects[].region_id",
        "projects[].created_at",
        "branches[].id",
        "branches[].name",
        "branches[].current_state",
        "branches[].created_at",
        "branches[].expires_at",
        "databases[].name",
        "databases[].created_at",
      ],
      commands: [
        {
          executable: "neonctl",
          arguments: ["projects", "list", "--output", "json", "--no-analytics"],
        },
        {
          executable: "neonctl",
          arguments: ["branches", "list", "--output", "json", "--no-analytics"],
        },
        {
          executable: "neonctl",
          arguments: ["databases", "list", "--output", "json", "--no-analytics"],
        },
      ],
    },
    {
      provider: "resend",
      adapter_version: "resend-read/v1",
      operation: "read_only",
      target: "authenticated_team_domains_and_recent_email_status",
      requested_fields: [
        "domains[].id",
        "domains[].name",
        "domains[].status",
        "domains[].region",
        "domains[].created_at",
        "domains[].capabilities.sending",
        "domains[].capabilities.receiving",
        "emails[].id",
        "emails[].created_at",
        "emails[].last_event",
        "emails[].scheduled_at",
      ],
      commands: [
        {
          executable: "resend",
          arguments: ["domains", "list", "--limit", "10", "--json"],
        },
        {
          executable: "resend",
          arguments: ["emails", "list", "--limit", "10", "--json"],
        },
      ],
    },
    {
      provider: "sentry",
      adapter_version: "sentry-read/v1",
      operation: "read_only",
      target: "configured_organization_projects_and_recent_releases",
      requested_fields: [
        "projects[].id",
        "projects[].slug",
        "projects[].team",
        "projects[].name",
        "releases[].version",
      ],
      commands: [
        {
          executable: "sentry-cli",
          arguments: ["projects", "list"],
        },
        {
          executable: "sentry-cli",
          arguments: ["releases", "list", "--raw"],
        },
      ],
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(plan),
    /\b(?:login|install|token|create|delete|send|deploy)\b/u,
  );
});

test("Clerk application metadata becomes minimized Machine Evidence", async () => {
  const plan = createProviderAdapterPlan([
    { provider: "clerk", role: "authentication" },
  ]);
  const secret = "clerk-secret-that-must-not-survive";
  const result = await executeProviderAdapters({
    cwd: "/tmp/example",
    plan,
    authorization_plan: approvals(plan),
    now: () => new Date("2026-08-10T10:00:00.000Z"),
    runner: async () => ({
      stdout: JSON.stringify([{
        application_id: "app_123",
        name: "Web application",
        billing_plan: "pro",
        instances: [{
          instance_id: "ins_123",
          environment_type: "production",
          publishable_key: "pk_live_public-but-unrequested",
          secret_key: secret,
        }],
      }]),
    }),
  });

  assert.deepEqual(result.verification_gaps, []);
  assert.deepEqual(result.active_adapter_versions, ["clerk-read/v1"]);
  assert.deepEqual(result.evidence[0].facts, {
    applications: [{
      application_id: "app_123",
      name: "Web application",
      instances: [{
        instance_id: "ins_123",
        environment_type: "production",
      }],
    }],
  });
  assert.deepEqual(result.evidence[0].provenance.commands, plan.requests[0].commands);
  assert.equal(isSafeEvidenceArtifact(result.evidence[0]), true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(result), /publishable_key|billing_plan/u);
});

test("a schema-compatible single-command request uses its disclosed command for provenance", async () => {
  const plan = createProviderAdapterPlan([
    { provider: "clerk", role: "authentication" },
  ]);
  const disclosedCommand = structuredClone(plan.requests[0].command);
  delete plan.requests[0].commands;

  const result = await executeProviderAdapters({
    cwd: "/tmp/example",
    plan,
    authorization_plan: approvals(plan),
    runner: async () => ({
      stdout: JSON.stringify([{
        application_id: "app_123",
        name: "Web application",
        instances: [],
      }]),
    }),
  });

  assert.deepEqual(result.verification_gaps, []);
  assert.deepEqual(result.evidence[0].provenance.commands, [disclosedCommand]);
});

test("incomplete or altered command sequences are rejected before Provider execution", async () => {
  const incomplete = createProviderAdapterPlan([{ provider: "neon", role: "data" }]);
  delete incomplete.requests[0].commands;
  const altered = createProviderAdapterPlan([{ provider: "neon", role: "data" }]);
  altered.requests[0].commands[0].arguments = ["projects", "delete"];

  for (const plan of [incomplete, altered]) {
    let calls = 0;
    const result = await executeProviderAdapters({
      cwd: "/tmp/example",
      plan,
      authorization_plan: approvals(plan),
      runner: async () => {
        calls += 1;
        return { stdout: "[]" };
      },
    });

    assert.equal(calls, 0);
    assert.equal(result.evidence.length, 0);
    assert.equal(result.verification_gaps[0].reason_code, "adapter_error");
  }
});

test("Neon project, branch, and database metadata becomes minimized Machine Evidence", async () => {
  const plan = createProviderAdapterPlan([{ provider: "neon", role: "data" }]);
  const secret = "postgresql://secret-connection-string";
  const calls = [];
  const responses = [
    {
      projects: [{
        id: "project-owned",
        name: "production database",
        region_id: "aws-us-east-1",
        created_at: "2026-08-01T00:00:00Z",
        connection_uri: secret,
      }],
      shared_with_you: [{
        id: "project-shared",
        name: "shared database",
        region_id: "aws-eu-central-1",
        created_at: "2026-08-02T00:00:00Z",
        settings: { secret },
      }],
    },
    [{
      id: "branch-main",
      name: "main",
      current_state: "ready",
      created_at: "2026-08-01T00:00:00Z",
      expires_at: null,
      parent_lsn: secret,
    }],
    [{
      name: "app",
      owner_name: secret,
      created_at: "2026-08-01T00:00:00Z",
    }],
  ];
  const result = await executeProviderAdapters({
    cwd: "/tmp/example",
    plan,
    authorization_plan: approvals(plan),
    runner: async (command) => {
      calls.push(command);
      return { stdout: JSON.stringify(responses[calls.length - 1]) };
    },
  });

  assert.deepEqual(calls, plan.requests[0].commands);
  assert.deepEqual(result.verification_gaps, []);
  assert.deepEqual(result.evidence[0].facts, {
    projects: [
      {
        id: "project-owned",
        name: "production database",
        region_id: "aws-us-east-1",
        created_at: "2026-08-01T00:00:00Z",
      },
      {
        id: "project-shared",
        name: "shared database",
        region_id: "aws-eu-central-1",
        created_at: "2026-08-02T00:00:00Z",
      },
    ],
    branches: [{
      id: "branch-main",
      name: "main",
      current_state: "ready",
      created_at: "2026-08-01T00:00:00Z",
    }],
    databases: [{
      name: "app",
      created_at: "2026-08-01T00:00:00Z",
    }],
  });
  assert.equal(isSafeEvidenceArtifact(result.evidence[0]), true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("Resend domain and transactional-email status becomes minimized Machine Evidence", async () => {
  const plan = createProviderAdapterPlan([{ provider: "resend", role: "email" }]);
  const secret = "recipient@example.com";
  const responses = [
    {
      object: "list",
      data: [{
        id: "domain-1",
        name: "example.com",
        status: "verified",
        region: "us-east-1",
        created_at: "2026-08-01 00:00:00+00",
        capabilities: { sending: "enabled", receiving: "disabled", secret },
        records: [{ value: secret }],
      }],
      has_more: false,
    },
    {
      object: "list",
      data: [{
        id: "email-1",
        message_id: secret,
        to: [secret],
        from: "sender@example.com",
        subject: secret,
        created_at: "2026-08-09T10:00:00Z",
        last_event: "delivered",
        scheduled_at: null,
      }],
      has_more: false,
    },
  ];
  let call = 0;
  const result = await executeProviderAdapters({
    cwd: "/tmp/example",
    plan,
    authorization_plan: approvals(plan),
    runner: async () => ({ stdout: JSON.stringify(responses[call++]) }),
  });

  assert.deepEqual(result.verification_gaps, []);
  assert.deepEqual(result.evidence[0].facts, {
    domains: [{
      id: "domain-1",
      name: "example.com",
      status: "verified",
      region: "us-east-1",
      created_at: "2026-08-01 00:00:00+00",
      capabilities: { sending: "enabled", receiving: "disabled" },
    }],
    emails: [{
      id: "email-1",
      created_at: "2026-08-09T10:00:00Z",
      last_event: "delivered",
    }],
  });
  assert.equal(isSafeEvidenceArtifact(result.evidence[0]), true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(result), /message_id|subject|sender@example\.com/u);
});

test("Sentry project and release metadata becomes minimized Machine Evidence", async () => {
  const plan = createProviderAdapterPlan([
    { provider: "sentry", role: "observability" },
  ]);
  const responses = [
    [
      "+----+------+----------+---------+",
      "| ID | Slug | Team     | Name    |",
      "+----+------+----------+---------+",
      "| 42 | web  | frontend | Web app |",
      "+----+------+----------+---------+",
      "",
    ].join("\n"),
    "web@2026.08.10\nweb@2026.08.09\n",
  ];
  let call = 0;
  const result = await executeProviderAdapters({
    cwd: "/tmp/example",
    plan,
    authorization_plan: approvals(plan),
    runner: async () => ({ stdout: responses[call++] }),
  });

  assert.deepEqual(result.verification_gaps, []);
  assert.deepEqual(result.evidence[0].facts, {
    projects: [{ id: "42", slug: "web", team: "frontend", name: "Web app" }],
    releases: [{ version: "web@2026.08.10" }, { version: "web@2026.08.09" }],
  });
  assert.equal(isSafeEvidenceArtifact(result.evidence[0]), true);
});

test("malformed responses become specific gaps for every new Provider Adapter", async () => {
  for (const providerRole of NEW_PROVIDER_ROLES) {
    const plan = createProviderAdapterPlan([providerRole]);
    const result = await executeProviderAdapters({
      cwd: "/tmp/example",
      plan,
      authorization_plan: approvals(plan),
      runner: async (command) => ({
        stdout: command.executable === "sentry-cli"
          ? "| Unexpected | Columns |\n"
          : "not-json",
      }),
    });

    assert.equal(result.evidence.length, 0, providerRole.provider);
    assert.equal(
      result.verification_gaps[0].reason_code,
      "malformed_provider_response",
      providerRole.provider,
    );
  }
});

test("unsafe normalized fields become malformed-response gaps before evidence leaves an Adapter", async () => {
  const plan = createProviderAdapterPlan([{ provider: "clerk", role: "authentication" }]);
  const result = await executeProviderAdapters({
    cwd: "/tmp/example",
    plan,
    authorization_plan: approvals(plan),
    runner: async () => ({
      stdout: JSON.stringify([{
        application_id: "app_123",
        name: "x".repeat(513),
        instances: [],
      }]),
    }),
  });

  assert.equal(result.evidence.length, 0);
  assert.equal(result.verification_gaps[0].reason_code, "malformed_provider_response");
});

test("oversized responses become specific gaps for every new Provider Adapter", async () => {
  const oversized = "x".repeat(1024 * 1024 + 1);
  for (const providerRole of NEW_PROVIDER_ROLES) {
    const plan = createProviderAdapterPlan([providerRole]);
    const result = await executeProviderAdapters({
      cwd: "/tmp/example",
      plan,
      authorization_plan: approvals(plan),
      runner: async () => ({ stdout: oversized }),
    });

    assert.equal(result.evidence.length, 0, providerRole.provider);
    assert.equal(
      result.verification_gaps[0].reason_code,
      "provider_response_too_large",
      providerRole.provider,
    );
  }
});

test("timeouts become specific gaps for every new Provider Adapter", async () => {
  for (const providerRole of NEW_PROVIDER_ROLES) {
    const plan = createProviderAdapterPlan([providerRole]);
    const result = await executeProviderAdapters({
      cwd: "/tmp/example",
      plan,
      authorization_plan: approvals(plan),
      runner: async () => {
        throw Object.assign(new Error("command timed out"), { code: "ETIMEDOUT" });
      },
    });

    assert.equal(result.evidence.length, 0, providerRole.provider);
    assert.equal(
      result.verification_gaps[0].reason_code,
      "provider_timeout",
      providerRole.provider,
    );
  }
});

test("unsupported account capabilities become specific gaps for every new Provider Adapter", async () => {
  for (const providerRole of NEW_PROVIDER_ROLES) {
    const plan = createProviderAdapterPlan([providerRole]);
    const result = await executeProviderAdapters({
      cwd: "/tmp/example",
      plan,
      authorization_plan: approvals(plan),
      runner: async () => {
        throw Object.assign(new Error("provider rejected read"), {
          stderr: "This account does not have access to this capability",
        });
      },
    });

    assert.equal(result.evidence.length, 0, providerRole.provider);
    assert.equal(
      result.verification_gaps[0].reason_code,
      "unsupported_provider_capability",
      providerRole.provider,
    );
  }
});

test("each new Provider permission can be denied without running its Adapter", async () => {
  for (const providerRole of NEW_PROVIDER_ROLES) {
    const plan = createProviderAdapterPlan([providerRole]);
    let calls = 0;
    const result = await executeProviderAdapters({
      cwd: "/tmp/example",
      plan,
      authorization_plan: approvals(plan, "denied"),
      runner: async () => {
        calls += 1;
        return { stdout: "[]" };
      },
    });

    assert.equal(calls, 0, providerRole.provider);
    assert.equal(result.evidence.length, 0, providerRole.provider);
    assert.equal(result.verification_gaps[0].reason_code, "permission_denied");
  }
});

test("unavailable, unauthenticated, and Provider errors remain specific for every new Adapter", async () => {
  const failures = [
    [Object.assign(new Error("missing"), { code: "ENOENT" }), "missing_provider_tool"],
    [Object.assign(new Error("failed"), { stderr: "Please log in to continue" }), "missing_provider_login"],
    [Object.assign(new Error("provider failed"), { stderr: "500 internal error" }), "adapter_error"],
  ];
  for (const providerRole of NEW_PROVIDER_ROLES) {
    for (const [error, reasonCode] of failures) {
      const plan = createProviderAdapterPlan([providerRole]);
      const result = await executeProviderAdapters({
        cwd: "/tmp/example",
        plan,
        authorization_plan: approvals(plan),
        runner: async () => { throw error; },
      });

      assert.equal(result.evidence.length, 0, `${providerRole.provider}:${reasonCode}`);
      assert.equal(
        result.verification_gaps[0].reason_code,
        reasonCode,
        providerRole.provider,
      );
    }
  }
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
  assert.ok(result.evidence.every(isSafeEvidenceArtifact));
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
  if (process.platform === "win32") {
    await writeFile(
      path.join(directory, "wrangler.cmd"),
      `@echo off\r\n> "${marker}" echo started\r\nping -n 60 127.0.0.1 >nul\r\n`,
    );
  } else {
    const executable = path.join(directory, "wrangler");
    await writeFile(executable, [
      "#!/usr/bin/env node",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started");`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    await chmod(executable, 0o755);
  }
  const originalPath = process.env.PATH;
  process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
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
    [null, "malformed_provider_response"],
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
