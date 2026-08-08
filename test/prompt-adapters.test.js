import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";

import {
  createClackPromptAdapter,
  createPlainPromptAdapter,
} from "../packages/cli/bin/prompt-adapters.js";
import { PromptCancelledError } from "../packages/cli/bin/human-audit.js";

function ttyStream() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.columns = 100;
  stream.rows = 30;
  stream.setRawMode = () => stream;
  return stream;
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
  assert.match(rendered, /Which public Journeys should LaunchRally verify\? \(Choose one or Skip\)/u);
});

test("the Plain adapter offers safely detected public routes as Journey choices", async () => {
  const input = ttyStream();
  const output = ttyStream();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  const prompt = createPlainPromptAdapter({ input, output });

  setTimeout(() => input.write("2\n"), 10);
  setTimeout(() => input.write("GET /fallback — fallback loads\n"), 30);
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
