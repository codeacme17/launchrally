import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { commandName } from "../packages/cli/bin/cli-arguments.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function text(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

function section(markdown, heading) {
  const start = markdown.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `missing ${heading} section`);
  const next = markdown.indexOf("\n## ", start + heading.length + 3);
  return markdown.slice(start, next === -1 ? undefined : next);
}

test("the public Phase 1 guide explains authority before the complete journey", async () => {
  const guide = await text("docs/getting-started/phase-1.md");
  const headings = [
    "Before granting authority",
    "1. Confirm Product Intent",
    "2. Review capabilities and architecture",
    "3. Build the Task Graph",
    "4. Approve an external handoff",
    "5. Verify independently",
    "Honest non-success paths",
    "Agent Mode and Human Mode",
    "Artifacts, privacy, and compatibility",
  ];
  let previous = -1;
  for (const heading of headings) {
    const position = guide.indexOf(`## ${heading}`);
    assert.ok(position > previous, `${heading} appears in journey order`);
    previous = position;
  }

  const authority = section(guide, "Before granting authority");
  for (const boundary of ["read", "persist", "external Executor", "fresh Verify"]) {
    assert.match(authority, new RegExp(boundary, "iu"));
  }
  assert.match(authority, /receipt[^\n]*claim/iu);
  assert.match(authority, /configuration[^\n]*(?:does not|never)[^\n]*(?:operational|outcome)/iu);

  const intent = section(guide, "1. Confirm Product Intent");
  assert.match(intent, /without (?:a )?PRD/iu);
  assert.match(intent, /local_semantic_analysis/u);
  assert.match(intent, /hard constraints?[^\n]*preferences?/iu);

  const architecture = section(guide, "2. Review capabilities and architecture");
  for (const term of [
    "Capability Graph",
    "Integration Contract",
    "Provider-neutral",
    "Architecture currentness",
  ]) assert.match(architecture, new RegExp(term, "iu"));
  assert.match(architecture, /non-canonical/iu);
  assert.match(architecture, /custom/iu);
  assert.match(architecture, /self-hosted/iu);

  const handoff = section(guide, "4. Approve an external handoff");
  for (const term of ["authority batch", "allowed effects", "prohibited effects", "authentication"] ) {
    assert.match(handoff, new RegExp(term, "iu"));
  }

  const verify = section(guide, "5. Verify independently");
  assert.match(verify, /environment/iu);
  assert.match(verify, /active verification/iu);
  assert.match(verify, /production[^\n]*default-denied/iu);

  const outcomes = section(guide, "Honest non-success paths");
  for (const outcome of [
    "denial",
    "missing Executor",
    "cancellation",
    "partial execution",
    "stale architecture",
    "unknown Provider",
    "active verification",
  ]) assert.match(outcomes, new RegExp(outcome, "iu"));

  const modes = section(guide, "Agent Mode and Human Mode");
  assert.match(modes, /typed[^\n]*interaction/iu);
  assert.match(modes, /never parse[^\n]*prose/iu);
  assert.match(modes, /cross-host/iu);
  assert.match(modes, /Human Mode[^\n]*(?:cannot|unavailable)/iu);

  const artifacts = section(guide, "Artifacts, privacy, and compatibility");
  for (const term of [
    "Phase 0",
    "Phase 1",
    "shareable",
    "local",
    "desktop",
    "host resume registry",
  ]) assert.match(artifacts, new RegExp(term, "iu"));
});

test("documented Phase 1 commands are equivalent across POSIX and PowerShell", async () => {
  const guide = await text("docs/getting-started/phase-1.md");
  const commandMatrix = JSON.parse(
    await text("skills/launchrally/references/phase-1-command-examples.json"),
  );
  assert.equal(commandMatrix.format, "launchrally-phase-1-command-examples");
  assert.deepEqual(commandMatrix.commands.map(({ operation }) => operation), [
    "architect",
    "plan",
    "handoff",
    "verify",
  ]);

  for (const example of commandMatrix.commands) {
    assert.equal(commandName(example.argv), example.operation);
    assert.ok(example.argv.includes("--json"));
    assert.match(guide, new RegExp(`### ${example.operation}`, "u"));
    assert.ok(guide.includes(example.posix), `${example.operation} POSIX example is public`);
    assert.ok(guide.includes(example.powershell), `${example.operation} PowerShell example is public`);
  }
});

test("the canonical Skill routes the complete Phase 1 typed journey", async () => {
  const [skill, journey, docsIndex, quickstart] = await Promise.all([
    text("skills/launchrally/SKILL.md"),
    text("skills/launchrally/references/phase-1-journey.md"),
    text("docs/README.md"),
    text("docs/getting-started/quickstart.md"),
  ]);
  assert.match(skill, /complete Phase 1[^\n]*phase-1-journey\.md/iu);
  assert.match(docsIndex, /getting-started\/phase-1\.md/u);
  assert.match(quickstart, /phase-1\.md/u);

  for (const operation of ["architect", "plan", "handoff", "verify"]) {
    assert.match(journey, new RegExp(`rally ${operation}`, "u"));
  }
  assert.match(journey, /launchrally\.dev\/cli\/v2/u);
  assert.match(journey, /receipt[^\n]*Machine Evidence/iu);
  assert.match(journey, /configuration[^\n]*(?:does not|never)[^\n]*(?:operational|outcome)/iu);
  assert.match(journey, /Human Mode/iu);
  assert.match(journey, /cross-host/iu);
});
