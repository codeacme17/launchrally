import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createSecureServer } from "node:https";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";
import test from "node:test";

import {
  humanAuditPresentationOptions,
  PromptCancelledError,
  renderHumanAuditCompletion,
  runHumanAudit,
} from "../packages/cli/bin/human-audit.js";
import { createInvocationContext } from "../packages/cli/bin/invocation-context.js";
import {
  createClackPromptAdapter,
  createPlainPromptAdapter,
} from "../packages/cli/bin/prompt-adapters.js";
import {
  resumeAuthenticatedJourneyFromHost,
  runAudit,
} from "@launchrally/core";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "packages", "cli", "bin", "rally.js");

async function createFixture() {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "launchrally-human-audit-"));
  await writeFile(
    path.join(fixture, "package.json"),
    JSON.stringify({ name: "human-audit-web", scripts: { build: "vite build" } }),
  );
  await writeFile(path.join(fixture, "package-lock.json"), '{"lockfileVersion":3}');
  return fixture;
}

const VALID_ANSWERS = Object.freeze({
  intended_environment: "production",
  production_targets: ["https://example.com"],
  core_journeys: ["visitor can sign up"],
  provider_roles: [{ provider: "sentry", role: "observability" }],
  support_layers: ["monitoring"],
});

function ttyStream() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.columns = 100;
  stream.rows = 30;
  stream.setRawMode = () => stream;
  return stream;
}

function authenticatedPermissionInteraction() {
  return {
    status: "needs_permission",
    operation: "audit",
    audit_brief: {
      core_journeys: {
        values: [{
          schema_version: "launchrally.dev/protected-journey/v1",
          method: "GET",
          path: "/control",
          purpose: "authenticated Core Journey",
          access: {
            authentication_class: "staff",
            anonymous_status_codes: [401, 403, 404],
            authenticated_status_codes: [200],
          },
        }],
      },
    },
    interaction: { resume_token: "permission-token" },
    request: {
      permissions: [{
        permission_id: "authenticated_journey_verification",
        boundary: "authenticated_network_read",
        scope: {
          adapter_version: "host-agent-authenticated-journey/v1",
          operation: "read_only",
          requested_fields: [
            "journey_id",
            "status",
            "outcome",
            "status_code",
            "collected_at",
          ],
          journeys: [{
            journey_id: "target-1:journey-1:authenticated",
            target: "https://example.com/control",
            method: "GET",
            purpose: "authenticated Core Journey",
            authentication_class: "staff",
            expected_status_codes: [200],
          }],
        },
      }],
    },
  };
}

function authenticatedResultInteraction() {
  return {
    status: "needs_input",
    operation: "audit",
    interaction: { resume_token: "authenticated-token" },
    request: {
      type: "authenticated_journey_results",
      result_schema: "launchrally.dev/authenticated-journey-results/v1",
      plan: authenticatedPermissionInteraction().request.permissions[0].scope,
    },
  };
}

function assertAuthenticatedPermissionPresentation(rendered) {
  const semanticOutput = stripVTControlCharacters(rendered);
  assert.match(semanticOutput, /Authenticated Core Journey verification/u);
  assert.match(semanticOutput, /GET https:\/\/example\.com\/control/u);
  assert.match(semanticOutput, /Authentication class: staff/u);
  assert.match(semanticOutput, /Anonymous expected status: 401, 403, 404/u);
  assert.match(semanticOutput, /Authenticated expected status: 200/u);
  assert.match(
    semanticOutput,
    /Runner\/adapter version: host-agent-authenticated-journey\/v1/u,
  );
  assert.match(
    semanticOutput,
    /Retained normalized fields: journey_id, status, outcome, status_code, collected_at/u,
  );
  assert.doesNotMatch(semanticOutput, /Provider read|undefined/u);
}

async function runAuthenticatedAdapterLoop(createPrompt, approve) {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = await createPrompt({ input, output, activityDelayMs: 0 });
  const permission = authenticatedPermissionInteraction();
  const authenticatedInput = authenticatedResultInteraction();
  const completed = {
    status: "completed",
    operation: "audit",
    outcome: "audit_completed",
    report: { report_id: "report-authenticated" },
  };
  const auditCalls = [];
  const runnerCalls = [];
  setTimeout(() => approve(input), 20);

  const outcome = await runHumanAudit({
    cwd: "/workspace",
    version: "0.4.0",
    outputPath: "/workspace/report.json",
    prompt,
    runAudit: async (cwd, version, options) => {
      auditCalls.push(options);
      return auditCalls.length === 1 ? permission : authenticatedInput;
    },
    resumeAuthenticatedJourney: async (request) => {
      runnerCalls.push(request);
      return completed;
    },
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result, completed);
  assert.deepEqual(auditCalls, [undefined, {
    resume_token: "permission-token",
    permission_decisions: { authenticated_journey_verification: "approved" },
  }]);
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].resume_token, "authenticated-token");
  assert.equal(runnerCalls[0].request.type, "authenticated_journey_results");
  assertAuthenticatedPermissionPresentation(rendered);
}

test("the Human Audit completion separates its assessment, work, Report, and next command", () => {
  const summary = renderHumanAuditCompletion({
    outcome: "audit_completed",
    report: {
      assessment: "no_go",
      results: {
        checks: [{
          status: "failed",
          priority: "p0",
          check_id: "web.baseline.lockfile",
          summary: "No dependency lockfile was found.",
        }],
        verification_gaps: [{
          priority: "p1",
          check_id: "web.public.availability",
          reason: "Public verification permission was denied.",
        }],
      },
    },
    next: { type: "init" },
  }, {
    cwd: "/workspace/site",
    outputPath: "/workspace/site/audit.json",
  });
  const lines = summary.split("\n");
  const assessment = lines.indexOf("Assessment");
  const failed = lines.indexOf("Failed Findings (1)");
  const gaps = lines.indexOf("Verification Gaps (1)");
  const report = lines.indexOf("Report");
  const next = lines.indexOf("Next command");

  assert.ok(assessment < failed && failed < gaps && gaps < report && report < next);
  assert.equal(lines[assessment + 1], "No Go");
  assert.equal(lines[failed + 1], "[P0] web.baseline.lockfile");
  assert.equal(lines[failed + 2], "  No dependency lockfile was found.");
  assert.equal(lines[gaps + 1], "[P1] web.public.availability");
  assert.equal(lines[gaps + 2], "  Public verification permission was denied.");
  assert.equal(lines[report + 1], "/workspace/site/audit.json");
  assert.equal(
    lines[next + 1],
    'rally init --cwd "/workspace/site" --report "/workspace/site/audit.json"',
  );
});

test("an npm-exec Human Audit emits a complete exact-version npm-exec Init command", () => {
  const invocationContext = createInvocationContext({
    argv: ["/usr/bin/node", "/tmp/npm/_npx/hash/node_modules/.bin/rally"],
    env: {
      npm_command: "exec",
      npm_lifecycle_event: "npx",
      npm_config_package: "@launchrally/cli@0.3.2",
      PATH: "/tmp/npm/_npx/hash/node_modules/.bin:/usr/bin",
    },
    launcherVersion: "0.3.2",
  });
  const summary = renderHumanAuditCompletion({
    outcome: "audit_completed",
    report: {
      assessment: "launch_ready",
      results: { checks: [], verification_gaps: [] },
    },
    next: { type: "init" },
  }, {
    cwd: "/workspace/site with spaces",
    outputPath: "/workspace/site with spaces/audit report.json",
    invocationContext,
  });
  const expectedCommand = process.platform === "win32"
    ? "& 'npm' 'exec' '--package=@launchrally/cli@0.3.2' '--' 'rally' 'init' '--cwd' '/workspace/site with spaces' '--report' '/workspace/site with spaces/audit report.json'"
    : "npm exec --package=@launchrally/cli@0.3.2 -- rally init --cwd '/workspace/site with spaces' --report '/workspace/site with spaces/audit report.json'";

  assert.ok(summary.includes(`Next command\n${expectedCommand}`));
  assert.doesNotMatch(summary, /--yes/u);
});

test("an unknown Human Audit entry uses and discloses the executable fallback", () => {
  const summary = renderHumanAuditCompletion({
    outcome: "audit_completed",
    report: {
      assessment: "launch_ready",
      results: { checks: [], verification_gaps: [] },
    },
    next: { type: "init" },
  }, {
    cwd: "/workspace/site",
    outputPath: "/workspace/audit.json",
    invocationContext: {
      schema_version: "launchrally.dev/invocation-context/v1",
      source: "unknown",
      launcher_version: "0.3.2",
    },
  });
  const expectedCommand = process.platform === "win32"
    ? "& 'npm' 'exec' '--package=@launchrally/cli@0.3.2' '--' 'rally' 'init' '--cwd' '/workspace/site' '--report' '/workspace/audit.json'"
    : "npm exec --package=@launchrally/cli@0.3.2 -- rally init --cwd '/workspace/site' --report '/workspace/audit.json'";

  assert.ok(summary.includes(`Next command\n${expectedCommand}`));
  assert.match(summary, /Launcher entry\nThe original Launcher entry could not be confirmed/u);
});

test("the Human Audit completion labels every assessment without relying on styling", () => {
  const ansi = /\u001B\[[0-?]*[ -/]*[@-~]/gu;
  const assessments = new Map([
    ["launch_ready", "Ready"],
    ["ready_with_warnings", "Ready with Warnings"],
    ["no_go", "No Go"],
    ["inconclusive", "Inconclusive"],
  ]);

  for (const [assessment, label] of assessments) {
    const result = {
      outcome: "audit_completed",
      report: {
        assessment,
        results: { checks: [], verification_gaps: [] },
      },
    };
    const plain = renderHumanAuditCompletion(result, {
      cwd: "/workspace/site",
      styled: false,
    });
    const styled = renderHumanAuditCompletion(result, {
      cwd: "/workspace/site",
      styled: true,
    });

    assert.match(plain, new RegExp(`Assessment\\n${label}`, "u"));
    assert.doesNotMatch(plain, ansi);
    assert.match(styled, ansi);
    assert.equal(styled.replaceAll(ansi, ""), plain);
  }
});

test("the Human Audit completion wraps long item content without changing copyable values", () => {
  const outputPath = "/workspace/a-very-long-directory-name/launchrally-audit-report.json";
  const summary = renderHumanAuditCompletion({
    outcome: "audit_completed",
    report: {
      assessment: "no_go",
      results: {
        checks: [{
          status: "failed",
          priority: "p0",
          check_id: "web.public.extremely-long-production-availability-check",
          summary: "The observed public journey returned an unsuccessful response repeatedly.",
        }],
        verification_gaps: [],
      },
    },
    next: { type: "init" },
  }, {
    cwd: "/workspace/a-very-long-directory-name",
    outputPath,
    width: 32,
  });
  const command = `rally init --cwd ${JSON.stringify(
    "/workspace/a-very-long-directory-name",
  )} --report ${JSON.stringify(outputPath)}`;
  const lines = summary.split("\n");
  const failedStart = lines.indexOf("Failed Findings (1)") + 1;
  const gapsStart = lines.indexOf("Verification Gaps (0)");
  const itemLines = lines.slice(failedStart, gapsStart - 1);

  assert.ok(itemLines.length > 3);
  assert.equal(itemLines[0], "[P0]");
  assert.ok(itemLines.slice(1).every((line) => line.startsWith("  ")));
  assert.ok(itemLines.every((line) => [...line].length <= 32));
  assert.equal(lines.filter((line) => line === outputPath).length, 1);
  assert.equal(lines.filter((line) => line === command).length, 1);
});

test("the Human Audit completion honors very narrow terminal cells for wide text", () => {
  const outputPath = "/report.json";
  const summary = renderHumanAuditCompletion({
    outcome: "audit_completed",
    report: {
      assessment: "no_go",
      results: {
        checks: [{
          status: "failed",
          priority: "p0",
          check_id: "web.public.发布可用性检查",
          summary: "公共旅程返回了失败响应。",
        }],
        verification_gaps: [],
      },
    },
    next: { type: "init" },
  }, {
    cwd: "/workspace",
    outputPath,
    width: 12,
  });
  const command = 'rally init --cwd "/workspace" --report "/report.json"';
  const terminalWidth = (value) => [...value].reduce(
    (total, character) => total + (/\p{Script=Han}/u.test(character) ? 2 : 1),
    0,
  );

  for (const line of summary.split("\n")) {
    if (line === "" || line === outputPath || line === command) continue;
    assert.ok(terminalWidth(line) <= 12, `${JSON.stringify(line)} exceeds 12 cells`);
  }
  assert.match(summary, /公共旅程/u);
  assert.equal(summary.split("\n").filter((line) => line === command).length, 1);
});

test("Human Audit presentation disables ANSI for every plain or colorless environment", () => {
  const colorlessCases = [
    { args: ["--plain"], env: {}, output: { isTTY: true, columns: 72 } },
    { args: [], env: { TERM: "dumb" }, output: { isTTY: true, columns: 72 } },
    { args: [], env: { NO_COLOR: "" }, output: { isTTY: true, columns: 72 } },
    { args: [], env: {}, output: { isTTY: false, columns: 72 } },
  ];

  for (const options of colorlessCases) {
    assert.equal(humanAuditPresentationOptions(options).styled, false);
  }
  assert.deepEqual(humanAuditPresentationOptions({
    args: [],
    env: {},
    output: { isTTY: true, columns: 72 },
  }), {
    plain: false,
    styled: true,
    width: 72,
  });
  assert.equal(humanAuditPresentationOptions({
    args: ["--plain"],
    env: {},
    output: { isTTY: true },
  }).width, 80);
});

test("the Human Audit driver reports project discovery while the initial Audit runs", async () => {
  const events = [];
  const result = { status: "completed", outcome: "scope_not_confirmed" };
  const prompt = {
    async start() {
      events.push("start");
    },
    async activity(label, operation) {
      events.push(`activity:${label}`);
      const value = await operation();
      events.push("activity:completed");
      return value;
    },
    async close() {
      events.push("close");
    },
  };

  const outcome = await runHumanAudit({
    cwd: "/workspace",
    version: "0.1.0",
    prompt,
    runAudit: async () => {
      events.push("audit");
      return result;
    },
  });

  assert.equal(outcome.result, result);
  assert.deepEqual(events, [
    "start",
    "activity:Discovering project and scanning repository…",
    "audit",
    "activity:completed",
    "close",
  ]);
});

test("the Human Audit driver updates feedback across every resumable Audit phase", async () => {
  const activityLabels = [];
  const results = [
    {
      status: "needs_input",
      interaction: { resume_token: "input-token" },
    },
    {
      status: "needs_confirmation",
      interaction: { resume_token: "confirmation-token" },
    },
    {
      status: "needs_permission",
      interaction: { resume_token: "permission-token" },
      request: {
        permissions: [{
          permission_id: "provider_read:cloudflare",
          boundary: "provider_read",
          scope: { provider: "cloudflare" },
        }],
      },
    },
    { status: "completed", outcome: "audit_completed" },
  ];
  const prompt = {
    async start() {},
    async activity(label, operation) {
      activityLabels.push(label);
      return operation();
    },
    async respond(result) {
      if (result.status === "needs_input") return { answers: {} };
      if (result.status === "needs_confirmation") return { confirmation: "confirm" };
      return {
        permission_decisions: { "provider_read:cloudflare": "approved" },
      };
    },
    async close() {},
  };

  await runHumanAudit({
    cwd: "/workspace",
    version: "0.1.0",
    prompt,
    runAudit: async () => results.shift(),
  });

  assert.deepEqual(activityLabels, [
    "Discovering project and scanning repository…",
    "Updating project scan and Audit Brief…",
    "Preparing Audit permission requests…",
    "Reading Cloudflare Provider data and generating Report…",
  ]);
});

test("the Plain adapter completes the protected Journey permission and runner loop", async () => {
  await runAuthenticatedAdapterLoop(
    (options) => createPlainPromptAdapter(options),
    (input) => input.write("y\n"),
  );
});

test("the Clack adapter completes the protected Journey permission and runner loop", async () => {
  await runAuthenticatedAdapterLoop(
    (options) => createClackPromptAdapter(options),
    (input) => input.write("\u001b[D\r"),
  );
});

test("the Human Audit driver routes authenticated result requests only to the trusted runner", async () => {
  const activityLabels = [];
  const authenticatedRequest = {
    type: "authenticated_journey_results",
    result_schema: "launchrally.dev/authenticated-journey-results/v1",
    plan: {
      adapter_version: "host-agent-authenticated-journey/v1",
      journeys: [],
    },
  };
  const results = [
    {
      status: "needs_permission",
      interaction: { resume_token: "permission-token" },
      request: {
        permissions: [{
          permission_id: "authenticated_journey_verification",
          boundary: "authenticated_network_read",
          scope: { adapter_version: "host-agent-authenticated-journey/v1" },
        }],
      },
    },
    {
      status: "needs_input",
      interaction: { resume_token: "authenticated-token" },
      request: authenticatedRequest,
    },
  ];
  const completed = {
    status: "completed",
    outcome: "audit_completed",
    report: { report_id: "report-authenticated" },
  };
  const promptStates = [];
  const runnerRequests = [];

  const outcome = await runHumanAudit({
    cwd: "/workspace",
    version: "0.4.0",
    outputPath: "/workspace/report.json",
    prompt: {
      async start() {},
      async activity(label, operation) {
        activityLabels.push(label);
        return operation(new AbortController().signal);
      },
      async respond(result) {
        promptStates.push(result.status);
        return {
          permission_decisions: {
            authenticated_journey_verification: "approved",
          },
        };
      },
      async close() {},
    },
    runAudit: async () => results.shift(),
    resumeAuthenticatedJourney: async (request) => {
      runnerRequests.push(request);
      return completed;
    },
  });

  assert.equal(outcome.result, completed);
  assert.deepEqual(promptStates, ["needs_permission"]);
  assert.deepEqual(runnerRequests, [{
    cwd: "/workspace",
    version: "0.4.0",
    operation: "audit",
    resume_token: "authenticated-token",
    request: authenticatedRequest,
    signal: runnerRequests[0].signal,
  }]);
  assert.equal(runnerRequests[0].signal.aborted, false);
  assert.deepEqual(activityLabels, [
    "Discovering project and scanning repository…",
    "Preparing authenticated Core Journey verification…",
    "Verifying authenticated Core Journeys and generating Report…",
    "Saving Audit Report…",
  ]);
});

test("the Human Audit driver completes an invalid trusted runner result as a typed error", async () => {
  const request = {
    type: "authenticated_journey_results",
    result_schema: "launchrally.dev/authenticated-journey-results/v1",
    plan: { adapter_version: "host-agent-authenticated-journey/v1", journeys: [] },
  };
  const outcome = await runHumanAudit({
    cwd: "/workspace",
    version: "0.4.0",
    prompt: {
      async start() {},
      async respond() {
        throw new Error("authenticated results must not be collected as release intent");
      },
      async close() {},
    },
    runAudit: async () => ({
      status: "needs_input",
      interaction: { resume_token: "authenticated-token" },
      request,
    }),
    resumeAuthenticatedJourney: async () => ({
      status: "needs_input",
      operation: "audit",
      request: {
        ...request,
        validation_errors: [{
          field_id: "journey_results",
          code: "invalid_authenticated_journey_results",
        }],
      },
    }),
  });

  assert.equal(outcome.exitCode, 2);
  assert.deepEqual(outcome.result, {
    status: "execution_error",
    operation: "audit",
    error: "invalid_authenticated_journey_results",
    message: "The trusted authenticated Core Journey runner returned an invalid normalized result.",
  });
});

test("the Human Audit driver completes an unavailable trusted runner as a typed error", async () => {
  const outcome = await runHumanAudit({
    cwd: "/workspace",
    version: "0.4.0",
    prompt: {
      async start() {},
      async respond() {
        throw new Error("authenticated results must not be collected as release intent");
      },
      async close() {},
    },
    runAudit: async () => ({
      status: "needs_input",
      interaction: { resume_token: "authenticated-token" },
      request: {
        type: "authenticated_journey_results",
        result_schema: "launchrally.dev/authenticated-journey-results/v1",
        plan: { adapter_version: "host-agent-authenticated-journey/v1", journeys: [] },
      },
    }),
    resumeAuthenticatedJourney: async () => undefined,
  });

  assert.equal(outcome.exitCode, 2);
  assert.deepEqual(outcome.result, {
    status: "execution_error",
    operation: "audit",
    error: "authenticated_journey_runner_unavailable",
    message: "The trusted authenticated Core Journey runner could not complete safely.",
  });
});

test("the Human Audit driver preserves cancellation from the authenticated runner", async () => {
  let closed = false;
  const outcome = await runHumanAudit({
    cwd: "/workspace",
    version: "0.4.0",
    prompt: {
      async start() {},
      async respond() {
        throw new Error("authenticated results must not be collected as release intent");
      },
      async close() {
        closed = true;
      },
    },
    runAudit: async () => ({
      status: "needs_input",
      interaction: { resume_token: "authenticated-token" },
      request: {
        type: "authenticated_journey_results",
        result_schema: "launchrally.dev/authenticated-journey-results/v1",
        plan: { adapter_version: "host-agent-authenticated-journey/v1", journeys: [] },
      },
    }),
    resumeAuthenticatedJourney: async () => {
      throw new PromptCancelledError();
    },
  });

  assert.deepEqual(outcome, { exitCode: 130, result: null, outputPath: undefined });
  assert.equal(closed, true);
});

test("the Human Audit driver distinguishes interaction failures from Local Safe Scan failures", async () => {
  const interactionFailure = new Error("prompt adapter failed");
  await assert.rejects(runHumanAudit({
    cwd: "/workspace",
    version: "0.4.0",
    prompt: {
      async start() {},
      async respond() {
        throw interactionFailure;
      },
      async close() {},
    },
    runAudit: async () => ({
      status: "needs_input",
      request: { type: "release_intent", fields: [], validation_errors: [] },
    }),
  }), (error) => {
    assert.equal(error, interactionFailure);
    assert.equal(error.code, "human_audit_interaction_failed");
    return true;
  });

  const scanFailure = new Error("repository scan failed");
  scanFailure.code = "repository_read_failed";
  await assert.rejects(runHumanAudit({
    cwd: "/workspace",
    version: "0.4.0",
    prompt: {
      async start() {},
      async close() {},
    },
    runAudit: async () => {
      throw scanFailure;
    },
  }), (error) => {
    assert.equal(error, scanFailure);
    assert.equal(error.code, "local_safe_scan_failed");
    return true;
  });
});

test("the trusted Human Audit runner completes missing authentication as a Verification Gap", async () => {
  const fixture = await createFixture();
  const previousOrigin = process.env.LAUNCHRALLY_AUTHENTICATED_ORIGIN;
  const previousAuthorization = process.env.LAUNCHRALLY_HOST_AUTHORIZATION_FILE;
  const previousCookie = process.env.LAUNCHRALLY_HOST_COOKIE_FILE;
  delete process.env.LAUNCHRALLY_AUTHENTICATED_ORIGIN;
  delete process.env.LAUNCHRALLY_HOST_AUTHORIZATION_FILE;
  delete process.env.LAUNCHRALLY_HOST_COOKIE_FILE;
  try {
    const promptStates = [];
    const outcome = await runHumanAudit({
      cwd: fixture,
      version: "0.4.0",
      prompt: {
        async start() {},
        async respond(result) {
          promptStates.push(result.request?.type ?? result.status);
          if (result.status === "needs_input") {
            return {
              answers: {
                intended_environment: "staging",
                production_targets: ["https://example.com"],
                core_journeys: [{
                  schema_version: "launchrally.dev/protected-journey/v1",
                  method: "GET",
                  path: "/control",
                  purpose: "authenticated Core Journey",
                  access: {
                    authentication_class: "staff",
                    anonymous_status_codes: [401, 403, 404],
                    authenticated_status_codes: [200],
                  },
                }],
                provider_roles: [],
                support_layers: [],
              },
            };
          }
          if (result.status === "needs_confirmation") return { confirmation: "confirm" };
          if (result.status === "needs_permission") {
            return {
              permission_decisions: {
                public_verification: "denied",
                authenticated_journey_verification: "approved",
              },
            };
          }
          return {};
        },
        async close() {},
      },
      runAudit,
      resumeAuthenticatedJourney: (options) => resumeAuthenticatedJourneyFromHost({
        ...options,
        host: "cli",
      }),
    });

    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.result.status, "completed");
    assert.ok(outcome.result.report);
    assert.ok(outcome.result.report.results.authenticated_journey_gaps.some(
      ({ outcome: reasonCode }) => reasonCode === "missing_authentication",
    ));
    assert.doesNotMatch(JSON.stringify(outcome.result), /bearer\s|cookie|headers|response_body/iu);
    assert.equal(promptStates.includes("authenticated_journey_results"), false);
  } finally {
    if (previousOrigin === undefined) delete process.env.LAUNCHRALLY_AUTHENTICATED_ORIGIN;
    else process.env.LAUNCHRALLY_AUTHENTICATED_ORIGIN = previousOrigin;
    if (previousAuthorization === undefined) delete process.env.LAUNCHRALLY_HOST_AUTHORIZATION_FILE;
    else process.env.LAUNCHRALLY_HOST_AUTHORIZATION_FILE = previousAuthorization;
    if (previousCookie === undefined) delete process.env.LAUNCHRALLY_HOST_COOKIE_FILE;
    else process.env.LAUNCHRALLY_HOST_COOKIE_FILE = previousCookie;
  }
});

test("the trusted Human Audit runner completes a valid authenticated result as a Report", async () => {
  const fixture = await createFixture();
  const authorizationRoot = await mkdtemp(path.join(os.tmpdir(), "launchrally-human-auth-"));
  const authorizationFile = path.join(authorizationRoot, "authorization");
  await writeFile(authorizationFile, "Bearer human-mode-secret", { mode: 0o600 });
  const server = createSecureServer({
    key: await readFile(path.join(root, "test/fixtures/self-signed-key.pem")),
    cert: await readFile(path.join(root, "test/fixtures/self-signed-cert.pem")),
  }, (request, response) => {
    response.writeHead(200);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const target = `https://localhost:${server.address().port}`;
  const environment = {
    LAUNCHRALLY_AUTHENTICATED_ORIGIN: process.env.LAUNCHRALLY_AUTHENTICATED_ORIGIN,
    LAUNCHRALLY_HOST_AUTHORIZATION_FILE: process.env.LAUNCHRALLY_HOST_AUTHORIZATION_FILE,
    LAUNCHRALLY_HOST_CA_FILE: process.env.LAUNCHRALLY_HOST_CA_FILE,
  };
  process.env.LAUNCHRALLY_AUTHENTICATED_ORIGIN = target;
  process.env.LAUNCHRALLY_HOST_AUTHORIZATION_FILE = authorizationFile;
  process.env.LAUNCHRALLY_HOST_CA_FILE = path.join(root, "test/fixtures/self-signed-cert.pem");
  try {
    const outcome = await runHumanAudit({
      cwd: fixture,
      version: "0.4.0",
      prompt: {
        async start() {},
        async respond(result) {
          if (result.status === "needs_input") {
            return {
              answers: {
                intended_environment: "staging",
                production_targets: [target],
                core_journeys: [{
                  schema_version: "launchrally.dev/protected-journey/v1",
                  method: "GET",
                  path: "/control",
                  purpose: "authenticated Core Journey",
                  access: {
                    authentication_class: "staff",
                    anonymous_status_codes: [401, 403, 404],
                    authenticated_status_codes: [200],
                  },
                }],
                provider_roles: [],
                support_layers: [],
              },
            };
          }
          if (result.status === "needs_confirmation") return { confirmation: "confirm" };
          if (result.status === "needs_permission") {
            return {
              permission_decisions: {
                public_verification: "denied",
                authenticated_journey_verification: "approved",
              },
            };
          }
          return {};
        },
        async close() {},
      },
      runAudit,
      resumeAuthenticatedJourney: (options) => resumeAuthenticatedJourneyFromHost({
        ...options,
        host: "cli",
      }),
    });

    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.result.status, "completed");
    assert.ok(outcome.result.report);
    assert.equal(outcome.result.report.results.authenticated_journey_evidence_refs.length, 1);
    assert.equal(outcome.result.report.results.authenticated_journey_gaps.length, 0);
    assert.doesNotMatch(
      JSON.stringify(outcome.result),
      /human-mode-secret|bearer\s|cookie|headers|response_body|account_id/iu,
    );
  } finally {
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(authorizationRoot, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the Human Audit driver retries Core validation and denies each permission by default", async () => {
  const fixture = await createFixture();
  const events = [];
  const answerQueue = [
    { ...VALID_ANSWERS, production_targets: [] },
    VALID_ANSWERS,
  ];
  const prompt = {
    async start() {
      events.push("start");
    },
    async respond(result) {
      if (result.status === "needs_input") {
        if (result.request.validation_errors.length > 0) {
          const [error] = result.request.validation_errors;
          events.push(`validation:${error.field_id}:${error.code}`);
        }
        events.push("answers");
        return { answers: answerQueue.shift() };
      }
      if (result.status === "needs_confirmation") {
        events.push("confirm");
        return { confirmation: "confirm" };
      }
      if (result.status === "needs_permission") {
        const permissionDecisions = Object.fromEntries(
          result.request.permissions.map((permission) => {
            events.push(`permission:${permission.permission_id}`);
            return [permission.permission_id, "denied"];
          }),
        );
        return { permission_decisions: permissionDecisions };
      }
      events.push("save");
      return {};
    },
    async close() {
      events.push("close");
    },
  };

  const outcome = await runHumanAudit({
    cwd: fixture,
    version: "0.1.0",
    prompt,
    runAudit,
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.status, "completed");
  assert.equal(outcome.result.outcome, "audit_completed");
  assert.deepEqual(
    outcome.result.report.scope.release_intent.support_layers,
    ["observability"],
  );
  assert.equal(
    outcome.result.report.results.checks.find(
      (check) => check.check_id === "web.baseline.observability",
    ).status,
    "unverified",
  );
  assert.deepEqual(
    outcome.result.authorization_plan.map(({ permission_id, decision }) => ({
      permission_id,
      decision,
    })),
    [
      { permission_id: "local_safe_scan", decision: "granted" },
      { permission_id: "public_verification", decision: "denied" },
      { permission_id: "provider_read:sentry", decision: "denied" },
    ],
  );
  assert.deepEqual(events, [
    "start",
    "answers",
    "validation:production_targets:required",
    "answers",
    "confirm",
    "permission:public_verification",
    "permission:provider_read:sentry",
    "save",
    "close",
  ]);
  assert.deepEqual(await readdir(fixture), ["package-lock.json", "package.json"]);
  const summary = renderHumanAuditCompletion(outcome.result, { cwd: fixture });
  assert.match(summary, /Assessment\n/u);
  assert.match(summary, /Failed Findings \(\d+\)\n/u);
  assert.match(summary, /Verification Gaps \(\d+\)\n/u);
  assert.match(summary, /Next command\nrally init .*--report <saved-report-path>/u);
  assert.doesNotMatch(summary, /No input or approval is required for this local-only Audit/u);
  assert.doesNotMatch(summary, /# LaunchRally Audit Report/u);
});

test("the Human Audit driver revises unknown support layers and preserves explicit absence", async () => {
  const fixture = await createFixture();
  const answerQueue = [
    { ...VALID_ANSWERS, support_layers: ["unknown incident service"] },
    { ...VALID_ANSWERS, provider_roles: [], support_layers: [] },
  ];
  const validationErrors = [];
  const prompt = {
    async start() {},
    async respond(result) {
      if (result.status === "needs_input") {
        validationErrors.push(...result.request.validation_errors);
        return { answers: answerQueue.shift() };
      }
      if (result.status === "needs_confirmation") return { confirmation: "confirm" };
      if (result.status === "needs_permission") {
        return {
          permission_decisions: Object.fromEntries(
            result.request.permissions.map(({ permission_id: permissionId }) => [
              permissionId,
              "denied",
            ]),
          ),
        };
      }
      return {};
    },
    async close() {},
  };

  const outcome = await runHumanAudit({
    cwd: fixture,
    version: "0.1.0",
    prompt,
    runAudit,
  });

  assert.deepEqual(validationErrors, [
    {
      field_id: "support_layers",
      code: "unsupported_support_layer",
      supported_categories: ["analytics", "observability"],
      guidance: "Choose a supported category or revise the support-layer selection.",
    },
  ]);
  const check = outcome.result.report.results.checks.find(
    (candidate) => candidate.check_id === "web.baseline.observability",
  );
  assert.equal(check.status, "not_applicable");
  assert.equal(check.applicability.status, "not_applicable");
  assert.ok(check.applicability.evidence.length > 0);
});

test("the Human Audit driver supports revision and cancellation without granting permission", async () => {
  const fixture = await createFixture();
  const states = [];
  const confirmations = ["revise", "cancel"];
  const prompt = {
    async start() {},
    async respond(result) {
      states.push(result.status);
      if (result.status === "needs_input") return { answers: VALID_ANSWERS };
      return { confirmation: confirmations.shift() };
    },
    async close() {},
  };

  const outcome = await runHumanAudit({
    cwd: fixture,
    version: "0.1.0",
    prompt,
    runAudit,
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.outcome, "scope_not_confirmed");
  assert.ok(outcome.result.report);
  assert.equal(outcome.result.report.scope.release_intent.confirmed, false);
  assert.ok(outcome.result.authorization_plan.every(
    (permission) => permission.decision === "granted" || permission.decision === "pending",
  ));
  assert.deepEqual(states, [
    "needs_input",
    "needs_confirmation",
    "needs_input",
    "needs_confirmation",
    "completed",
  ]);
  const summary = renderHumanAuditCompletion(outcome.result, { cwd: fixture });
  assert.equal(outcome.result.next.type, "init");
  assert.match(summary, /Audit Brief was not confirmed/u);
  assert.match(summary, /Next command\nrally init --cwd/u);
  assert.deepEqual(await readdir(fixture), ["package-lock.json", "package.json"]);
});

test("a Human Audit discloses and writes the deterministic default Report path", async () => {
  const fixture = await createFixture();
  const requestedPath = path.join(fixture, "launchrally-audit-report.json");
  let saved;
  const saveRequests = [];
  const prompt = {
    async start() {},
    async respond(result) {
      if (result.status === "needs_input") return { answers: VALID_ANSWERS };
      if (result.status === "needs_confirmation") return { confirmation: "confirm" };
      if (result.status === "needs_permission") {
        return {
          permission_decisions: Object.fromEntries(
            result.request.permissions.map(({ permission_id }) => [permission_id, "denied"]),
          ),
        };
      }
      return {};
    },
    async reportSave(request) {
      saveRequests.push(request);
      if (request.phase === "choose") {
        return { output_path: request.suggested_path, suggested: true };
      }
      return { decision: "save" };
    },
    async close() {},
  };

  const outcome = await runHumanAudit({
    cwd: fixture,
    version: "0.1.0",
    prompt,
    runAudit,
    inspectDestination: async () => ({ valid: true, collision: false }),
    saveResult: async (outputPath, result) => {
      saved = { outputPath, result };
      return path.resolve(outputPath);
    },
  });

  assert.equal(outcome.outputPath, requestedPath);
  assert.equal(saved.outputPath, requestedPath);
  assert.equal(saved.result.report.report_id, outcome.result.report.report_id);
  assert.deepEqual(saveRequests, [{
    phase: "choose",
    suggested_path: requestedPath,
    file_picker_available: false,
  }]);
  assert.match(
    renderHumanAuditCompletion(outcome.result, {
      cwd: fixture,
      outputPath: outcome.outputPath,
    }),
    /Next command\nrally init .*--report/u,
  );
});

test("a Human Audit lets the builder choose another path after a collision", async () => {
  const cwd = path.resolve("/workspace");
  const suggestedPath = path.join(cwd, "launchrally-audit-report.json");
  const customPath = path.join(cwd, "reports", "custom.json");
  const requests = [];
  const responses = [
    { output_path: suggestedPath },
    { decision: "choose_another" },
    { output_path: customPath },
    { decision: "save" },
  ];
  let saved;
  const result = {
    status: "completed",
    report: { report_id: "report-1" },
  };

  const outcome = await runHumanAudit({
    cwd,
    version: "0.1.0",
    prompt: {
      async start() {},
      async respond() {
        throw new Error("Core prompting was not expected.");
      },
      async reportSave(request) {
        requests.push(request);
        return responses.shift();
      },
      async close() {},
    },
    runAudit: async () => result,
    inspectDestination: async (outputPath) => ({
      valid: true,
      collision: outputPath === suggestedPath,
    }),
    saveResult: async (outputPath) => {
      saved = outputPath;
      return outputPath;
    },
  });

  assert.equal(outcome.outputPath, customPath);
  assert.equal(saved, customPath);
  assert.deepEqual(requests.map((request) => ({
    phase: request.phase,
    collision: request.collision,
    resolved_path: request.resolved_path,
  })), [
    { phase: "choose", collision: undefined, resolved_path: undefined },
    { phase: "confirm", collision: true, resolved_path: suggestedPath },
    { phase: "choose", collision: undefined, resolved_path: undefined },
    { phase: "confirm", collision: false, resolved_path: customPath },
  ]);
});

test("a cancelled system file picker returns to the confirmed save menu", async () => {
  const cwd = path.resolve("/workspace");
  const customPath = path.join(cwd, "custom.json");
  const chooseRequests = [];
  const responses = [
    { file_picker: true },
    { output_path: customPath },
    { decision: "save" },
  ];
  let pickerCalls = 0;

  const outcome = await runHumanAudit({
    cwd,
    version: "0.1.0",
    prompt: {
      async start() {},
      async respond() {
        throw new Error("Core prompting was not expected.");
      },
      async reportSave(request) {
        if (request.phase === "choose") chooseRequests.push(request);
        return responses.shift();
      },
      async close() {},
    },
    runAudit: async () => ({ status: "completed", report: { report_id: "report-1" } }),
    filePicker: {
      async availability() {
        return { available: true, provider: "osascript" };
      },
      async chooseSavePath() {
        pickerCalls += 1;
        return null;
      },
    },
    inspectDestination: async () => ({ valid: true, collision: false }),
    saveResult: async (outputPath) => outputPath,
  });

  assert.equal(outcome.outputPath, customPath);
  assert.equal(pickerCalls, 1);
  assert.equal(chooseRequests.length, 2);
  assert.equal(chooseRequests[0].file_picker_available, true);
  assert.equal(chooseRequests[0].save_confirmed, undefined);
  assert.equal(chooseRequests[1].save_confirmed, true);
});

test("a Human Audit reports system and file work while saving its Report", async () => {
  const requestedPath = path.resolve("/workspace/report.json");
  const activityLabels = [];
  const responses = [
    { file_picker: true },
    { decision: "save" },
  ];

  const outcome = await runHumanAudit({
    cwd: "/workspace",
    version: "0.1.0",
    prompt: {
      async start() {},
      async activity(label, operation) {
        activityLabels.push(label);
        return operation();
      },
      async respond() {},
      async reportSave() {
        return responses.shift();
      },
      async close() {},
    },
    runAudit: async () => ({
      status: "completed",
      report: { report_id: "report-1" },
    }),
    filePicker: {
      async availability() {
        return { available: true };
      },
      async chooseSavePath() {
        return requestedPath;
      },
    },
    inspectDestination: async () => ({ valid: true, collision: false }),
    saveResult: async (outputPath) => outputPath,
  });

  assert.equal(outcome.outputPath, requestedPath);
  assert.deepEqual(activityLabels, [
    "Discovering project and scanning repository…",
    "Checking Report save options…",
    "Opening system file picker…",
    "Checking Report destination…",
    "Saving Audit Report…",
  ]);
});

test("a Human Audit cancels cleanly when system work is interrupted", async () => {
  const events = [];
  const outcome = await runHumanAudit({
    cwd: "/workspace",
    version: "0.1.0",
    prompt: {
      async start() {},
      async activity(label, operation) {
        events.push(label);
        if (label === "Opening system file picker…") {
          throw new PromptCancelledError();
        }
        return operation();
      },
      async reportSave() {
        return events.includes("Opening system file picker…")
          ? {}
          : { file_picker: true };
      },
      async close() {
        events.push("close");
      },
    },
    runAudit: async () => ({
      status: "completed",
      report: { report_id: "report-1" },
    }),
    filePicker: {
      async availability() {
        return { available: true };
      },
      async chooseSavePath() {
        throw new Error("should be wrapped by the activity seam");
      },
    },
  });

  assert.equal(outcome.exitCode, 130);
  assert.equal(outcome.result, null);
  assert.equal(events.at(-1), "close");
});

test("a cancelled Human Audit aborts saving before returning without detached side effects", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const signals = new EventEmitter();
  const prompt = createPlainPromptAdapter({ input, output, signals, activityDelayMs: 0 });
  let sideEffect = false;
  let saveSettled = false;

  const audit = runHumanAudit({
    cwd: "/workspace",
    version: "0.1.0",
    outputPath: "/workspace/report.json",
    prompt,
    runAudit: async () => ({
      status: "completed",
      report: { report_id: "report-1" },
    }),
    saveResult: async (outputPath, result, options, { signal } = {}) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          sideEffect = true;
          saveSettled = true;
          resolve(outputPath);
        }, 50);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          saveSettled = true;
          const error = new Error("The save was aborted.");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      }),
  });
  setTimeout(() => signals.emit("SIGINT"), 10);

  const outcome = await audit;
  await new Promise((resolve) => setTimeout(resolve, 70));

  assert.equal(outcome.exitCode, 130);
  assert.equal(saveSettled, true);
  assert.equal(sideEffect, false);
  assert.equal(signals.listenerCount("SIGINT"), 0);
});

test("a Human Audit aborts a cooperative Core run promptly on SIGINT", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const signals = new EventEmitter();
  const prompt = createPlainPromptAdapter({ input, output, signals, activityDelayMs: 0 });
  let startAudit;
  const auditStarted = new Promise((resolve) => {
    startAudit = resolve;
  });
  let coreSettled = false;
  const audit = runHumanAudit({
    cwd: "/workspace",
    version: "0.1.0",
    prompt,
    runAudit: async (cwd, version, interactionOptions, { signal } = {}) =>
      new Promise((resolve, reject) => {
        startAudit();
        const abort = () => {
          coreSettled = true;
          reject(signal.reason);
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }),
  });

  await auditStarted;
  signals.emit("SIGINT");
  const outcome = await Promise.race([
    audit,
    new Promise((resolve, reject) => setTimeout(
      () => reject(new Error("Human Audit did not cancel promptly")),
      100,
    )),
  ]);

  assert.equal(outcome.exitCode, 130);
  assert.equal(coreSettled, true);
  assert.equal(signals.listenerCount("SIGINT"), 0);
});

test("a Human Audit overwrites a collision only after a separate explicit decision", async () => {
  const cwd = path.resolve("/workspace");
  const requestedPath = path.join(cwd, "launchrally-audit-report.json");
  const responses = [
    { output_path: requestedPath },
    { decision: "overwrite" },
  ];
  let saveOptions;

  const outcome = await runHumanAudit({
    cwd,
    version: "0.1.0",
    prompt: {
      async start() {},
      async respond() {},
      async reportSave() {
        return responses.shift();
      },
      async close() {},
    },
    runAudit: async () => ({ status: "completed", report: { report_id: "report-1" } }),
    inspectDestination: async () => ({ valid: true, collision: true }),
    saveResult: async (outputPath, result, options) => {
      saveOptions = options;
      return outputPath;
    },
  });

  assert.equal(outcome.outputPath, requestedPath);
  assert.deepEqual(saveOptions, { overwrite: true });
});

test("an explicit --output path keeps its non-interactive exclusive-write behavior", async () => {
  const requestedPath = path.resolve("/workspace/provided.json");
  let saveOptions;

  const outcome = await runHumanAudit({
    cwd: "/workspace",
    version: "0.1.0",
    outputPath: requestedPath,
    prompt: {
      async start() {},
      async respond() {
        throw new Error("--output must not prompt for a save destination.");
      },
      async reportSave() {
        throw new Error("--output must not prompt for a save destination.");
      },
      async close() {},
    },
    runAudit: async () => ({ status: "completed", report: { report_id: "report-1" } }),
    inspectDestination: async () => {
      throw new Error("--output must not preflight collisions interactively.");
    },
    saveResult: async (outputPath, result, options) => {
      saveOptions = options;
      return outputPath;
    },
  });

  assert.equal(outcome.outputPath, requestedPath);
  assert.deepEqual(saveOptions, { overwrite: false });
});

test("a Human Audit rejects reserved and unusable Report destinations", async () => {
  const cwd = path.resolve("/workspace");
  const reservedPath = path.join(cwd, ".launchrally", "report.json");
  const unusablePath = path.join(cwd, "missing", "report.json");
  const validPath = path.join(cwd, "report.json");
  const responses = [
    { output_path: reservedPath },
    { output_path: unusablePath },
    { output_path: validPath },
    { decision: "save" },
  ];
  const chooseRequests = [];
  const inspected = [];

  const outcome = await runHumanAudit({
    cwd,
    version: "0.1.0",
    prompt: {
      async start() {},
      async respond() {},
      async reportSave(request) {
        if (request.phase === "choose") chooseRequests.push(request);
        return responses.shift();
      },
      async close() {},
    },
    runAudit: async () => ({ status: "completed", report: { report_id: "report-1" } }),
    inspectDestination: async (outputPath) => {
      inspected.push(outputPath);
      return outputPath === unusablePath
        ? { valid: false, reason: "parent_unavailable" }
        : { valid: true, collision: false };
    },
    saveResult: async (outputPath) => outputPath,
  });

  assert.equal(outcome.outputPath, validPath);
  assert.deepEqual(inspected, [unusablePath, validPath]);
  assert.match(chooseRequests[1].notice, /\.launchrally/u);
  assert.match(chooseRequests[2].notice, /not usable/u);
  assert.equal(chooseRequests[1].save_confirmed, true);
  assert.equal(chooseRequests[2].save_confirmed, true);
});

test("an interrupted Human Audit closes its prompt and returns exit code 130 without repository writes", async () => {
  const fixture = await createFixture();
  const before = await readdir(fixture);
  const events = [];
  const prompt = {
    async start() {
      events.push("start");
    },
    async respond() {
      events.push("interrupt");
      throw new PromptCancelledError();
    },
    async close() {
      events.push("close");
    },
  };

  const outcome = await runHumanAudit({
    cwd: fixture,
    version: "0.1.0",
    prompt,
    runAudit,
  });

  assert.equal(outcome.exitCode, 130);
  assert.equal(outcome.result, null);
  assert.deepEqual(events, ["start", "interrupt", "close"]);
  assert.deepEqual(await readdir(fixture), before);
});

test("non-TTY Human Mode exits promptly with Agent Mode guidance and no resume token", async () => {
  const fixture = await createFixture();

  await assert.rejects(
    execFileAsync(process.execPath, [cli, "audit", "--cwd", fixture], { cwd: root }),
    (error) => {
      assert.equal(error.code, 2);
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /Non-TTY Human Mode cannot prompt safely/u);
      assert.match(error.stderr, /rally audit --json/u);
      assert.doesNotMatch(error.stderr, /resume token/iu);
      return true;
    },
  );
});

test("Agent Mode emits exactly one structured result without initializing prompt output", async () => {
  const fixture = await createFixture();
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [cli, "audit", "--json", "--cwd", fixture],
    { cwd: root },
  );

  const result = JSON.parse(stdout);
  assert.equal(result.contract, "launchrally.dev/cli/v2");
  assert.equal(result.status, "needs_input");
  assert.equal(stderr, "");
  assert.equal(stdout.trim().split("\n").filter((line) => line === "{").length, 1);
});
