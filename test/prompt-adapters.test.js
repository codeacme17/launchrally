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
  assert.match(rendered, /1\. Confirm[\s\S]*2\. Revise[\s\S]*3\. Cancel/u);
  assert.match(rendered, /Public verification[\s\S]*\[y\/N\]/u);
  assert.doesNotMatch(rendered, /\u001b\[[0-?]*[ -\/]*[@-~]/u);
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
