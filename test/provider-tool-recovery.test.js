import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  PROVIDER_TOOL_RECOVERY_SCHEMA,
  assertValidProviderToolRecovery,
} from "@launchrally/contracts";

import {
  createProviderAdapterPlan,
  executeProviderAdapters,
} from "../packages/core/src/provider-adapters.js";
import {
  applyProviderToolRecoveryChoice,
  createProviderToolRecovery,
  providerToolInstallationAuthorities,
  runProviderToolRecovery,
} from "../packages/core/src/provider-tool-recovery.js";
import { runProviderCommand } from "../packages/core/src/provider-command-runner.js";

const execFileAsync = promisify(execFile);

function targetedVerificationResult(recovery) {
  const checkId = `provider.${recovery.provider}.metadata`;
  const resultId = `targeted_${recovery.provider}`;
  const sourceReportId = "report_source";
  return {
    contract: "launchrally.dev/cli/v2",
    schema_version: "launchrally.dev/verification-result/v2",
    status: "completed",
    operation: "verify",
    outcome: "targeted_verification_completed",
    verification_scope: { mode: "targeted", whole_release: false, check_ids: [checkId] },
    assessment_scope: "targeted_only",
    assessment: null,
    manifest_drift: [],
    authorization_plan: [{
      permission_id: recovery.permission_id,
      boundary: "provider_read",
      decision: "approved",
      scope: recovery.provider_read_scope,
    }],
    interaction: {
      schema_version: "launchrally.dev/verify-interaction/v1",
      interaction_id: "verify_interaction",
      revision: 1,
    },
    history: {
      source_report_id: sourceReportId,
      source_evidence_index_id: "evidence_source",
      current_result_id: resultId,
    },
    comparison: {
      schema_version: "launchrally.dev/report-comparison/v1",
      source_report_id: sourceReportId,
      current_result_id: resultId,
      invalidated_evidence: [],
      checks: [{ check_id: checkId, before: "unverified", after: "unverified", changed: false }],
    },
    targeted_result: {
      schema_version: "launchrally.dev/targeted-verification/v1",
      result_id: resultId,
      created_at: "2026-08-12T00:00:00.000Z",
      check_ids: [checkId],
      checks: [{
        check_id: checkId,
        check_version: 1,
        risk_domain: "data_and_integrations",
        priority: "p0",
        severity: "major",
        release_gate: "always",
        applicability: {},
        status: "unverified",
        summary: "Provider metadata remains unverified.",
        evidence: [],
      }],
      catalog: {
        checks: [{ check_id: checkId, check_version: 1, freshness_behavior: {} }],
      },
      evidence: [],
      provider_verification_gaps: [{
        check_id: checkId,
        status: "unverified",
        reason_code: "missing_provider_tool",
        reason: "The reviewed Provider executable is unavailable.",
      }],
      provider_tool_recoveries: [recovery],
      manifest_drift: [],
      verification_context: {
        digest_version: "verification-scope-digests/v1",
        repository_digests: [],
        manifest_digest: null,
        target_digest: `sha256:${"0".repeat(64)}`,
      },
      current: true,
      currentness: {
        status: "current",
        evaluated_at: "2026-08-12T00:00:00.000Z",
        reasons: [],
      },
    },
  };
}

test("a missing Provider executable returns a default-safe typed recovery without changing the Gap", async () => {
  const plan = createProviderAdapterPlan([{ provider: "clerk", role: "authentication" }]);
  const result = await executeProviderAdapters({
    cwd: process.cwd(),
    plan,
    authorization_plan: [{
      permission_id: "provider_read:clerk",
      decision: "approved",
    }],
    runner: async () => {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
    platform: "linux",
    shell: "posix",
  });

  assert.equal(result.verification_gaps[0].status, "unverified");
  assert.equal(result.verification_gaps[0].reason_code, "missing_provider_tool");
  assert.equal(result.evidence.length, 0);
  assert.equal(result.provider_tool_recoveries.length, 1);

  const [recovery] = result.provider_tool_recoveries;
  assertValidProviderToolRecovery(recovery);
  assert.equal(recovery.schema_version, PROVIDER_TOOL_RECOVERY_SCHEMA);
  assert.equal(recovery.provider, "clerk");
  assert.equal(recovery.adapter_version, "clerk-read/v1");
  assert.equal(recovery.executable, "clerk");
  assert.equal(recovery.state, "executable_missing");
  assert.equal(recovery.evidence_benefit.target, "authenticated_workspace_applications");
  assert.deepEqual(recovery.evidence_benefit.requested_fields, plan.requests[0].requested_fields);
  assert.equal(recovery.installation_authority.package.name, "clerk");
  assert.equal(recovery.installation_authority.package.exact_version, "3.1.0");
  assert.equal(recovery.installation_authority.official_source.url, "https://clerk.com/docs/cli");
  assert.deepEqual(recovery.installation_authority.verification_command, {
    executable: "clerk",
    arguments: ["--version"],
    shell: false,
  });
  assert.deepEqual(recovery.choices.map(({ id }) => id), [
    "continue_with_gap",
    "show_install_instructions",
    "cancel",
  ]);
  assert.equal(recovery.choices.find(({ default: isDefault }) => isDefault)?.id,
    "continue_with_gap");
  assert.deepEqual(recovery.installation_instructions, []);
  assert.deepEqual(recovery.safety, {
    launchrally_executes_installation: false,
    provider_read_approval_reused: false,
    authentication_initiated: false,
    credentials_requested: false,
    provider_write_authorized: false,
  });
});

test("show_install_instructions reveals only the reviewed exact-version route for the active environment", async () => {
  const request = createProviderAdapterPlan([
    { provider: "resend", role: "email" },
  ]).requests[0];
  const recovery = createProviderToolRecovery(request, {
    platform: "linux",
    shell: "posix",
  });

  const shown = await applyProviderToolRecoveryChoice(
    recovery,
    "show_install_instructions",
  );

  assertValidProviderToolRecovery(shown);
  assert.deepEqual(shown.installation_instructions, [{
    route_id: "official-npm-global",
    command: {
      executable: "npm",
      arguments: ["install", "--global", "resend-cli@2.12.0"],
      shell: false,
    },
  }]);
  assert.deepEqual(shown.choices.map(({ id }) => id), [
    "continue_with_gap",
    "rediscover_executable",
    "cancel",
  ]);
  assert.equal(JSON.stringify(shown).includes("latest"), false);
  assert.equal(JSON.stringify(shown).includes("sudo"), false);
});

test("installation guidance remains unavailable on an undeclared platform", async () => {
  const request = createProviderAdapterPlan([
    { provider: "vercel", role: "deployment" },
  ]).requests[0];
  const recovery = createProviderToolRecovery(request, {
    platform: "freebsd",
    shell: "posix",
  });

  assert.equal(recovery.state, "guidance_unavailable");
  assert.equal(recovery.active_environment.guidance_available, false);
  await assert.rejects(
    applyProviderToolRecoveryChoice(recovery, "show_install_instructions"),
    { code: "invalid_provider_tool_recovery_choice" },
  );
});

test("Cloudflare remains explicit guidance-unavailable because its official route is project-local", () => {
  const request = createProviderAdapterPlan([
    { provider: "cloudflare", role: "deployment" },
  ]).requests[0];
  const recovery = createProviderToolRecovery(request, {
    platform: "linux",
    shell: "posix",
  });

  assert.equal(recovery.state, "guidance_unavailable");
  assert.deepEqual(recovery.installation_authority.supported_platforms, []);
  assert.deepEqual(recovery.choices.map(({ id }) => id), ["continue_with_gap", "cancel"]);
});

test("shared Provider installation authority is exact, official, and non-executing", () => {
  const authorities = providerToolInstallationAuthorities();
  assert.deepEqual(authorities.map(({ provider }) => provider), [
    "clerk",
    "cloudflare",
    "neon",
    "resend",
    "sentry",
    "vercel",
  ]);
  for (const authority of authorities) {
    assert.match(authority.package.exact_version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
    assert.match(authority.official_source.url, /^https:\/\//u);
    assert.equal(
      authority.installation_routes.length > 0 || authority.provider === "cloudflare",
      true,
    );
    for (const route of authority.installation_routes) {
      const serialized = JSON.stringify(route);
      assert.equal(/(?:latest|next|canary|\*)/u.test(serialized), false);
      assert.equal(/sudo|login|auth|token|credential/iu.test(serialized), false);
      assert.equal(route.command.shell, false);
    }
  }
});

test("rediscovery keeps an executable with the wrong version out of the read path", async () => {
  const request = createProviderAdapterPlan([
    { provider: "neon", role: "data" },
  ]).requests[0];
  const recovery = createProviderToolRecovery(request, {
    platform: "linux",
    shell: "posix",
  });
  let calls = 0;

  const inspected = await applyProviderToolRecoveryChoice(
    recovery,
    "rediscover_executable",
    {
      runner: async (command) => {
        calls += 1;
        assert.deepEqual(command, {
          executable: "neonctl",
          arguments: ["--version"],
          shell: false,
        });
        return { stdout: "neonctl version 2.15.1\n", stderr: "" };
      },
    },
  );

  assert.equal(calls, 1);
  assert.equal(inspected.state, "unsupported_version");
  assert.deepEqual(inspected.detected, {
    executable: "present",
    version: "unsupported",
    detected_version: "2.15.1",
    authentication: "unknown",
  });
  assert.equal(inspected.fresh_permission, undefined);
});

test("successful rediscovery creates a fresh pending Provider-read permission without collecting", async () => {
  const request = createProviderAdapterPlan([
    { provider: "neon", role: "data" },
  ]).requests[0];
  const recovery = createProviderToolRecovery(request, {
    platform: "linux",
    shell: "posix",
  });

  const inspected = await applyProviderToolRecoveryChoice(
    recovery,
    "rediscover_executable",
    { runner: async () => ({ stdout: "3.2.0\n", stderr: "" }) },
  );

  assertValidProviderToolRecovery(inspected);
  assert.equal(inspected.state, "ready_for_fresh_permission");
  assert.deepEqual(inspected.detected, {
    executable: "present",
    version: "supported",
    detected_version: "3.2.0",
    authentication: "unknown",
  });
  assert.deepEqual(inspected.fresh_permission, {
    permission_id: "provider_read:neon",
    boundary: "provider_read",
    decision: "pending",
    basis: "provider_tool_rediscovered",
    previous_approval_reused: false,
    scope: request,
  });
  assert.deepEqual(inspected.installation_instructions, []);

  const declined = await applyProviderToolRecoveryChoice(
    inspected,
    "continue_with_gap",
  );
  assert.equal(declined.state, "fresh_read_declined");
  assert.equal(declined.fresh_permission, undefined);
});

test("rediscovery reports an executable that is still missing without executing installation", async () => {
  const request = createProviderAdapterPlan([
    { provider: "cloudflare", role: "deployment" },
  ]).requests[0];
  const recovery = createProviderToolRecovery(request, {
    platform: "darwin",
    shell: "posix",
  });
  const inspected = await applyProviderToolRecoveryChoice(
    recovery,
    "rediscover_executable",
    {
      runner: async () => {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      },
    },
  );

  assert.equal(inspected.state, "guidance_unavailable");
  assert.equal(inspected.detected.executable, "missing");
  assert.deepEqual(inspected.choices.map(({ id }) => id), ["continue_with_gap", "cancel"]);
  assert.equal(inspected.fresh_permission, undefined);
});

test("wrong-version rediscovery never invents guidance for a guidance-unavailable Provider", async () => {
  const request = createProviderAdapterPlan([
    { provider: "cloudflare", role: "deployment" },
  ]).requests[0];
  const recovery = createProviderToolRecovery(request, {
    platform: "linux",
    shell: "posix",
  });

  const inspected = await applyProviderToolRecoveryChoice(
    recovery,
    "rediscover_executable",
    { runner: async () => ({ stdout: "wrangler 4.120.0\n", stderr: "" }) },
  );

  assert.equal(inspected.state, "unsupported_version");
  assert.deepEqual(inspected.choices.map(({ id }) => id), ["continue_with_gap", "cancel"]);
});

test("missing Provider authentication is separate from installation and never offers login", async () => {
  const plan = createProviderAdapterPlan([{ provider: "sentry", role: "observability" }]);
  const result = await executeProviderAdapters({
    cwd: process.cwd(),
    plan,
    authorization_plan: [{
      permission_id: "provider_read:sentry",
      decision: "approved",
    }],
    runner: async () => {
      const error = new Error("authentication required; please login");
      error.stderr = "authentication required";
      throw error;
    },
    platform: "win32",
    shell: "powershell",
  });

  assert.equal(result.verification_gaps[0].reason_code, "missing_provider_login");
  const [recovery] = result.provider_tool_recoveries;
  assert.equal(recovery.state, "unauthenticated");
  assert.equal(recovery.detected.authentication, "unauthenticated");
  assert.deepEqual(recovery.installation_instructions, []);
  assert.deepEqual(recovery.choices.map(({ id }) => id), [
    "continue_with_gap",
    "cancel",
  ]);
  assert.equal(/login|credential|token/iu.test(JSON.stringify(recovery.choices)), false);
});

test("the recovery interaction routes typed choices without prose parsing or installation execution", async () => {
  const request = createProviderAdapterPlan([
    { provider: "resend", role: "email" },
  ]).requests[0];
  const recovery = createProviderToolRecovery(request, {
    platform: "linux",
    shell: "posix",
  });

  const initial = await runProviderToolRecovery(recovery);
  assert.equal(initial.status, "needs_input");
  assert.equal(initial.operation, "providers");
  assert.equal(initial.request.kind, "provider_tool_recovery");
  assert.deepEqual(initial.request.choices.map(({ id }) => id), [
    "continue_with_gap",
    "show_install_instructions",
    "cancel",
  ]);

  const shown = await runProviderToolRecovery(recovery, {
    choice: "show_install_instructions",
  });
  assert.equal(shown.status, "needs_input");
  assert.equal(shown.recovery.installation_instructions.length, 1);

  const ready = await runProviderToolRecovery(recovery, {
    choice: "rediscover_executable",
  }, {
    runner: async () => ({ stdout: "resend 2.12.0\n", stderr: "" }),
  });
  assert.equal(ready.status, "completed");
  assert.equal(ready.outcome, "ready_for_fresh_permission");
  assert.equal(ready.request.type, "fresh_provider_read_permission");
  assert.equal(ready.request.permission.decision, "pending");
  assert.equal(ready.request.permission.previous_approval_reused, false);
  assert.deepEqual(ready.next, {
    type: "restart_audit_or_verify",
    required: true,
    message:
      "Start a new Audit or Verify collection boundary and decide provider_read:resend again before any Provider metadata is read.",
  });

  const continued = await runProviderToolRecovery(recovery, {
    choice: "continue_with_gap",
  });
  assert.equal(continued.status, "completed");
  assert.equal(continued.outcome, "continued_with_gap");
  assert.equal(continued.gap_preserved, true);
});

test("runtime recovery rejects Report-tampered execution authority before running a command", async () => {
  const request = createProviderAdapterPlan([
    { provider: "clerk", role: "authentication" },
  ]).requests[0];
  const recovery = createProviderToolRecovery(request, {
    platform: "linux",
    shell: "posix",
  });
  recovery.installation_authority.verification_command = {
    executable: "node",
    arguments: ["--eval", "process.exit(99)"],
    shell: false,
  };
  let calls = 0;

  const result = await runProviderToolRecovery(recovery, {
    choice: "rediscover_executable",
  }, {
    runner: async () => {
      calls += 1;
      return { stdout: "3.1.0\n", stderr: "" };
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "invalid_provider_tool_recovery_authority");
});

test("runtime recovery rejects a Report-tampered Provider-read scope before permission", async () => {
  const request = createProviderAdapterPlan([
    { provider: "clerk", role: "authentication" },
  ]).requests[0];
  const recovery = createProviderToolRecovery(request, {
    platform: "linux",
    shell: "posix",
  });
  recovery.provider_read_scope.operation = "write";
  recovery.provider_read_scope.command.arguments = ["apps", "create"];
  let calls = 0;

  const result = await runProviderToolRecovery(recovery, {
    choice: "rediscover_executable",
  }, {
    runner: async () => {
      calls += 1;
      return { stdout: "3.1.0\n", stderr: "" };
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "invalid_provider_tool_recovery_authority");
});

test("runtime recovery rejects tampered benefit and default-choice semantics", async () => {
  const request = createProviderAdapterPlan([
    { provider: "vercel", role: "deployment" },
  ]).requests[0];
  const recovery = createProviderToolRecovery(request, {
    platform: "linux",
    shell: "posix",
  });
  recovery.evidence_benefit.summary = "Collect credentials and deploy.";
  recovery.choices = [{
    id: "show_install_instructions",
    label: "Install automatically",
    default: true,
  }];

  const result = await runProviderToolRecovery(recovery);

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "invalid_provider_tool_recovery_authority");
});

test("runtime recovery rejects tampered rendered installation instructions", async () => {
  const request = createProviderAdapterPlan([
    { provider: "clerk", role: "authentication" },
  ]).requests[0];
  const recovery = await applyProviderToolRecoveryChoice(
    createProviderToolRecovery(request, { platform: "linux", shell: "posix" }),
    "show_install_instructions",
  );
  recovery.installation_instructions[0].command = {
    executable: "node",
    arguments: ["--eval", "process.exit(99)"],
    shell: false,
  };

  const result = await runProviderToolRecovery(recovery);

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "invalid_provider_tool_recovery_authority");
});

test("an authentication Gap cannot be routed into installation guidance", async () => {
  const request = createProviderAdapterPlan([
    { provider: "sentry", role: "observability" },
  ]).requests[0];
  const recovery = createProviderToolRecovery(request, {
    reason_code: "missing_provider_login",
    platform: "linux",
    shell: "posix",
  });

  const result = await runProviderToolRecovery(recovery, {
    choice: "show_install_instructions",
  });

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "invalid_provider_tool_recovery_choice");

  const rediscovery = await runProviderToolRecovery(recovery, {
    choice: "rediscover_executable",
  }, { runner: async () => ({ stdout: "3.6.2\n", stderr: "" }) });
  assert.equal(rediscovery.status, "execution_error");
  assert.equal(rediscovery.error, "invalid_provider_tool_recovery_choice");

  const continued = await runProviderToolRecovery(recovery, {
    choice: "continue_with_gap",
  });
  assert.equal(continued.outcome, "continued_with_authentication_gap");
  assert.equal(continued.recovery.state, "authentication_declined");
});

test("cancel preserves the Gap and executes no command", async () => {
  const request = createProviderAdapterPlan([
    { provider: "resend", role: "email" },
  ]).requests[0];
  const recovery = createProviderToolRecovery(request, {
    platform: "linux",
    shell: "posix",
  });
  let calls = 0;

  const result = await runProviderToolRecovery(recovery, { choice: "cancel" }, {
    runner: async () => {
      calls += 1;
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.outcome, "recovery_cancelled");
  assert.equal(result.recovery.state, "recovery_cancelled");
  assert.equal(result.gap_preserved, true);
});

test("the bounded Provider runner wraps an npm Windows command shim safely", async () => {
  let invocation;
  await runProviderCommand({ executable: "clerk", arguments: ["--version"] }, "/work", {
    platform: "win32",
    environment: { PATH: "/tools", PATHEXT: ".CMD", COMSPEC: "cmd.exe" },
    accessFile: async (candidate) => {
      assert.match(candidate, /clerk\.CMD$/u);
    },
    execute: async (executable, arguments_, options) => {
      invocation = { executable, arguments_, options };
      return { stdout: "3.1.0\n", stderr: "" };
    },
  });

  assert.equal(invocation.executable, "cmd.exe");
  assert.deepEqual(invocation.arguments_.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(invocation.arguments_[3], /clerk\.CMD.*--version/u);
  assert.equal(invocation.options.windowsVerbatimArguments, true);
  assert.equal(invocation.options.timeout, 10_000);
  assert.equal(invocation.options.env.CI, "1");
});

test("the JSON CLI consumes a saved typed recovery and renders reviewed instructions", async () => {
  const request = createProviderAdapterPlan([
    { provider: "clerk", role: "authentication" },
  ]).requests[0];
  const recovery = createProviderToolRecovery(request, {
    platform: process.platform,
    shell: process.platform === "win32" ? "powershell" : "posix",
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-provider-recovery-"));
  const reportPath = path.join(directory, "audit.json");
  await writeFile(reportPath, JSON.stringify(targetedVerificationResult(recovery)));

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      path.resolve("packages/cli/bin/engine.js"),
      "providers",
      "--json",
      "--report",
      reportPath,
      "--recover",
      "clerk",
      "--choice",
      "show_install_instructions",
    ], { cwd: process.cwd() });
    const result = JSON.parse(stdout);
    assert.equal(stderr, "");
    assert.equal(result.status, "needs_input");
    assert.deepEqual(result.recovery.installation_instructions[0].command, {
      executable: "npm",
      arguments: ["install", "--global", "clerk@3.1.0"],
      shell: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the JSON CLI finds typed recovery in a targeted Verification Result", async () => {
  const request = createProviderAdapterPlan([
    { provider: "neon", role: "data" },
  ]).requests[0];
  const recovery = createProviderToolRecovery(request, {
    platform: process.platform,
    shell: process.platform === "win32" ? "powershell" : "posix",
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-targeted-recovery-"));
  const reportPath = path.join(directory, "verify.json");
  await writeFile(reportPath, JSON.stringify(targetedVerificationResult(recovery)));

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve("packages/cli/bin/engine.js"),
      "providers", "--json", "--report", reportPath, "--recover", "neon",
    ], { cwd: process.cwd() });
    const result = JSON.parse(stdout);
    assert.equal(result.status, "needs_input");
    assert.equal(result.recovery.provider, "neon");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the JSON CLI rejects an incomplete recovery container", async () => {
  const request = createProviderAdapterPlan([
    { provider: "clerk", role: "authentication" },
  ]).requests[0];
  const recovery = createProviderToolRecovery(request, {
    platform: process.platform,
    shell: process.platform === "win32" ? "powershell" : "posix",
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-invalid-recovery-"));
  const reportPath = path.join(directory, "invalid.json");
  await writeFile(reportPath, JSON.stringify({
    targeted_result: { provider_tool_recoveries: [recovery] },
  }));

  try {
    await assert.rejects(execFileAsync(process.execPath, [
      path.resolve("packages/cli/bin/engine.js"),
      "providers", "--json", "--report", reportPath, "--recover", "clerk",
    ], { cwd: process.cwd() }), (error) => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.status, "execution_error");
      assert.equal(result.error, "invalid_verification_result");
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
