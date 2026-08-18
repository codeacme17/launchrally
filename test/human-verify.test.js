import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import { PromptCancelledError } from "../packages/cli/bin/human-audit.js";
import { runHumanVerify } from "../packages/cli/bin/human-verify.js";
import {
  createClackPromptAdapter,
  createPlainPromptAdapter,
} from "../packages/cli/bin/prompt-adapters.js";

function ttyStream() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.columns = 100;
  stream.rows = 30;
  stream.setRawMode = () => stream;
  return stream;
}

test("the Human Verify driver accepts fresh permissions and completes in one process", async () => {
  const results = [
    {
      status: "needs_permission",
      operation: "verify",
      interaction: { resume_token: "permission-token" },
      request: {
        permissions: [{
          permission_id: "public_verification",
          boundary: "public_network",
          decision: "pending",
        }],
      },
    },
    {
      status: "completed",
      operation: "verify",
      outcome: "verification_completed",
    },
  ];
  const calls = [];
  const events = [];
  const outcome = await runHumanVerify({
    cwd: "relative-workspace",
    version: "0.4.0",
    reportPackage: { report: { report_id: "report-1" } },
    scope: "full",
    checkIds: undefined,
    prompt: {
      async start(operation) {
        events.push(`start:${operation}`);
      },
      async respondVerify(result) {
        events.push(`respond:${result.status}`);
        return { permission_decisions: { public_verification: "denied" } };
      },
      async close() {
        events.push("close");
      },
    },
    runVerify: async (cwd, version, options) => {
      calls.push({ cwd, version, options });
      return results.shift();
    },
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.status, "completed");
  assert.deepEqual(calls, [
    {
      cwd: "relative-workspace",
      version: "0.4.0",
      options: {
        report_package: { report: { report_id: "report-1" } },
        scope: "full",
        check_ids: undefined,
      },
    },
    {
      cwd: "relative-workspace",
      version: "0.4.0",
      options: {
        resume_token: "permission-token",
        permission_decisions: { public_verification: "denied" },
      },
    },
  ]);
  assert.deepEqual(events, [
    "start:verify",
    "respond:needs_permission",
    "close",
  ]);
});

test("the Human Verify driver routes authenticated result requests only to the trusted runner", async () => {
  const permission = {
    status: "needs_permission",
    operation: "verify",
    interaction: { resume_token: "permission-token" },
    request: {
      permissions: [{
        permission_id: "authenticated_journey_verification",
        boundary: "authenticated_network_read",
        decision: "pending",
      }],
    },
  };
  const authenticatedInput = {
    status: "needs_input",
    operation: "verify",
    interaction: { resume_token: "authenticated-token" },
    request: {
      type: "authenticated_journey_results",
      plan: { schema_version: "launchrally.dev/authenticated-journey-plan/v1" },
    },
  };
  const completed = {
    status: "completed",
    operation: "verify",
    outcome: "verification_completed",
  };
  const promptStates = [];
  const runnerCalls = [];
  let verifyCalls = 0;

  const outcome = await runHumanVerify({
    cwd: "/workspace/project",
    version: "0.4.0",
    reportPackage: { report: { report_id: "report-1" } },
    scope: "full",
    prompt: {
      async start() {},
      async respondVerify(result) {
        promptStates.push(result.status);
        return {
          permission_decisions: {
            authenticated_journey_verification: "approved",
          },
        };
      },
      async close() {},
    },
    runVerify: async () => {
      verifyCalls += 1;
      return verifyCalls === 1 ? permission : authenticatedInput;
    },
    resumeAuthenticatedJourney: async (options) => {
      runnerCalls.push(options);
      return completed;
    },
  });

  assert.equal(outcome.result, completed);
  assert.deepEqual(promptStates, ["needs_permission"]);
  assert.deepEqual(runnerCalls, [{
    cwd: "/workspace/project",
    version: "0.4.0",
    operation: "verify",
    resume_token: "authenticated-token",
    request: authenticatedInput.request,
    signal: undefined,
  }]);
});

test("the plain Human Verify prompt discloses every typed permission and defaults each to denied", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  let answeredPrompts = 0;
  output.on("data", (chunk) => {
    rendered += chunk;
    const promptCount = rendered.match(/\[y\/N\]/gu)?.length ?? 0;
    if (promptCount > answeredPrompts) {
      answeredPrompts = promptCount;
      setImmediate(() => {
        if (promptCount === 3) input.end("\n");
        else input.write("\n");
      });
    }
  });
  const prompt = createPlainPromptAdapter({ input, output });
  const result = {
    status: "needs_permission",
    operation: "verify",
    request: {
      permissions: [
        {
          permission_id: "public_verification",
          boundary: "public_network",
          scope: {
            collector_version: "public-verification/v1",
            targets: ["https://staging.example.com/"],
            probes: [
              {
                method: "DNS_LOOKUP",
                target: "https://staging.example.com/",
                purpose: "Resolve the staging host.",
              },
              {
                method: "GET",
                target: "https://staging.example.com/control",
                purpose: "Verify anonymous boundary for protected Core Journey: staff control",
                verification_mode: "protected_anonymous_boundary",
                expected_status_codes: [401, 403, 404],
              },
            ],
          },
        },
        {
          permission_id: "provider_read:sentry",
          boundary: "provider_read",
          scope: {
            provider: "sentry",
            target: "configured Sentry organization and project metadata",
            requested_fields: ["projects.slug", "projects.platform"],
            commands: [{ executable: "sentry-cli", arguments: ["projects", "list"] }],
          },
        },
        {
          permission_id: "authenticated_journey_verification",
          boundary: "authenticated_network_read",
          scope: {
            adapter_version: "host-agent-authenticated-journey/v1",
            requested_fields: [
              "journey_id",
              "status",
              "outcome",
              "status_code",
              "collected_at",
            ],
            journeys: [{
              method: "GET",
              target: "https://staging.example.com/control",
              purpose: "staff control",
              authentication_class: "staff",
              expected_status_codes: [200],
            }],
          },
        },
      ],
    },
  };

  const responsePromise = prompt.respondVerify(result);
  const response = await responsePromise;
  await prompt.close();

  assert.deepEqual(response.permission_decisions, {
    public_verification: "denied",
    "provider_read:sentry": "denied",
    authenticated_journey_verification: "denied",
  });
  assert.match(rendered, /Collector: public-verification\/v1/u);
  assert.match(rendered, /DNS_LOOKUP https:\/\/staging\.example\.com\//u);
  assert.match(rendered, /Resolve the staging host\./u);
  assert.match(rendered, /Provider read: sentry/u);
  assert.match(rendered, /projects\.slug, projects\.platform/u);
  assert.match(rendered, /sentry-cli projects list/u);
  assert.match(rendered, /Authenticated Core Journey verification/u);
  assert.match(rendered, /GET https:\/\/staging\.example\.com\/control/u);
  assert.match(rendered, /Authentication class: staff/u);
  assert.match(rendered, /Anonymous expected status: 401, 403, 404/u);
  assert.match(rendered, /Authenticated expected status: 200/u);
  assert.match(rendered, /Runner\/adapter version: host-agent-authenticated-journey\/v1/u);
  assert.match(rendered, /Retained normalized fields: journey_id, status, outcome, status_code, collected_at/u);
  assert.doesNotMatch(rendered, /Resume token|undefined/u);
});

test("the styled Human Verify prompt preserves typed permission meaning and default denial", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk;
  });
  const prompt = await createClackPromptAdapter({ input, output });
  const permission = {
    status: "needs_permission",
    operation: "verify",
    request: {
      permissions: [{
        permission_id: "provider_read:sentry",
        boundary: "provider_read",
        scope: {
          provider: "sentry",
          target: "configured project metadata",
          requested_fields: ["projects.slug"],
          commands: [{ executable: "sentry-cli", arguments: ["projects", "list"] }],
        },
      }],
    },
  };

  await prompt.start("verify");
  setTimeout(() => input.write("\r"), 20);
  const response = await prompt.respondVerify(permission);
  await prompt.close();

  assert.deepEqual(response, {
    permission_decisions: { "provider_read:sentry": "denied" },
  });
  const semanticOutput = stripVTControlCharacters(rendered);
  assert.match(semanticOutput, /LaunchRally Verify/u);
  assert.match(semanticOutput, /Verify permission request/u);
  assert.match(semanticOutput, /Provider read: sentry/u);
  assert.match(semanticOutput, /Target: configured project metadata/u);
  assert.match(semanticOutput, /Fields: projects\.slug/u);
  assert.match(semanticOutput, /sentry-cli projects list/u);
  assert.match(semanticOutput, /Approve this permission\?/u);
  assert.doesNotMatch(semanticOutput, /Resume token|undefined/u);
});

test("the Human Verify driver completes an unavailable authenticated runner as a typed error", async () => {
  let verifyCalls = 0;
  const outcome = await runHumanVerify({
    cwd: "/workspace/project",
    version: "0.4.0",
    reportPackage: { report: { report_id: "report-1" } },
    scope: "full",
    prompt: {
      async start() {},
      async respondVerify() {
        return {
          permission_decisions: {
            authenticated_journey_verification: "approved",
          },
        };
      },
      async close() {},
    },
    runVerify: async () => {
      verifyCalls += 1;
      if (verifyCalls === 1) {
        return {
          status: "needs_permission",
          operation: "verify",
          interaction: { resume_token: "permission-token" },
          request: { permissions: [] },
        };
      }
      return {
        status: "needs_input",
        operation: "verify",
        interaction: { resume_token: "authenticated-token" },
        request: {
          type: "authenticated_journey_results",
          plan: {},
        },
      };
    },
  });

  assert.equal(outcome.exitCode, 2);
  assert.deepEqual(outcome.result, {
    status: "execution_error",
    operation: "verify",
    error: "authenticated_journey_runner_unavailable",
    message: "The trusted authenticated Core Journey runner could not complete safely.",
  });
});

test("the Human Verify driver rejects an invalid normalized runner result without another prompt", async () => {
  let verifyCalls = 0;
  const outcome = await runHumanVerify({
    cwd: "/workspace/project",
    version: "0.4.0",
    reportPackage: { report: { report_id: "report-1" } },
    scope: "full",
    prompt: {
      async start() {},
      async respondVerify() {
        return { permission_decisions: { authenticated_journey_verification: "approved" } };
      },
      async close() {},
    },
    runVerify: async () => {
      verifyCalls += 1;
      return verifyCalls === 1
        ? {
            status: "needs_permission",
            operation: "verify",
            interaction: { resume_token: "permission-token" },
            request: { permissions: [] },
          }
        : {
            status: "needs_input",
            operation: "verify",
            interaction: { resume_token: "authenticated-token" },
            request: { type: "authenticated_journey_results", plan: {} },
          };
    },
    resumeAuthenticatedJourney: async () => ({
      status: "needs_input",
      operation: "verify",
      request: {
        type: "authenticated_journey_results",
        validation_errors: [{
          field_id: "journey_results",
          code: "invalid_authenticated_journey_results",
        }],
      },
    }),
  });

  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.result.status, "execution_error");
  assert.equal(outcome.result.error, "invalid_authenticated_journey_results");
});

test("cancelling Human Verify closes the prompt before any pending permission is resumed", async () => {
  const events = [];
  let verifyCalls = 0;
  const outcome = await runHumanVerify({
    cwd: "/workspace/project",
    version: "0.4.0",
    reportPackage: { report: { report_id: "report-1" } },
    scope: "targeted",
    checkIds: ["web.public.availability"],
    prompt: {
      async start() {
        events.push("start");
      },
      async respondVerify() {
        events.push("cancel");
        throw new PromptCancelledError();
      },
      async close() {
        events.push("close");
      },
    },
    runVerify: async () => {
      verifyCalls += 1;
      return {
        status: "needs_permission",
        operation: "verify",
        interaction: { resume_token: "private-token" },
        request: { permissions: [] },
      };
    },
  });

  assert.deepEqual(outcome, { exitCode: 130, result: null });
  assert.equal(verifyCalls, 1);
  assert.deepEqual(events, ["start", "cancel", "close"]);
});

test("Human Verify forwards cooperative cancellation to initial and approved Core work", async () => {
  const activityLabels = [];
  const observedSignals = [];
  let verifyCalls = 0;
  const outcome = await runHumanVerify({
    cwd: "/workspace/project",
    version: "0.4.0",
    reportPackage: { report: { report_id: "report-1" } },
    scope: "full",
    prompt: {
      async start() {},
      async activity(label, operation) {
        activityLabels.push(label);
        const controller = new AbortController();
        return operation(controller.signal);
      },
      async respondVerify() {
        return { permission_decisions: { public_verification: "approved" } };
      },
      async close() {},
    },
    runVerify: async (cwd, version, options, dependencies) => {
      observedSignals.push(dependencies?.signal);
      verifyCalls += 1;
      return verifyCalls === 1
        ? {
            status: "needs_permission",
            operation: "verify",
            interaction: { resume_token: "permission-token" },
            request: { permissions: [] },
          }
        : { status: "completed", operation: "verify" };
    },
  });

  assert.equal(outcome.result.status, "completed");
  assert.equal(activityLabels.length, 2);
  assert.ok(activityLabels.every((label) => /Verif|Evidence/u.test(label)));
  assert.equal(observedSignals.length, 2);
  assert.ok(observedSignals.every((signal) => signal instanceof AbortSignal));
});

test("the plain TTY completes full Verify approval and authenticated result routing", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  let answeredPrompts = 0;
  output.on("data", (chunk) => {
    rendered += chunk;
    const promptCount = rendered.match(/\[y\/N\]/gu)?.length ?? 0;
    if (promptCount > answeredPrompts) {
      answeredPrompts = promptCount;
      setImmediate(() => input.write("y\n"));
    }
  });
  const prompt = createPlainPromptAdapter({ input, output, activityDelayMs: 0 });
  const permission = {
    status: "needs_permission",
    operation: "verify",
    interaction: { resume_token: "permission-token" },
    request: {
      permissions: [
        {
          permission_id: "public_verification",
          boundary: "public_network",
          scope: {
            collector_version: "public-verification/v1",
            targets: ["https://example.com/"],
            probes: [{
              method: "GET",
              target: "https://example.com/",
              purpose: "Verify reachability.",
            }],
          },
        },
        {
          permission_id: "authenticated_journey_verification",
          boundary: "authenticated_network_read",
          scope: {
            adapter_version: "host-agent-authenticated-journey/v1",
            requested_fields: ["journey_id", "status", "outcome", "status_code", "collected_at"],
            journeys: [{
              method: "GET",
              target: "https://example.com/control",
              authentication_class: "staff",
              expected_status_codes: [200],
            }],
          },
        },
      ],
    },
  };
  const authenticatedInput = {
    status: "needs_input",
    operation: "verify",
    interaction: { resume_token: "authenticated-token" },
    request: {
      type: "authenticated_journey_results",
      result_schema: "launchrally.dev/authenticated-journey-results/v1",
      plan: {},
    },
  };
  const calls = [];
  let verifyCalls = 0;
  let runnerCalls = 0;
  const outcome = await runHumanVerify({
    cwd: "/workspace/full",
    version: "0.4.0",
    reportPackage: { report: { report_id: "report-1" } },
    scope: "full",
    prompt,
    runVerify: async (cwd, version, options) => {
      calls.push(options);
      verifyCalls += 1;
      return verifyCalls === 1 ? permission : authenticatedInput;
    },
    resumeAuthenticatedJourney: async () => {
      runnerCalls += 1;
      return {
        status: "completed",
        operation: "verify",
        verification_scope: { mode: "full", whole_release: true },
      };
    },
  });

  assert.equal(outcome.result.status, "completed");
  assert.equal(runnerCalls, 1);
  assert.equal(calls[0].scope, "full");
  assert.deepEqual(calls[1].permission_decisions, {
    public_verification: "approved",
    authenticated_journey_verification: "approved",
  });
  assert.match(rendered, /LaunchRally Verify/u);
  assert.match(rendered, /Authenticated Core Journey verification/u);
  assert.doesNotMatch(rendered, /Resume token/u);
  input.end();
});

test("the styled TTY completes targeted Verify after an independent denial", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk;
  });
  const prompt = await createClackPromptAdapter({ input, output, activityDelayMs: 0 });
  let verifyCalls = 0;
  const calls = [];
  setTimeout(() => input.write("\r"), 20);
  const outcome = await runHumanVerify({
    cwd: "/workspace/targeted",
    version: "0.4.0",
    reportPackage: { report: { report_id: "report-1" } },
    scope: "targeted",
    checkIds: ["web.public.availability"],
    prompt,
    runVerify: async (cwd, version, options) => {
      calls.push(options);
      verifyCalls += 1;
      return verifyCalls === 1
        ? {
            status: "needs_permission",
            operation: "verify",
            interaction: { resume_token: "permission-token" },
            request: {
              permissions: [{
                permission_id: "public_verification",
                boundary: "public_network",
                scope: {
                  collector_version: "public-verification/v1",
                  targets: ["https://example.com/"],
                  probes: [],
                },
              }],
            },
          }
        : {
            status: "completed",
            operation: "verify",
            verification_scope: { mode: "targeted", whole_release: false },
            assessment_scope: "targeted_only",
          };
    },
  });

  assert.equal(outcome.result.status, "completed");
  assert.equal(calls[0].scope, "targeted");
  assert.deepEqual(calls[0].check_ids, ["web.public.availability"]);
  assert.deepEqual(calls[1].permission_decisions, { public_verification: "denied" });
  const semanticOutput = stripVTControlCharacters(rendered);
  assert.match(semanticOutput, /LaunchRally Verify/u);
  assert.match(semanticOutput, /Verify permission request/u);
});

test("the plain TTY cancellation restores the adapter and never resumes pending Verify work", async () => {
  const input = ttyStream();
  const output = ttyStream();
  const signals = new EventEmitter();
  const prompt = createPlainPromptAdapter({ input, output, signals });
  let verifyCalls = 0;
  setTimeout(() => signals.emit("SIGINT"), 10);
  const outcome = await runHumanVerify({
    cwd: "/workspace/cancel",
    version: "0.4.0",
    reportPackage: { report: { report_id: "report-1" } },
    scope: "full",
    prompt,
    runVerify: async () => {
      verifyCalls += 1;
      return {
        status: "needs_permission",
        operation: "verify",
        interaction: { resume_token: "private-token" },
        request: {
          permissions: [{
            permission_id: "public_verification",
            boundary: "public_network",
            scope: {
              collector_version: "public-verification/v1",
              targets: ["https://example.com/"],
              probes: [],
            },
          }],
        },
      };
    },
  });

  assert.deepEqual(outcome, { exitCode: 130, result: null });
  assert.equal(verifyCalls, 1);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  input.end();
});
