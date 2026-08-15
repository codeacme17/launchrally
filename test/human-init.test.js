import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { PromptCancelledError } from "../packages/cli/bin/human-audit.js";
import { runHumanInit } from "../packages/cli/bin/human-init.js";
import { createPlainPromptAdapter } from "../packages/cli/bin/prompt-adapters.js";

test("the Human Init driver accepts permission and confirmation in one process", async () => {
  const results = [
    {
      status: "needs_permission",
      operation: "init",
      interaction: { resume_token: "permission-token" },
    },
    {
      status: "needs_confirmation",
      operation: "init",
      interaction: { resume_token: "confirmation-token" },
    },
    {
      status: "completed",
      operation: "init",
      outcome: "initialized",
    },
  ];
  const calls = [];
  const events = [];
  const outcome = await runHumanInit({
    cwd: "/workspace",
    version: "0.4.0",
    reportPackage: { report: { report_id: "report-1" } },
    prompt: {
      async start(operation) {
        events.push(`start:${operation}`);
      },
      async respondInit(result) {
        events.push(`respond:${result.status}`);
        return result.status === "needs_permission"
          ? { permission_decisions: { npm_registry_read: "approved" } }
          : { confirmation: "confirm" };
      },
      async close() {
        events.push("close");
      },
    },
    runInit: async (cwd, version, options) => {
      calls.push({ cwd, version, options });
      return results.shift();
    },
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.outcome, "initialized");
  assert.deepEqual(calls, [
    {
      cwd: "/workspace",
      version: "0.4.0",
      options: { report_package: { report: { report_id: "report-1" } } },
    },
    {
      cwd: "/workspace",
      version: "0.4.0",
      options: {
        resume_token: "permission-token",
        permission_decisions: { npm_registry_read: "approved" },
      },
    },
    {
      cwd: "/workspace",
      version: "0.4.0",
      options: {
        resume_token: "confirmation-token",
        confirmation: "confirm",
      },
    },
  ]);
  assert.deepEqual(events, [
    "start:init",
    "respond:needs_permission",
    "respond:needs_confirmation",
    "close",
  ]);
});

test("the plain Human Init prompt reads a decision after rendering the exact preview", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk;
  });
  const prompt = createPlainPromptAdapter({ input, output });

  const responsePromise = prompt.respondInit({
    status: "needs_confirmation",
    operation: "init",
    mode: "initialize",
    source_report_id: "report-1",
    preview: {
      changes: [{
        operation: "create",
        path: ".launchrally/manifest.yaml",
        before_digest: null,
        after_digest: `sha256:${"a".repeat(64)}`,
        diff: "+schema_version: launchrally.dev/manifest/v2",
        after: "schema_version: launchrally.dev/manifest/v2\n",
      }],
    },
    request: {
      prompt: "Apply exactly these local initialization changes?",
      choices: ["confirm", "decline"],
    },
    interaction: { resume_token: "opaque-preview-token" },
  });
  input.end("1\n");
  const response = await responsePromise;
  await prompt.close();

  assert.deepEqual(response, { confirmation: "confirm" });
  assert.match(rendered, /^LaunchRally Initialization Preview/mu);
  assert.match(rendered, /CREATE \.launchrally\/manifest\.yaml/u);
  assert.match(rendered, /After digest: sha256:a{64}/u);
  assert.match(rendered, /Apply exactly these local initialization changes\?/u);
  assert.match(rendered, /1\. Confirm/u);
  assert.match(rendered, /2\. Decline/u);
  assert.doesNotMatch(rendered, /Resume token:/u);
});

test("the Human Init driver submits an explicit decline without applying changes", async () => {
  const calls = [];
  const results = [
    {
      status: "needs_confirmation",
      operation: "init",
      interaction: { resume_token: "preview-token" },
    },
    {
      status: "completed",
      operation: "init",
      outcome: "initialization_declined",
      changes_applied: [],
    },
  ];
  const outcome = await runHumanInit({
    cwd: "/workspace",
    version: "0.4.0",
    reportPackage: { report: { report_id: "report-1" } },
    prompt: {
      async start() {},
      async respondInit() {
        return { confirmation: "decline" };
      },
      async close() {},
    },
    runInit: async (cwd, version, options) => {
      calls.push(options);
      return results.shift();
    },
  });

  assert.equal(outcome.result.outcome, "initialization_declined");
  assert.deepEqual(outcome.result.changes_applied, []);
  assert.deepEqual(calls[1], {
    resume_token: "preview-token",
    confirmation: "decline",
  });
});

test("cancelling Human Init stops before the digest-bound preview is resumed", async () => {
  let runs = 0;
  const outcome = await runHumanInit({
    cwd: "/workspace",
    version: "0.4.0",
    reportPackage: { report: { report_id: "report-1" } },
    prompt: {
      async start() {},
      async respondInit() {
        throw new PromptCancelledError();
      },
      async close() {},
    },
    runInit: async () => {
      runs += 1;
      return {
        status: "needs_confirmation",
        operation: "init",
        interaction: { resume_token: "preview-token" },
      };
    },
  });

  assert.equal(outcome.exitCode, 130);
  assert.equal(outcome.result, null);
  assert.equal(runs, 1);
});
