import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";

import {
  createClackPromptAdapter,
  createPlainPromptAdapter,
} from "../packages/cli/bin/prompt-adapters.js";
import {
  humanAuditPresentationOptions,
  PromptCancelledError,
} from "../packages/cli/bin/human-audit.js";

function ttyStream() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.columns = 100;
  stream.rows = 30;
  stream.setRawMode = () => stream;
  return stream;
}

test("the Plain adapter reports active work and a clear text completion", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output, activityDelayMs: 0 });

  const value = await prompt.activity(
    "Scanning repository…",
    async () => "complete",
  );
  await prompt.close();

  assert.equal(value, "complete");
  assert.equal(rendered, [
    "Working: Scanning repository…",
    "Completed: Scanning repository.",
    "",
  ].join("\n"));
});

test("the Plain adapter suppresses status flicker for short work", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output, activityDelayMs: 50 });

  await prompt.activity("Scanning repository…", async () => {});
  await prompt.close();

  assert.equal(rendered, "");
});

test("the Plain adapter replaces active work with a failure state", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output, activityDelayMs: 0 });

  await assert.rejects(
    prompt.activity("Reading Cloudflare Provider data…", async () => {
      throw new Error("provider unavailable");
    }),
    /provider unavailable/u,
  );
  await prompt.close();

  assert.equal(rendered, [
    "Working: Reading Cloudflare Provider data…",
    "Failed: Reading Cloudflare Provider data.",
    "",
  ].join("\n"));
});

test("the Plain adapter cancels active work on SIGINT and removes its listener", async () => {
  const input = ttyStream();
  const output = ttyStream();
  const signals = new EventEmitter();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({
    input,
    output,
    signals,
    activityDelayMs: 0,
  });

  const activity = prompt.activity(
    "Verifying public Journeys…",
    async (signal) => new Promise((resolve, reject) => {
      const abort = () => reject(new PromptCancelledError());
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }),
  );
  signals.emit("SIGINT");
  await assert.rejects(activity, PromptCancelledError);
  await prompt.close();

  assert.equal(rendered, [
    "Working: Verifying public Journeys…",
    "Cancelled: Verifying public Journeys.",
    "",
  ].join("\n"));
  assert.equal(signals.listenerCount("SIGINT"), 0);
});

test("the Plain adapter waits for non-cooperative work to settle after cancellation", async () => {
  const input = ttyStream();
  const output = ttyStream();
  const signals = new EventEmitter();
  const prompt = createPlainPromptAdapter({
    input,
    output,
    signals,
    activityDelayMs: 0,
  });
  let settlements = 0;

  const activity = prompt.activity(
    "Saving Audit Report…",
    async () => new Promise((resolve) => {
      setTimeout(() => {
        settlements += 1;
        resolve();
      }, 30);
    }),
  );
  signals.emit("SIGINT");
  await assert.rejects(activity, PromptCancelledError);
  assert.equal(settlements, 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(settlements, 1);
  await prompt.close();
});
function journeyInput(candidates) {
  return {
    status: "needs_input",
    operation: "audit",
    audit_brief: {
      project: { name: "launchrally", type: "web" },
      provider_roles: { candidates: [] },
      support_layers: { candidates: [] },
    },
    request: {
      validation_errors: [],
      fields: [{
        field_id: "core_journeys",
        value_type: "journey_array",
        prompt: "Which GET paths and user journeys must work for this release?",
        candidates,
        current_value: [],
      }],
    },
  };
}

test("the Plain adapter explains and validates required input before continuing", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("\n"), 10);
  setTimeout(() => input.write("ht\n"), 30);
  setTimeout(() => input.write("https://app.example.com\n"), 50);
  const response = await prompt.respond({
    status: "needs_input",
    operation: "audit",
    audit_brief: {
      project: { name: "launchrally", type: "web" },
      provider_roles: { candidates: [] },
      support_layers: { candidates: [] },
    },
    request: {
      validation_errors: [],
      fields: [{
        field_id: "production_targets",
        value_type: "url_array",
        prompt: "Which confirmed public target URLs are in scope?",
        candidates: [],
        current_value: [],
      }],
    },
  });
  await prompt.close();

  assert.deepEqual(response, {
    answers: { production_targets: ["https://app.example.com"] },
  });
  assert.match(rendered, /Which confirmed public target URLs are in scope\? \(Required\)/u);
  assert.match(rendered, /Example: https:\/\/app\.example\.com/u);
  assert.match(rendered, /This field is required\./u);
  assert.match(rendered, /Enter a valid public http or https URL/u);
});

test("the Plain adapter uses numbered choices for selectable input", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("1\n"), 10);
  const response = await prompt.respond({
    status: "needs_input",
    operation: "audit",
    audit_brief: {
      project: { name: "launchrally", type: "web" },
      provider_roles: { candidates: [] },
      support_layers: { candidates: [] },
    },
    request: {
      validation_errors: [],
      fields: [{
        field_id: "intended_environment",
        value_type: "string",
        prompt: "Which environment is this Audit preparing for?",
        candidates: [],
        current_value: null,
      }],
    },
  });
  await prompt.close();

  assert.deepEqual(response, { answers: { intended_environment: "production" } });
  assert.match(rendered, /Which environment is this Audit preparing for\? \(Required\)/u);
  assert.match(rendered, /1\. Production[\s\S]*2\. Staging[\s\S]*3\. Preview/u);
  assert.match(rendered, /4\. Other — enter a custom value/u);
});

test("the Plain adapter presents canonical support categories with revision guidance", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("2\n"), 10);
  const response = await prompt.respond({
    status: "needs_input",
    operation: "audit",
    audit_brief: {
      project: { name: "launchrally", type: "web" },
      provider_roles: { candidates: [] },
      support_layers: { candidates: [] },
    },
    request: {
      validation_errors: [{
        field_id: "support_layers",
        code: "unsupported_support_layer",
        supported_categories: ["analytics", "observability"],
        guidance: "Choose a supported category or revise the support-layer selection.",
      }],
      fields: [{
        field_id: "support_layers",
        value_type: "string_array",
        prompt: "Which support layers should the Audit include?",
        candidates: [],
        current_value: [],
      }],
    },
  });
  await prompt.close();

  assert.deepEqual(response, { answers: { support_layers: ["observability"] } });
  assert.match(
    rendered,
    /support_layers: unsupported_support_layer — Choose a supported category or revise the support-layer selection\./u,
  );
  assert.match(rendered, /1\. Analytics[\s\S]*2\. Observability/u);
});

test("the Plain adapter does not offer backward navigation", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("1\n"), 10);
  setTimeout(() => input.write("\n"), 30);
  const response = await prompt.respond({
    status: "needs_input",
    operation: "audit",
    audit_brief: {
      project: { name: "launchrally", type: "web" },
      provider_roles: { candidates: [] },
      support_layers: { candidates: [] },
    },
    request: {
      validation_errors: [],
      fields: [{
        field_id: "intended_environment",
        value_type: "string",
        prompt: "Which environment is this Audit preparing for?",
        candidates: [],
        current_value: null,
      }, {
        field_id: "support_layers",
        value_type: "string_array",
        prompt: "Which support layers should the Audit include?",
        candidates: [],
        current_value: [],
      }],
    },
  });
  await prompt.close();

  assert.deepEqual(response, {
    answers: {
      intended_environment: "production",
      support_layers: [],
    },
  });
  assert.doesNotMatch(rendered, /Back — change the previous answer/u);
  assert.doesNotMatch(rendered, /enter :back/u);
});

test("the Plain adapter uses numbered multi-select for Provider roles", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("1,2\n"), 10);
  const response = await prompt.respond({
    status: "needs_input",
    operation: "audit",
    audit_brief: {
      project: { name: "launchrally", type: "web" },
      provider_roles: { candidates: [{ provider: "vercel", role: "deployment" }] },
      support_layers: { candidates: [] },
    },
    request: {
      validation_errors: [],
      fields: [{
        field_id: "provider_roles",
        value_type: "provider_role_array",
        prompt: "Which Providers and roles belong to this release?",
        candidates: [{ provider: "vercel", role: "deployment" }],
        current_value: [],
      }],
    },
  });
  await prompt.close();

  assert.deepEqual(response, {
    answers: {
      provider_roles: [
        { provider: "cloudflare", role: "deployment" },
        { provider: "netlify", role: "deployment" },
      ],
    },
  });
  assert.match(rendered, /Vercel — deployment \(detected\)/u);
  assert.match(rendered, /1\. Cloudflare — deployment/u);
  assert.match(rendered, /Select numbers separated by commas, or press Enter for none:/u);
});

test("the Plain adapter offers a recommended Journey and an explicit Skip choice", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("1,3\n"), 10);
  setTimeout(() => input.write("3\n"), 30);
  const response = await prompt.respond({
    status: "needs_input",
    operation: "audit",
    snapshot: { project: { facts: [] } },
    audit_brief: {
      project: { name: "launchrally", type: "web" },
      provider_roles: { candidates: [] },
      support_layers: { candidates: [] },
    },
    request: {
      validation_errors: [],
      fields: [{
        field_id: "core_journeys",
        value_type: "journey_array",
        prompt: "Which GET paths and user journeys must work for this release?",
        candidates: [],
        current_value: [],
      }],
    },
  });
  await prompt.close();

  assert.deepEqual(response, { answers: { core_journeys: [] } });
  assert.match(rendered, /GET \/ — homepage loads \(recommended\)/u);
  assert.match(rendered, /Other — enter a custom value/u);
  assert.match(
    rendered,
    /Skip public Journey verification — creates a Verification Gap/u,
  );
  assert.match(rendered, /Skip cannot be combined with another Journey\./u);
  assert.match(
    rendered,
    /Which public Journeys should LaunchRally verify\? \(Select one or more Journeys\./u,
  );
});

test("the Plain adapter offers safely detected public routes as Journey choices", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("3\n"), 10);
  const response = await prompt.respond({
    status: "needs_input",
    operation: "audit",
    audit_brief: {
      project: { name: "launchrally", type: "web" },
      provider_roles: { candidates: [] },
      support_layers: { candidates: [] },
    },
    request: {
      validation_errors: [],
      fields: [{
        field_id: "core_journeys",
        value_type: "journey_array",
        prompt: "Which GET paths and user journeys must work for this release?",
        candidates: [
          "GET / — homepage loads",
          "GET /dashboard — dashboard page loads",
          "GET /docs — docs page loads",
          "GET /pricing — pricing page loads",
        ],
        current_value: [],
      }],
    },
  });
  await prompt.close();

  assert.deepEqual(response, {
    answers: {
      core_journeys: [{ method: "GET", path: "/dashboard", purpose: "dashboard page loads" }],
    },
  });
  assert.match(rendered, /GET \/ — homepage loads \(detected\)/u);
  assert.match(rendered, /GET \/dashboard — dashboard page loads \(detected\)/u);
  assert.match(rendered, /GET \/docs — docs page loads \(detected\)/u);
  assert.match(rendered, /GET \/pricing — pricing page loads \(detected\)/u);
});

test("the Plain adapter selects detected Journeys without recommended, Other, or Skip choices", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("1\n"), 10);
  setTimeout(() => input.write("\n"), 30);
  const response = await prompt.respond(journeyInput([
    "GET /dashboard — dashboard page loads",
    "GET /docs — docs page loads",
  ]));
  await prompt.close();

  assert.deepEqual(response, {
    answers: {
      core_journeys: [
        { method: "GET", path: "/dashboard", purpose: "dashboard page loads" },
        { method: "GET", path: "/docs", purpose: "docs page loads" },
      ],
    },
  });
  assert.match(rendered, /Select all detected journeys/u);
  assert.match(rendered, /GET \/ — homepage loads \(recommended\)/u);
  assert.match(rendered, /Other — enter a custom value/u);
  assert.match(rendered, /Skip public Journey verification/u);
  assert.match(rendered, /Deselect detected Journeys by number, or press Enter to keep all:/u);
  assert.match(
    rendered,
    /Select one or more Journeys\. Select all detected journeys includes only detected choices; you can then deselect individual Journeys\./u,
  );
});

test("the Plain adapter lets users deselect a detected Journey after selecting all", async () => {
  const input = ttyStream();
  const output = ttyStream();
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("1\n"), 10);
  setTimeout(() => input.write("2\n"), 30);
  const response = await prompt.respond(journeyInput([
    "GET /dashboard — dashboard page loads",
    "GET /docs — docs page loads",
  ]));
  await prompt.close();

  assert.deepEqual(response, {
    answers: {
      core_journeys: [
        { method: "GET", path: "/dashboard", purpose: "dashboard page loads" },
      ],
    },
  });
});

test("the Plain adapter requires an explicit Skip after deselecting every detected Journey", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("1\n"), 10);
  setTimeout(() => input.write("1,2\n"), 30);
  setTimeout(() => input.write("6\n"), 50);
  const response = await prompt.respond(journeyInput([
    "GET /dashboard — dashboard page loads",
    "GET /docs — docs page loads",
  ]));
  await prompt.close();

  assert.deepEqual(response, { answers: { core_journeys: [] } });
  assert.match(
    rendered,
    /Select at least one detected Journey, or return to the picker and explicitly choose Skip\./u,
  );
  assert.equal(
    rendered.match(/Select one or more numbers separated by commas:/gu)?.length,
    2,
  );
});

test("the Plain adapter rejects unsafe custom Journeys before submitting to Core", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("2\n"), 10);
  setTimeout(() => input.write("POST /admin — destructive action\n"), 30);
  setTimeout(() => input.write("GET /checkout — checkout completes\n"), 50);
  const response = await prompt.respond({
    status: "needs_input",
    operation: "audit",
    audit_brief: {
      project: { name: "launchrally", type: "web" },
      provider_roles: { candidates: [] },
      support_layers: { candidates: [] },
    },
    request: {
      validation_errors: [],
      fields: [{
        field_id: "core_journeys",
        value_type: "journey_array",
        prompt: "Which GET paths and user journeys must work for this release?",
        candidates: [],
        current_value: [],
      }],
    },
  });
  await prompt.close();

  assert.deepEqual(response, {
    answers: {
      core_journeys: [{
        method: "GET",
        path: "/checkout",
        purpose: "checkout completes",
      }],
    },
  });
  assert.match(rendered, /Use a safe GET Journey/u);
});

test("the Plain adapter accepts a safe GET path without requiring a purpose", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("2\n"), 10);
  setTimeout(() => input.write("GET /\n"), 30);
  setTimeout(() => input.write("GET /fallback — fallback loads\n"), 50);
  const response = await prompt.respond({
    status: "needs_input",
    operation: "audit",
    audit_brief: {
      project: { name: "launchrally", type: "web" },
      provider_roles: { candidates: [] },
      support_layers: { candidates: [] },
    },
    request: {
      validation_errors: [],
      fields: [{
        field_id: "core_journeys",
        value_type: "journey_array",
        prompt: "Which GET paths and user journeys must work for this release?",
        candidates: [],
        current_value: [],
      }],
    },
  });
  await prompt.close();

  assert.deepEqual(response, {
    answers: {
      core_journeys: [{ method: "GET", path: "/", purpose: "homepage loads" }],
    },
  });
  assert.doesNotMatch(rendered, /Use a safe GET Journey/u);
});

test("the Plain adapter uses numbered choices and default-deny confirmations without ANSI", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  await prompt.start();
  setTimeout(() => input.write("2\n"), 10);
  const confirmation = await prompt.respond({
    status: "needs_confirmation",
    operation: "audit",
    audit_brief: {
      intended_environment: { value: "production" },
      production_targets: { values: ["https://example.com/"] },
      core_journeys: { values: ["visitor can sign up"] },
      provider_roles: { values: [] },
      support_layers: { values: [] },
      planned_checks: [],
    },
    authorization_plan: [],
    request: { prompt: "Confirm this Audit Brief." },
  });

  setTimeout(() => input.write("\n"), 10);
  const permission = await prompt.respond({
    status: "needs_permission",
    operation: "audit",
    request: {
      permissions: [{
        permission_id: "public_verification",
        boundary: "public_network",
        scope: { targets: ["https://example.com/"] },
      }],
    },
  });
  await prompt.close();

  assert.deepEqual(confirmation, { confirmation: "revise" });
  assert.deepEqual(permission, {
    permission_decisions: { public_verification: "denied" },
  });
  assert.match(rendered, /Production targets:\s+  - https:\/\/example\.com\//u);
  assert.match(rendered, /1\. Confirm[\s\S]*2\. Revise[\s\S]*3\. Cancel/u);
  assert.match(rendered, /Public verification[\s\S]*\[y\/N\]/u);
  assert.doesNotMatch(rendered, /\u001b\[[0-?]*[ -\/]*[@-~]/u);
});

test("the Plain adapter labels targets with the intended staging environment", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("3\n"), 10);
  await prompt.respond({
    status: "needs_confirmation",
    operation: "audit",
    audit_brief: {
      intended_environment: { value: "staging" },
      production_targets: { values: ["https://staging.example.com/"] },
      core_journeys: { values: [] },
      provider_roles: { values: [] },
      support_layers: { values: [] },
      planned_checks: [],
    },
    authorization_plan: [],
    request: { prompt: "Confirm this Audit Brief." },
  });
  await prompt.close();

  assert.match(rendered, /Staging targets:\s+  - https:\/\/staging\.example\.com\//u);
  assert.doesNotMatch(rendered, /Production targets/u);
});

test("the Plain adapter labels custom and unknown target summaries", async () => {
  for (const [environment, expected] of [
    ["QA East", /QA East targets:\s+  - https:\/\/example\.com\//u],
    ["QA\u001bEast\u007f", /QA East targets:\s+  - https:\/\/example\.com\//u],
    [null, /Confirmed targets:\s+  - https:\/\/example\.com\//u],
  ]) {
    const input = ttyStream();
    const output = ttyStream();
    let rendered = "";
    output.on("data", (chunk) => {
      rendered += chunk.toString();
    });
    const prompt = createPlainPromptAdapter({ input, output });

    setTimeout(() => input.write("3\n"), 10);
    await prompt.respond({
      status: "needs_confirmation",
      operation: "audit",
      audit_brief: {
        intended_environment: { value: environment },
        production_targets: { values: ["https://example.com/"] },
        core_journeys: { values: [] },
        provider_roles: { values: [] },
        support_layers: { values: [] },
        planned_checks: [],
      },
      authorization_plan: [],
      request: { prompt: "Confirm this Audit Brief." },
    });
    await prompt.close();

    assert.match(rendered, expected);
    assert.doesNotMatch(rendered, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u);
    assert.doesNotMatch(rendered, /Production targets/u);
  }
});

test("the Clack adapter accepts injected TTY streams and keeps permission meaning in text", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = await createClackPromptAdapter({ input, output });

  await prompt.start();
  setTimeout(() => input.write("\r"), 20);
  const response = await prompt.respond({
    status: "needs_permission",
    operation: "audit",
    request: {
      permissions: [{
        permission_id: "public_verification",
        boundary: "public_network",
        scope: { targets: ["https://example.com/"] },
      }],
    },
  });
  await prompt.close();

  assert.deepEqual(response, {
    permission_decisions: { public_verification: "denied" },
  });
  const semanticOutput = stripVTControlCharacters(rendered);
  assert.match(semanticOutput, /LaunchRally Audit/u);
  assert.match(semanticOutput, /Permission request/u);
  assert.match(semanticOutput, /Public verification/u);
  assert.match(semanticOutput, /Targets: https:\/\/example\.com\//u);
  assert.match(semanticOutput, /Approve this permission\?/u);
});

test("the Clack adapter displays and completes active work", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = await createClackPromptAdapter({
    input,
    output,
    activityDelayMs: 0,
  });
  let finish;

  const activity = prompt.activity(
    "Verifying public Journeys…",
    async () => new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.match(stripVTControlCharacters(rendered), /Verifying public Journeys/u);
  finish("verified");
  assert.equal(await activity, "verified");
  await prompt.close();

  assert.match(
    stripVTControlCharacters(rendered),
    /Verifying public Journeys\./u,
  );
});

test("the Clack adapter cancels active work on SIGINT and removes its listener", async () => {
  const input = ttyStream();
  const output = ttyStream();
  const signals = new EventEmitter();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = await createClackPromptAdapter({
    input,
    output,
    signals,
    activityDelayMs: 0,
  });
  const activity = prompt.activity(
    "Reading Cloudflare Provider data…",
    async (signal) => new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }),
  );

  signals.emit("SIGINT");
  await assert.rejects(activity, PromptCancelledError);
  await prompt.close();

  assert.match(
    stripVTControlCharacters(rendered),
    /Cancelled: Reading Cloudflare Provider data\./u,
  );
  assert.equal(signals.listenerCount("SIGINT"), 0);
});

test("NO_COLOR Human Mode retains textual Clack activity states", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const presentation = humanAuditPresentationOptions({
    env: { NO_COLOR: "1" },
    output,
  });
  const prompt = await createClackPromptAdapter({
    input,
    output,
    activityDelayMs: 0,
  });

  await prompt.activity("Generating Audit Report…", async () => "complete");
  await prompt.close();

  assert.deepEqual(presentation, { plain: false, styled: false, width: 100 });
  assert.match(
    stripVTControlCharacters(rendered),
    /Completed: Generating Audit Report\./u,
  );
});

test("the Clack adapter uses a select prompt for the environment", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = await createClackPromptAdapter({ input, output });

  setTimeout(() => input.write("\r"), 20);
  const response = await prompt.respond({
    status: "needs_input",
    operation: "audit",
    audit_brief: {
      project: { name: "launchrally", type: "web" },
      provider_roles: { candidates: [] },
      support_layers: { candidates: [] },
    },
    request: {
      validation_errors: [],
      fields: [{
        field_id: "intended_environment",
        value_type: "string",
        prompt: "Which environment is this Audit preparing for?",
        candidates: [],
        current_value: null,
      }],
    },
  });
  await prompt.close();

  assert.deepEqual(response, { answers: { intended_environment: "production" } });
  const semanticOutput = stripVTControlCharacters(rendered);
  assert.match(semanticOutput, /Which environment is this Audit preparing for\? \(Required\)/u);
  assert.match(semanticOutput, /Production[\s\S]*Staging[\s\S]*Preview/u);
  assert.match(semanticOutput, /Other — enter a custom value/u);
});

test("the Clack adapter does not offer backward navigation", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = await createClackPromptAdapter({ input, output });

  setTimeout(() => input.write("\r"), 20);
  setTimeout(() => input.write("\r"), 60);
  const response = await prompt.respond({
    status: "needs_input",
    operation: "audit",
    audit_brief: {
      project: { name: "launchrally", type: "web" },
      provider_roles: { candidates: [] },
      support_layers: { candidates: [] },
    },
    request: {
      validation_errors: [],
      fields: [{
        field_id: "intended_environment",
        value_type: "string",
        prompt: "Which environment is this Audit preparing for?",
        candidates: [],
        current_value: null,
      }, {
        field_id: "support_layers",
        value_type: "string_array",
        prompt: "Which support layers should the Audit include?",
        candidates: [],
        current_value: [],
      }],
    },
  });
  await prompt.close();

  assert.deepEqual(response, {
    answers: {
      intended_environment: "production",
      support_layers: [],
    },
  });
  const semanticOutput = stripVTControlCharacters(rendered);
  assert.doesNotMatch(semanticOutput, /Back — change the previous answer/u);
  assert.doesNotMatch(semanticOutput, /enter :back/u);
});

test("the Clack adapter shows examples and validates required text input in place", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = await createClackPromptAdapter({ input, output });

  setTimeout(() => input.write("\r"), 20);
  setTimeout(() => input.write("https://app.example.com\r"), 60);
  const response = await prompt.respond({
    status: "needs_input",
    operation: "audit",
    audit_brief: {
      project: { name: "launchrally", type: "web" },
      provider_roles: { candidates: [] },
      support_layers: { candidates: [] },
    },
    request: {
      validation_errors: [],
      fields: [{
        field_id: "production_targets",
        value_type: "url_array",
        prompt: "Which confirmed public target URLs are in scope?",
        candidates: [],
        current_value: [],
      }],
    },
  });
  await prompt.close();

  assert.deepEqual(response, {
    answers: { production_targets: ["https://app.example.com"] },
  });
  const semanticOutput = stripVTControlCharacters(rendered);
  assert.match(semanticOutput, /Which confirmed public target URLs are in scope\? \(Required\)/u);
  assert.match(semanticOutput, /Example: https:\/\/app\.example\.com/u);
  assert.match(semanticOutput, /This field is required\./u);
});

test("the Clack adapter keeps an invalid production URL in the current question", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = await createClackPromptAdapter({ input, output });

  setTimeout(() => input.write("ht\r"), 20);
  setTimeout(() => input.write("\u0003"), 80);
  await assert.rejects(prompt.respond({
    status: "needs_input",
    operation: "audit",
    audit_brief: {
      project: { name: "launchrally", type: "web" },
      provider_roles: { candidates: [] },
      support_layers: { candidates: [] },
    },
    request: {
      validation_errors: [],
      fields: [{
        field_id: "production_targets",
        value_type: "url_array",
        prompt: "Which confirmed public target URLs are in scope?",
        candidates: [],
        current_value: [],
      }],
    },
  }), PromptCancelledError);
  await prompt.close();

  const semanticOutput = stripVTControlCharacters(rendered);
  assert.match(semanticOutput, /Enter a valid public http or https URL/u);
});

test("the Clack adapter uses a multi-select prompt for Provider roles", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = await createClackPromptAdapter({ input, output });

  setTimeout(() => input.write(" "), 20);
  setTimeout(() => input.write("\r"), 40);
  const response = await prompt.respond({
    status: "needs_input",
    operation: "audit",
    audit_brief: {
      project: { name: "launchrally", type: "web" },
      provider_roles: { candidates: [{ provider: "vercel", role: "deployment" }] },
      support_layers: { candidates: [] },
    },
    request: {
      validation_errors: [],
      fields: [{
        field_id: "provider_roles",
        value_type: "provider_role_array",
        prompt: "Which Providers and roles belong to this release?",
        candidates: [{ provider: "vercel", role: "deployment" }],
        current_value: [],
      }],
    },
  });
  await prompt.close();

  assert.deepEqual(response, {
    answers: { provider_roles: [{ provider: "cloudflare", role: "deployment" }] },
  });
  const semanticOutput = stripVTControlCharacters(rendered);
  assert.match(semanticOutput, /Vercel — deployment \(detected\)/u);
  assert.match(semanticOutput, /Sentry — observability/u);
  assert.match(semanticOutput, /Space: select/u);
});

test("the Clack adapter selects a recommended public Journey without free-form input", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = await createClackPromptAdapter({ input, output });

  setTimeout(() => input.write(" "), 20);
  setTimeout(() => input.write("\r"), 40);
  const response = await prompt.respond({
    status: "needs_input",
    operation: "audit",
    snapshot: { project: { facts: [] } },
    audit_brief: {
      project: { name: "launchrally", type: "web" },
      provider_roles: { candidates: [] },
      support_layers: { candidates: [] },
    },
    request: {
      validation_errors: [],
      fields: [{
        field_id: "core_journeys",
        value_type: "journey_array",
        prompt: "Which GET paths and user journeys must work for this release?",
        candidates: [],
        current_value: [],
      }],
    },
  });
  await prompt.close();

  assert.deepEqual(response, {
    answers: {
      core_journeys: [{ method: "GET", path: "/", purpose: "homepage loads" }],
    },
  });
  const semanticOutput = stripVTControlCharacters(rendered);
  assert.match(semanticOutput, /GET \/ — homepage loads \(recommended\)/u);
  assert.match(
    semanticOutput,
    /Skip public Journey verification — creates a Verification Gap/u,
  );
});

test("the Clack adapter selects only detected Journeys and allows individual deselection", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = await createClackPromptAdapter({ input, output });

  setTimeout(() => input.write(" "), 20);
  setTimeout(() => input.write("\u001b[B\u001b[B "), 40);
  setTimeout(() => input.write("\r"), 60);
  const response = await prompt.respond(journeyInput([
    "GET /dashboard — dashboard page loads",
    "GET /docs — docs page loads",
  ]));
  await prompt.close();

  assert.deepEqual(response, {
    answers: {
      core_journeys: [
        { method: "GET", path: "/docs", purpose: "docs page loads" },
      ],
    },
  });
  const semanticOutput = stripVTControlCharacters(rendered);
  assert.match(semanticOutput, /Select all detected journeys/u);
  assert.match(semanticOutput, /GET \/ — homepage loads \(recommended\)/u);
  assert.match(semanticOutput, /Other — enter a custom value/u);
  assert.match(semanticOutput, /Skip public Journey verification/u);
  assert.match(semanticOutput, /Space: toggle/u);
  assert.match(semanticOutput, /Enter: confirm/u);
  assert.match(semanticOutput, /› ◻ Select all detected journeys/u);
  assert.match(semanticOutput, /◻ Select all detected journeys/u);
  assert.match(semanticOutput, /◼ GET \/dashboard — dashboard page loads \(detected\)/u);
  assert.doesNotMatch(semanticOutput, /\[(?: |x)\]/u);
});

test("the Clack bulk action clears a recommended Journey selection", async () => {
  const input = ttyStream();
  const output = ttyStream();
  const prompt = await createClackPromptAdapter({ input, output });

  setTimeout(() => input.write("\u001b[B "), 20);
  setTimeout(() => input.write("\u001b[A "), 40);
  setTimeout(() => input.write("\r"), 60);
  const response = await prompt.respond(journeyInput([
    "GET /dashboard — dashboard page loads",
    "GET /docs — docs page loads",
  ]));
  await prompt.close();

  assert.deepEqual(response, {
    answers: {
      core_journeys: [
        { method: "GET", path: "/dashboard", purpose: "dashboard page loads" },
        { method: "GET", path: "/docs", purpose: "docs page loads" },
      ],
    },
  });
});

test("the Clack bulk action clears Other and Skip Journey selections", async () => {
  const input = ttyStream();
  const output = ttyStream();
  const prompt = await createClackPromptAdapter({ input, output });

  setTimeout(() => input.write("\u001b[B\u001b[B\u001b[B\u001b[B "), 20);
  setTimeout(() => input.write("\u001b[B "), 40);
  setTimeout(() => input.write("\u001b[B "), 60);
  setTimeout(() => input.write("\r"), 80);
  const response = await prompt.respond(journeyInput([
    "GET /dashboard — dashboard page loads",
    "GET /docs — docs page loads",
  ]));
  await prompt.close();

  assert.deepEqual(response, {
    answers: {
      core_journeys: [
        { method: "GET", path: "/dashboard", purpose: "dashboard page loads" },
        { method: "GET", path: "/docs", purpose: "docs page loads" },
      ],
    },
  });
});

test("the Clack A shortcut selects only detected Journeys and remains editable", async () => {
  const input = ttyStream();
  const output = ttyStream();
  const prompt = await createClackPromptAdapter({ input, output });

  setTimeout(() => input.write("\u001b[B "), 20);
  setTimeout(() => input.write("\u001b[B\u001b[B\u001b[B "), 40);
  setTimeout(() => input.write("\u001b[B "), 60);
  setTimeout(() => input.write("a"), 80);
  setTimeout(() => input.write("\u001b[A\u001b[A "), 100);
  setTimeout(() => input.write("\r"), 120);
  const response = await prompt.respond(journeyInput([
    "GET /dashboard — dashboard page loads",
    "GET /docs — docs page loads",
  ]));
  await prompt.close();

  assert.deepEqual(response, {
    answers: {
      core_journeys: [
        { method: "GET", path: "/dashboard", purpose: "dashboard page loads" },
      ],
    },
  });
});

test("the Clack adapter accepts a safe GET path without requiring a purpose", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = await createClackPromptAdapter({ input, output });

  setTimeout(() => input.write("\u001b[B \r"), 20);
  setTimeout(() => input.write("GET /\r"), 60);
  const response = await prompt.respond({
    status: "needs_input",
    operation: "audit",
    audit_brief: {
      project: { name: "launchrally", type: "web" },
      provider_roles: { candidates: [] },
      support_layers: { candidates: [] },
    },
    request: {
      validation_errors: [],
      fields: [{
        field_id: "core_journeys",
        value_type: "journey_array",
        prompt: "Which GET paths and user journeys must work for this release?",
        candidates: [],
        current_value: [],
      }],
    },
  });
  await prompt.close();

  assert.deepEqual(response, {
    answers: {
      core_journeys: [{ method: "GET", path: "/", purpose: "homepage loads" }],
    },
  });
  const semanticOutput = stripVTControlCharacters(rendered);
  assert.doesNotMatch(semanticOutput, /Use a safe GET Journey/u);
});

test("the Clack adapter accepts the suggested Report path and discloses its destination", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = await createClackPromptAdapter({ input, output });
  const suggestedPath = "/workspace/launchrally-audit-report.json";

  setTimeout(() => input.write("\u001b[C"), 20);
  setTimeout(() => input.write("\r"), 40);
  setTimeout(() => input.write("\r"), 80);
  const choice = await prompt.reportSave({
    phase: "choose",
    suggested_path: suggestedPath,
    file_picker_available: false,
  });
  await prompt.close();

  assert.deepEqual(choice, { output_path: suggestedPath, suggested: true });
  const semanticOutput = stripVTControlCharacters(rendered);
  assert.match(semanticOutput, /Save the complete Audit JSON to a file\?/u);
  assert.match(semanticOutput, /Use suggested path — \/workspace\/launchrally-audit-report\.json/u);
});

test("the Clack adapter validates and accepts a custom Report path", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = await createClackPromptAdapter({ input, output });

  setTimeout(() => input.write("\u001b[C"), 20);
  setTimeout(() => input.write("\r"), 40);
  setTimeout(() => input.write("\u001b[B"), 80);
  setTimeout(() => input.write("\r"), 100);
  setTimeout(() => input.write("\r"), 140);
  setTimeout(() => input.write("reports/custom.json\r"), 180);
  const choice = await prompt.reportSave({
    phase: "choose",
    suggested_path: "/workspace/launchrally-audit-report.json",
    file_picker_available: false,
  });
  await prompt.close();

  assert.deepEqual(choice, { output_path: "reports/custom.json" });
  assert.match(stripVTControlCharacters(rendered), /This field is required\./u);
});

test("the Clack adapter offers the system file picker when it is available", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = await createClackPromptAdapter({ input, output });

  setTimeout(() => input.write("\u001b[B"), 20);
  setTimeout(() => input.write("\r"), 40);
  const choice = await prompt.reportSave({
    phase: "choose",
    suggested_path: "/workspace/launchrally-audit-report.json",
    file_picker_available: true,
    save_confirmed: true,
  });
  await prompt.close();

  assert.deepEqual(choice, { file_picker: true });
  assert.match(stripVTControlCharacters(rendered), /Open the system file picker/u);
});

test("the Clack adapter declines Report saving by default", async () => {
  const input = ttyStream();
  const output = ttyStream();
  const prompt = await createClackPromptAdapter({ input, output });

  setTimeout(() => input.write("\r"), 20);
  const choice = await prompt.reportSave({
    phase: "choose",
    suggested_path: "/workspace/launchrally-audit-report.json",
    file_picker_available: false,
  });
  await prompt.close();

  assert.deepEqual(choice, {});
});

test("the Clack adapter requires a separate collision decision", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = await createClackPromptAdapter({ input, output });

  setTimeout(() => input.write("\r"), 20);
  const confirmation = await prompt.reportSave({
    phase: "confirm",
    resolved_path: "/workspace/launchrally-audit-report.json",
    collision: true,
  });
  await prompt.close();

  assert.deepEqual(confirmation, { decision: "choose_another" });
  const semanticOutput = stripVTControlCharacters(rendered);
  assert.match(semanticOutput, /A file already exists at this destination\./u);
  assert.match(semanticOutput, /Overwrite the existing file/u);
  assert.match(semanticOutput, /Choose another path/u);
  assert.match(semanticOutput, /Do not save/u);
});

test("the Clack adapter cancels Report saving on Ctrl-C", async () => {
  const input = ttyStream();
  const output = ttyStream();
  const prompt = await createClackPromptAdapter({ input, output });

  setTimeout(() => input.write("\u0003"), 20);
  await assert.rejects(prompt.reportSave({
    phase: "choose",
    suggested_path: "/workspace/launchrally-audit-report.json",
    file_picker_available: false,
  }), PromptCancelledError);
  await prompt.close();
});

test("the Plain adapter accepts the suggested Report path and discloses its destination", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });
  const suggestedPath = "/workspace/launchrally-audit-report.json";

  setTimeout(() => input.write("y\n"), 10);
  setTimeout(() => input.write("1\n"), 30);
  const choice = await prompt.reportSave({
    phase: "choose",
    suggested_path: suggestedPath,
    file_picker_available: false,
  });
  await prompt.close();

  assert.deepEqual(choice, { output_path: suggestedPath, suggested: true });
  assert.match(rendered, /Save the complete Audit JSON to a file\? \[y\/N\]/u);
  assert.match(rendered, /1\. Use suggested path — \/workspace\/launchrally-audit-report\.json/u);
});

test("the Plain adapter validates a custom Report path", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("y\n"), 10);
  setTimeout(() => input.write("2\n"), 30);
  setTimeout(() => input.write("\n"), 50);
  setTimeout(() => input.write("reports/custom.json\n"), 70);
  const choice = await prompt.reportSave({
    phase: "choose",
    suggested_path: "/workspace/launchrally-audit-report.json",
    file_picker_available: false,
  });
  await prompt.close();

  assert.deepEqual(choice, { output_path: "reports/custom.json" });
  assert.match(rendered, /Enter a non-empty Report path\./u);
});

test("the Plain adapter offers the system file picker when it is available", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("y\n"), 10);
  setTimeout(() => input.write("2\n"), 30);
  const choice = await prompt.reportSave({
    phase: "choose",
    suggested_path: "/workspace/launchrally-audit-report.json",
    file_picker_available: true,
  });
  await prompt.close();

  assert.deepEqual(choice, { file_picker: true });
  assert.match(rendered, /2\. Open the system file picker/u);
});

test("the Plain adapter never treats a colliding Report path as ordinary confirmation", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });
  const resolvedPath = "/workspace/launchrally-audit-report.json";

  setTimeout(() => input.write("2\n"), 10);
  setTimeout(() => input.write("n\n"), 30);
  const confirmation = await prompt.reportSave({
    phase: "confirm",
    resolved_path: resolvedPath,
    collision: true,
  });
  await prompt.close();

  assert.deepEqual(confirmation, { decision: "choose_another" });
  assert.match(rendered, /A file already exists at this destination\./u);
  assert.match(rendered, /1\. Overwrite the existing file/u);
  assert.match(rendered, /2\. Choose another path/u);
  assert.match(rendered, /3\. Do not save/u);
});

test("the Plain adapter declines Report saving by default", async () => {
  const input = ttyStream();
  const output = ttyStream();
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("\n"), 10);
  const choice = await prompt.reportSave({
    phase: "choose",
    suggested_path: "/workspace/launchrally-audit-report.json",
    file_picker_available: false,
  });
  await prompt.close();

  assert.deepEqual(choice, {});
});

test("the Plain adapter cancels Report saving on Ctrl-C", async () => {
  const input = ttyStream();
  const output = ttyStream();
  const signals = new EventEmitter();
  const prompt = createPlainPromptAdapter({ input, output, signals });

  setTimeout(() => signals.emit("SIGINT"), 10);
  await assert.rejects(prompt.reportSave({
    phase: "choose",
    suggested_path: "/workspace/launchrally-audit-report.json",
    file_picker_available: false,
  }), PromptCancelledError);
  await prompt.close();
});

test("the Plain adapter turns process SIGINT into a recoverable prompt cancellation", async () => {
  const input = ttyStream();
  const output = ttyStream();
  const signals = new EventEmitter();
  const prompt = createPlainPromptAdapter({ input, output, signals });
  const permission = {
    status: "needs_permission",
    operation: "audit",
    request: {
      permissions: [{
        permission_id: "public_verification",
        boundary: "public_network",
        scope: { targets: ["https://example.com/"] },
      }],
    },
  };

  setTimeout(() => signals.emit("SIGINT"), 10);
  setTimeout(() => input.write("\n"), 30);
  await assert.rejects(prompt.respond(permission), PromptCancelledError);
  await prompt.close();
  assert.equal(signals.listenerCount("SIGINT"), 0);
});
