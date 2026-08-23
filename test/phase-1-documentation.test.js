import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { commandName } from "../packages/cli/bin/cli-arguments.js";
import { runCodexProductIntentDiscovery } from "../adapters/codex/launchrally/host-adapter/product-intent.js";
import { runClaudeProductIntentDiscovery } from "../adapters/claude/launchrally/host-adapter/product-intent.js";

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

function documentedArguments(command) {
  return command
    .replaceAll("\\\n", " ")
    .replaceAll("`\n", " ")
    .trim()
    .split(/\s+/u)
    .slice(1);
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
  assert.match(authority, /encrypted resumable interaction state/iu);

  const intent = section(guide, "1. Confirm Product Intent");
  assert.match(intent, /without (?:a )?PRD/iu);
  assert.match(intent, /local_semantic_analysis/u);
  assert.match(intent, /hard constraints?[^\n]*preferences?/iu);
  assert.match(intent, /@launchrally\/codex-plugin\/product-intent/u);
  assert.match(intent, /@launchrally\/claude-plugin\/product-intent/u);

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
  assert.match(verify, /--resume <verify-token>/u);
  assert.match(verify, /--permissions/u);
  assert.match(verify, /status: `?"completed"/u);

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
    assert.deepEqual(documentedArguments(example.posix), example.argv);
    assert.deepEqual(documentedArguments(example.powershell), example.argv);
    assert.ok(guide.includes(example.posix), `${example.operation} POSIX example is public`);
    assert.ok(guide.includes(example.powershell), `${example.operation} PowerShell example is public`);
    assert.notEqual(example.expected.status, "execution_error");
    assert.match(example.expected.contract, /^launchrally\.dev\//u);
    if (example.success_continuation) {
      assert.ok(guide.includes(example.success_continuation.posix));
      assert.ok(guide.includes(example.success_continuation.powershell));
      assert.equal(example.success_continuation.expected.status, "completed");
    }
  }
  assert.match(guide, /replace the example `2026-08-14`[^\n]*actual/iu);
});

test("Codex and Claude expose the same typed no-PRD Product Intent entry", async () => {
  for (const runDiscovery of [
    runCodexProductIntentDiscovery,
    runClaudeProductIntentDiscovery,
  ]) {
    const result = await runDiscovery(root);
    assert.equal(result.contract, "launchrally.dev/architect-interaction/v1");
    assert.equal(result.status, "needs_input");
    assert.equal(result.state, "intent_discovery");
    assert.equal(result.coverage.supported_sources.includes("local_safe_scan"), true);
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

test("the published Experimental migration path tracks the exact release version", async () => {
  const [rootPackage, release] = await Promise.all([
    text("package.json").then(JSON.parse),
    text("release/p1.json").then(JSON.parse),
  ]);
  const [
    migrationNotes,
    announcement,
    install,
    quickstart,
    skill,
    codexSkill,
    claudeSkill,
  ] = await Promise.all([
    text(release.experimental_publication.migration_notes),
    text(release.experimental_publication.announcement),
    text("docs/getting-started/install.md"),
    text("docs/getting-started/quickstart.md"),
    text("skills/launchrally/SKILL.md"),
    text("adapters/codex/launchrally/skills/launchrally/SKILL.md"),
    text("adapters/claude/launchrally/skills/launchrally/SKILL.md"),
  ]);
  const version = rootPackage.version;
  const heading = `Project Toolchain migration: 0.4.1 to ${version}`;
  const migration = section(migrationNotes, heading);
  const anchor = `p1-migration-notes.md#project-toolchain-migration-041-to-${version.replaceAll(".", "")}`;

  assert.equal(release.release_status, "experimental");
  assert.equal(release.experimental_publication.candidate_tag, `v${version}`);
  assert.equal(
    release.experimental_publication.migration_notes,
    "docs/maintainers/p1-migration-notes.md",
  );
  assert.match(migration, new RegExp(`@launchrally/cli@${version.replaceAll(".", "\\.")}`, "u"));
  assert.match(migration, new RegExp(`toolchain migrate --to ${version.replaceAll(".", "\\.")}`, "u"));
  assert.match(
    migration,
    new RegExp(
      `launcher_version[^\\n]*${version.replaceAll(".", "\\.")}[\\s\\S]*cli_version[^\\n]*0\\.4\\.1`,
      "u",
    ),
  );
  assert.match(migration, /### POSIX/u);
  assert.match(migration, /### PowerShell/u);
  assert.match(migration, /npm_registry_read/u);
  assert.match(migration, /--resume/u);
  assert.match(migration, /--confirm confirm/u);
  assert.match(migration, /execution_authority_changed/u);
  assert.match(migration, /Manifest-bound source Audit Report/iu);
  assert.match(migration, /new current Report/iu);
  assert.match(migration, /Codex Plugin/u);
  assert.match(migration, /Claude Plugin/u);

  for (const navigation of [announcement, install, quickstart]) {
    assert.ok(navigation.includes(anchor), `missing exact migration link: ${anchor}`);
  }
  for (const routedSkill of [skill, codexSkill, claudeSkill]) {
    assert.match(routedSkill, /p1-migration-notes\.md#project-toolchain-migration-041-to-042/u);
  }
});
