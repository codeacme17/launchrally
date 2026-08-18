import assert from "node:assert/strict";
import path from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";

import { PromptCancelledError } from "../packages/cli/bin/human-audit.js";
import { renderHumanInit, runHumanInit } from "../packages/cli/bin/human-init.js";
import {
  createClackPromptAdapter,
  createPlainPromptAdapter,
} from "../packages/cli/bin/prompt-adapters.js";

function ttyStream(columns = 100) {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.columns = columns;
  stream.rows = 30;
  stream.setRawMode = () => stream;
  return stream;
}

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
  const contexts = [];
  const events = [];
  const outcome = await runHumanInit({
    cwd: "relative-workspace",
    version: "0.4.0",
    reportPackage: { report: { report_id: "report-1" } },
    prompt: {
      async start(operation) {
        events.push(`start:${operation}`);
      },
      async respondInit(result, context) {
        contexts.push(context);
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
      cwd: "relative-workspace",
      version: "0.4.0",
      options: { report_package: { report: { report_id: "report-1" } } },
    },
    {
      cwd: "relative-workspace",
      version: "0.4.0",
      options: {
        resume_token: "permission-token",
        permission_decisions: { npm_registry_read: "approved" },
      },
    },
    {
      cwd: "relative-workspace",
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
  assert.deepEqual(contexts, [
    { root: path.resolve("relative-workspace"), version: "0.4.0" },
    { root: path.resolve("relative-workspace"), version: "0.4.0" },
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

test("Human Init summarizes large exact previews without embedding record bodies", () => {
  const largeRecord = JSON.stringify({ payload: "record-body-sentinel".repeat(200) });
  const rendered = renderHumanInit({
    mode: "initialize",
    source_report_id: "report-large",
    manifest_action: {
      action: "create",
      supplied_source_report_id: "report-large",
    },
    preview: {
      changes: [
        {
          operation: "create",
          path: ".launchrally/manifest.yaml",
          before_digest: null,
          after_digest: `sha256:${"a".repeat(64)}`,
          diff: "+schema_version: launchrally.dev/manifest/v2",
          after: "schema_version: launchrally.dev/manifest/v2\n",
        },
        {
          operation: "create",
          path: ".launchrally/reports/report-large/record.json",
          before_digest: null,
          after_digest: `sha256:${"b".repeat(64)}`,
          diff: `+${largeRecord}`,
          after: largeRecord,
        },
        {
          operation: "create",
          path: `.launchrally/evidence/sha256/${"c".repeat(64)}.json`,
          before_digest: null,
          after_digest: `sha256:${"c".repeat(64)}`,
          diff: `+${largeRecord}`,
          after: largeRecord,
        },
        {
          operation: "update",
          path: ".launchrally/.gitignore",
          before_digest: `sha256:${"d".repeat(64)}`,
          after_digest: `sha256:${"e".repeat(64)}`,
          diff: "+/reports/",
          after: "/reports/\n",
        },
      ],
      materialization: {
        command: {
          executable: "npm",
          arguments: ["install", "@launchrally/cli@0.4.0"],
        },
        package_count: 42,
        integrity_digest: `sha256:${"f".repeat(64)}`,
        target: ".launchrally/toolchain/node_modules",
        ignored: true,
        authoritative: false,
      },
    },
    request: { prompt: "Apply exactly these local initialization changes?" },
  }, {
    root: "/workspace/narrow-terminal-project",
    version: "0.4.0",
  });

  assert.match(rendered, /Affected root: \/workspace\/narrow-terminal-project/u);
  assert.match(rendered, /Changes: 3 create, 1 update, 0 delete/u);
  assert.match(rendered, /CREATE \.launchrally\/reports\/report-large\/record\.json/u);
  assert.match(rendered, /CREATE \.launchrally\/evidence\/sha256\/[c]{64}\.json/u);
  assert.match(rendered, /Before digest: none/u);
  assert.match(rendered, /After digest: sha256:b{64}/u);
  assert.match(rendered, /Manifest action: create/u);
  assert.match(rendered, /Project Toolchain: @launchrally\/cli@0\.4\.0/u);
  assert.match(rendered, /Materialization: \.launchrally\/toolchain\/node_modules/u);
  assert.match(rendered, /Write authority: exact listed \.launchrally paths only/u);
  assert.match(rendered, /stale or altered previews fail closed/iu);
  assert.match(rendered, /View full preview/u);
  assert.doesNotMatch(rendered, /record-body-sentinel/u);
  assert.doesNotMatch(rendered, /^Diff:$/mu);
  assert.doesNotMatch(rendered, /^After content:$/mu);
  assert.ok(rendered.split("\n").length < 50);
});

test("the plain Human Init prompt shows full details and returns to the same decision", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = "";
  let answeredPrompts = 0;
  output.on("data", (chunk) => {
    rendered += chunk;
    const promptCount = rendered.match(/Choose 1-3:/gu)?.length ?? 0;
    if (promptCount > answeredPrompts) {
      answeredPrompts = promptCount;
      setImmediate(() => {
        if (promptCount === 1) input.write("3\n");
        else input.end("1\n");
      });
    }
  });
  const prompt = createPlainPromptAdapter({ input, output });
  const largeRecord = JSON.stringify({ payload: "full-preview-record-body".repeat(100) });

  const responsePromise = prompt.respondInit({
    status: "needs_confirmation",
    operation: "init",
    mode: "initialize",
    source_report_id: "report-full-preview",
    preview: {
      changes: [{
        operation: "create",
        path: ".launchrally/reports/report-full-preview/record.json",
        before_digest: null,
        after_digest: `sha256:${"a".repeat(64)}`,
        diff: `+${largeRecord}`,
        after: largeRecord,
      }],
    },
    request: {
      prompt: "Apply exactly these local initialization changes?",
      choices: ["confirm", "decline"],
    },
    interaction: { resume_token: "one-digest-bound-preview-token" },
  }, {
    root: "/workspace",
    version: "0.4.0",
  });
  const response = await responsePromise;
  await prompt.close();

  const [summary, fullPreview] = rendered.split("Full exact digest-bound preview:");
  assert.deepEqual(response, { confirmation: "confirm" });
  assert.doesNotMatch(summary, /full-preview-record-body/u);
  assert.match(fullPreview, /full-preview-record-body/u);
  assert.match(fullPreview, /^Diff:$/mu);
  assert.match(fullPreview, /^After content:$/mu);
  assert.equal(rendered.match(/1\. Confirm/gu)?.length, 2);
  assert.equal(rendered.match(/3\. View full preview/gu)?.length, 2);
  assert.doesNotMatch(rendered, /Resume token:/u);
});

test("the styled Human Init prompt progressively discloses the same full preview", async () => {
  const input = ttyStream(36);
  const output = ttyStream(36);
  let rendered = "";
  let openedFullPreview = false;
  let submittedDecision = false;
  output.on("data", (chunk) => {
    rendered += chunk.toString();
    const semanticOutput = stripVTControlCharacters(rendered);
    if (!openedFullPreview && semanticOutput.includes("View full preview")) {
      openedFullPreview = true;
      setImmediate(() => input.write("\u001b[B\r"));
    } else if (openedFullPreview && !submittedDecision) {
      const fullPreviewIndex = semanticOutput.indexOf("Full exact initialization preview");
      if (
        fullPreviewIndex >= 0
        && semanticOutput.lastIndexOf("View full preview") > fullPreviewIndex
      ) {
        submittedDecision = true;
        setImmediate(() => input.write("\r"));
      }
    }
  });
  const prompt = await createClackPromptAdapter({ input, output });
  const reportRecord = JSON.stringify({ payload: "styled-report-preview-body".repeat(80) });
  const evidenceRecord = JSON.stringify({ payload: "styled-evidence-preview-body".repeat(80) });

  const response = await prompt.respondInit({
    status: "needs_confirmation",
    operation: "init",
    mode: "initialize",
    source_report_id: "report-styled",
    preview: {
      changes: [
        {
          operation: "create",
          path: ".launchrally/reports/report-styled/record.json",
          before_digest: null,
          after_digest: `sha256:${"a".repeat(64)}`,
          diff: `+${reportRecord}`,
          after: reportRecord,
        },
        {
          operation: "create",
          path: `.launchrally/evidence/sha256/${"b".repeat(64)}.json`,
          before_digest: null,
          after_digest: `sha256:${"b".repeat(64)}`,
          diff: `+${evidenceRecord}`,
          after: evidenceRecord,
        },
      ],
    },
    request: { prompt: "Apply exactly these local initialization changes?" },
  }, {
    root: "/workspace",
    version: "0.4.0",
  });
  await prompt.close();

  const semanticOutput = stripVTControlCharacters(rendered);
  const [summary, fullPreview] = semanticOutput.split("Full exact initialization preview");
  assert.deepEqual(response, { confirmation: "decline" });
  assert.doesNotMatch(summary, /styled-report-preview-body/u);
  assert.doesNotMatch(summary, /styled-evidence-preview-body/u);
  assert.match(summary, /View full preview/u);
  assert.match(summary, /CREATE \.launchrally\/reports\/re/u);
  assert.match(summary, /CREATE \.launchrally\/evidence\/s/u);
  assert.ok(summary.split("\n").length < 100);
  assert.match(fullPreview, /styled-report-preview-body/u);
  assert.match(fullPreview, /styled-evidence-preview-body/u);
  assert.match(fullPreview, /Full exact digest-bound[\s\S]*preview:/u);
});

test("Human Init explains preserved Manifest intent and the explicit rebind action", () => {
  const rendered = renderHumanInit({
    mode: "update",
    source_report_id: "report-new",
    manifest_action: {
      action: "preserve",
      existing_source_report_id: "report-old",
      supplied_source_report_id: "report-new",
    },
    replacement_action: {
      display: "rally init --cwd /workspace --report corrected.json --rebind",
    },
    preview: { changes: [] },
    request: { prompt: "Adopt immutable Report history?" },
  });

  assert.match(rendered, /Manifest intent: preserved/u);
  assert.match(rendered, /Existing Manifest source Report: report-old/u);
  assert.match(rendered, /Supplied Report for immutable history: report-new/u);
  assert.match(rendered, /Replace command: rally init .* --rebind/u);
});

test("Human Init separates rebind history adoption from release-intent replacement", () => {
  const rendered = renderHumanInit({
    mode: "rebind",
    source_report_id: "report-new",
    manifest_action: {
      action: "replace",
      existing_source_report_id: "report-old",
      supplied_source_report_id: "report-new",
    },
    preview: {
      changes: [],
      history_adoption: { changes: [{ path: ".launchrally/reports/report-new/record.json" }] },
      release_intent_replacement: { changes: [{ path: ".launchrally/manifest.yaml" }] },
    },
    request: { prompt: "Replace project-owned release intent?" },
  });

  assert.match(rendered, /^LaunchRally Manifest Rebind Preview/mu);
  assert.match(rendered, /Old source Report: report-old/u);
  assert.match(rendered, /New source Report: report-new/u);
  assert.match(rendered, /Immutable Report-history changes: 1/u);
  assert.match(rendered, /Release-intent replacement changes: 1/u);
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
