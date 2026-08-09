import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  PromptCancelledError,
  renderHumanAuditCompletion,
  runHumanAudit,
} from "../packages/cli/bin/human-audit.js";
import { runAudit } from "@launchrally/core";

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
  assert.match(summary, /Assessment:/u);
  assert.match(summary, /Failed Findings:/u);
  assert.match(summary, /Verification Gaps:/u);
  assert.match(summary, /Next command: rally init .*--report <saved-report-path>/u);
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
  assert.match(summary, /Next command: rally init --cwd/u);
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
    /Next command: rally init .*--report/u,
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
