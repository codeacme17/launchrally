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

  setTimeout(() => input.write("1,3\n"), 10);
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
        { provider: "clerk", role: "authentication" },
        { provider: "neon", role: "data" },
      ],
    },
  });
  assert.match(rendered, /Vercel — deployment \(detected\)/u);
  assert.match(rendered, /1\. Clerk — authentication/u);
  assert.match(rendered, /3\. Neon — data/u);
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
    /Classify detected routes before LaunchRally verifies them \(Route discovery does not establish access\./u,
  );
});

test("the Plain adapter requires access classification for every detected route", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  ["2\n", "1\n", "2\n", "2\n", "1\n"].forEach((answer, index) => {
    setTimeout(() => input.write(answer), 10 + (index * 20));
  });
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
  assert.match(rendered, /Classify GET \/ — homepage loads \(classification required/u);
  assert.match(rendered, /Classify GET \/dashboard — dashboard page loads \(classification required\)/u);
  assert.match(rendered, /Exclude — do not verify this route/u);
  assert.doesNotMatch(rendered, /\(detected\)/u);
});

test("the Plain adapter classifies mixed detected routes before verification", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  ["1\n", "3\n", "4\n", "2\n", "1\n"].forEach((answer, index) => {
    setTimeout(() => input.write(answer), 10 + (index * 20));
  });
  const response = await prompt.respond(journeyInput([
    "GET / — homepage loads",
    "GET /me/profile — profile page loads",
    "GET /control/staff — staff page loads",
    "GET /guardian/authorize — authorize page loads",
  ]));
  await prompt.close();

  assert.deepEqual(response.answers.core_journeys, [
    { method: "GET", path: "/", purpose: "homepage loads" },
    {
      schema_version: "launchrally.dev/protected-journey/v1",
      method: "GET",
      path: "/control/staff",
      purpose: "authenticated Core Journey",
      access: {
        authentication_class: "staff",
        anonymous_status_codes: [401, 403, 404],
        authenticated_status_codes: [200],
      },
    },
    {
      schema_version: "launchrally.dev/protected-journey/v1",
      method: "GET",
      path: "/guardian/authorize",
      purpose: "authenticated Core Journey",
      access: {
        authentication_class: "signed_token",
        anonymous_status_codes: [401, 403, 404],
        authenticated_status_codes: [200],
      },
    },
    {
      schema_version: "launchrally.dev/protected-journey/v1",
      method: "GET",
      path: "/me/profile",
      purpose: "authenticated Core Journey",
      access: {
        authentication_class: "user",
        anonymous_status_codes: [401, 403, 404],
        authenticated_status_codes: [200],
      },
    },
  ]);
  assert.match(rendered, /Route discovery does not establish access/u);
  assert.match(rendered, /Public — authorize anonymous GET; expect 200-299/u);
  assert.match(rendered, /User — anonymous expect 401\/403\/404; authenticated expect 200/u);
  assert.doesNotMatch(rendered, /Select all detected journeys/u);
});

test("the final Audit Brief shows Journey access and status expectations", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("1\n"), 10);
  await prompt.respond({
    status: "needs_confirmation",
    operation: "audit",
    audit_brief: {
      intended_environment: { value: "production" },
      production_targets: { values: ["https://example.com/"] },
      core_journeys: {
        values: [
          { method: "GET", path: "/", purpose: "homepage loads" },
          {
            schema_version: "launchrally.dev/protected-journey/v1",
            method: "GET",
            path: "/control",
            purpose: "authenticated Core Journey",
            access: {
              authentication_class: "staff",
              anonymous_status_codes: [404],
              authenticated_status_codes: [200],
            },
          },
        ],
      },
      provider_roles: { values: [] },
      support_layers: { values: [] },
      planned_checks: [],
    },
    request: { prompt: "Confirm?" },
  });
  await prompt.close();

  assert.match(rendered, /GET \/ — homepage loads \[access: public; anonymous: 200-299; authenticated: not applicable\]/u);
  assert.match(rendered, /GET \/control — authenticated Core Journey \[access: staff; anonymous: 404; authenticated: 200\]/u);
});

test("the Plain adapter can include public and exclude detected routes independently", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("1\n"), 10);
  setTimeout(() => input.write("2\n"), 30);
  setTimeout(() => input.write("1\n"), 50);
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
  assert.match(rendered, /Public — authorize anonymous GET/u);
  assert.match(rendered, /Exclude — do not verify this route/u);
  assert.doesNotMatch(rendered, /Select all detected journeys/u);
});

test("the Plain adapter creates a protected classification for a detected route", async () => {
  const input = ttyStream();
  const output = ttyStream();
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("3\n"), 10);
  setTimeout(() => input.write("2\n"), 30);
  setTimeout(() => input.write("1\n"), 50);
  const response = await prompt.respond(journeyInput([
    "GET /dashboard — dashboard page loads",
    "GET /docs — docs page loads",
  ]));
  await prompt.close();

  assert.deepEqual(response, {
    answers: {
      core_journeys: [
        {
          schema_version: "launchrally.dev/protected-journey/v1",
          method: "GET",
          path: "/dashboard",
          purpose: "authenticated Core Journey",
          access: {
            authentication_class: "staff",
            anonymous_status_codes: [401, 403, 404],
            authenticated_status_codes: [200],
          },
        },
      ],
    },
  });
});

test("the Plain adapter permits explicitly excluding every detected route", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("5\n"), 10);
  setTimeout(() => input.write("2\n"), 30);
  setTimeout(() => input.write("1\n"), 50);
  const response = await prompt.respond(journeyInput([
    "GET /dashboard — dashboard page loads",
    "GET /docs — docs page loads",
  ]));
  await prompt.close();

  assert.deepEqual(response, { answers: { core_journeys: [] } });
  assert.equal(rendered.match(/Exclude — do not verify this route/gu)?.length, 2);
});

test("the Plain adapter preserves current Journeys and retries Other with detected candidates", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });
  const interaction = journeyInput(["GET /dashboard — dashboard page loads"]);
  interaction.request.fields[0].current_value = [
    { method: "GET", path: "/pricing", purpose: "pricing loads" },
  ];

  ["5\n", "2\n", "POST /admin\n", "GET /extra — extra loads\n"].forEach(
    (answer, index) => setTimeout(() => input.write(answer), 10 + (index * 20)),
  );
  const response = await prompt.respond(interaction);
  await prompt.close();

  assert.deepEqual(response.answers.core_journeys, [
    { method: "GET", path: "/pricing", purpose: "pricing loads" },
    { method: "GET", path: "/extra", purpose: "extra loads" },
  ]);
  assert.match(rendered, /Other — enter a custom value/u);
  assert.match(rendered, /Use a safe GET Journey/u);
});

test("the Plain adapter does not offer unsupported protected access classes", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("2\n"), 10);
  setTimeout(() => input.write("3\n"), 30);
  const response = await prompt.respond(journeyInput([
    "GET /leaderboard — leaderboard page loads",
  ]));
  await prompt.close();

  assert.deepEqual(response.answers.core_journeys, []);
  assert.match(rendered, /protected access is unsupported for this path/u);
  assert.doesNotMatch(rendered, /User — anonymous expect/u);
  assert.match(rendered, /Skip public Journey verification/u);
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

test("the Plain adapter discloses every command in a compound Provider read", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("\n"), 10);
  const response = await prompt.respond({
    status: "needs_permission",
    operation: "audit",
    request: {
      permissions: [{
        permission_id: "provider_read:resend",
        boundary: "provider_read",
        scope: {
          provider: "resend",
          target: "authenticated_team_domains_and_recent_email_status",
          requested_fields: ["domains[].status", "emails[].last_event"],
          command: {
            executable: "resend",
            arguments: ["domains", "list", "--limit", "10", "--json"],
          },
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
      }],
    },
  });
  await prompt.close();

  assert.deepEqual(response, {
    permission_decisions: { "provider_read:resend": "denied" },
  });
  assert.match(rendered, /Commands:\s+  - resend domains list --limit 10 --json/u);
  assert.match(rendered, /  - resend emails list --limit 10 --json/u);
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
    answers: { provider_roles: [{ provider: "clerk", role: "authentication" }] },
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

test("the Clack adapter classifies detected routes without a bulk public action", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = await createClackPromptAdapter({ input, output });

  setTimeout(() => input.write("\r"), 20);
  setTimeout(() => input.write("\u001b[B\r"), 50);
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
      ],
    },
  });
  const semanticOutput = stripVTControlCharacters(rendered);
  assert.match(semanticOutput, /classification required/u);
  assert.match(semanticOutput, /Public — authorize anonymous GET/u);
  assert.match(semanticOutput, /Exclude — do not verify this route/u);
  assert.doesNotMatch(semanticOutput, /Select all detected journeys/u);
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
