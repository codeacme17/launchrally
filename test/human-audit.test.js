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
  assert.match(summary, /Next command: rally audit .*--output <path>/u);
  assert.doesNotMatch(summary, /No input or approval is required for this local-only Audit/u);
  assert.doesNotMatch(summary, /# LaunchRally Audit Report/u);
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
  assert.deepEqual(await readdir(fixture), ["package-lock.json", "package.json"]);
});

test("a Human Audit writes full JSON only after an explicit save path", async () => {
  const fixture = await createFixture();
  const requestedPath = path.join(fixture, "audit-result.json");
  let saved;
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
      return { output_path: requestedPath };
    },
    async close() {},
  };

  const outcome = await runHumanAudit({
    cwd: fixture,
    version: "0.1.0",
    prompt,
    runAudit,
    saveResult: async (outputPath, result) => {
      saved = { outputPath, result };
      return path.resolve(outputPath);
    },
  });

  assert.equal(outcome.outputPath, requestedPath);
  assert.equal(saved.outputPath, requestedPath);
  assert.equal(saved.result.report.report_id, outcome.result.report.report_id);
  assert.match(
    renderHumanAuditCompletion(outcome.result, {
      cwd: fixture,
      outputPath: outcome.outputPath,
    }),
    /Next command: rally init .*--report/u,
  );
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
