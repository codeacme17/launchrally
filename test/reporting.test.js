import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MANIFEST_SCHEMA,
  MANIFEST_CONTRACT_MAJOR,
  REPORT_SCHEMA,
  REPORT_CONTRACT_MAJOR,
  assertSupportedManifestVersion,
  assertSupportedReportVersion,
} from "../packages/contracts/src/index.js";
import {
  renderReportMarkdown,
  runAudit,
} from "../packages/core/src/index.js";

const ANSWERS = Object.freeze({
  intended_environment: "production",
  production_targets: ["https://example.com"],
  core_journeys: ["homepage loads"],
  provider_roles: [],
  support_layers: [],
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-report-"));
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "report-web", scripts: { build: "vite build" } }),
  );
  await writeFile(path.join(directory, "package-lock.json"), '{"lockfileVersion":3}');
  return directory;
}

async function reachConfirmation(directory) {
  const initial = await runAudit(directory, "0.1.0");
  return runAudit(directory, "0.1.0", {
    resume_token: initial.interaction.resume_token,
    answers: ANSWERS,
  });
}

async function complete(directory, finalOptions = {}) {
  const confirmation = await reachConfirmation(directory);
  const permission = await runAudit(directory, "0.1.0", {
    resume_token: confirmation.interaction.resume_token,
    confirmation: "confirm",
  });
  return runAudit(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
    ...finalOptions,
  });
}

function evidenceReferences(report) {
  return [
    ...report.results.public_evidence_refs,
    ...report.results.provider_evidence_refs,
    ...report.results.checks.flatMap((check) => [
      ...check.applicability.evidence,
      ...check.evidence,
    ]),
  ];
}

test("every completed Audit returns one frozen Record, derived Markdown View, and Evidence Index", async () => {
  const directory = await fixture();
  const before = await readdir(directory);
  const result = await complete(directory);
  const { report, report_view: view, evidence_index: index } = result;

  assert.equal(report.schema_version, REPORT_SCHEMA);
  assert.ok(report.report_id);
  assert.ok(!Number.isNaN(Date.parse(report.created_at)));
  assert.equal(report.provenance.generator_version, "report-generator/v1");
  assert.deepEqual(report.policy, {
    engine_version: "launch-policy-engine/v1",
    current: true,
    currentness: {
      status: "current",
      evaluated_at: report.created_at,
      reasons: [],
    },
  });
  assert.ok(report.results.checks.every((check) => typeof check.gating === "boolean"));
  assert.ok(report.results.action_queue.every((item) =>
    report.results.checks.some(
      (check) => check.check_id === item.check_id && check.status === "failed",
    ),
  ));
  assert.ok(report.results.verification_gaps.every((gap) => gap.status === "unverified"));
  assert.deepEqual(report.permissions, result.authorization_plan);
  assert.equal(report.scope.release_intent.confirmed, true);
  assert.equal(report.execution.disclosure_version, "audit-execution-disclosure/v1");
  assert.equal(report.execution.evidence_index.index_id, index.index_id);
  assert.equal(report.execution.evidence_index.entry_count, index.entries.length);
  assert.equal(index.report_id, report.report_id);
  assert.equal(view.report_id, report.report_id);
  assert.equal(view.report_schema_version, report.schema_version);
  assert.equal(view.content, renderReportMarkdown(report));
  assert.deepEqual(result.next, {
    type: "init",
    required: false,
    report_id: report.report_id,
    message: "Save this complete Audit JSON, then run rally init --report <path> to preview adoption.",
  });
  assert.match(view.content, /^# LaunchRally Audit Report/mu);
  assert.match(view.content, new RegExp(`Report Record: ${report.report_id}`, "u"));
  assert.match(view.content, /Assessment: Inconclusive/u);

  const indexedDigests = new Set(index.entries.map((entry) => entry.digest));
  const references = evidenceReferences(report);
  assert.ok(references.length > 0);
  assert.ok(references.every((reference) => indexedDigests.has(reference.digest)));
  assert.ok(index.entries.every((entry) => /^sha256:[a-f0-9]{64}$/u.test(entry.digest)));
  assert.ok(index.entries.every((entry) => entry.source && entry.target));
  assert.ok(index.entries.every((entry) => !Number.isNaN(Date.parse(entry.collected_at))));
  assert.ok(index.entries.every((entry) => entry.freshness_class && entry.redaction_state));
  assert.ok(index.entries.every((entry) => entry.current === true));
  assert.ok(index.entries.every(
    (entry) => entry.currentness.status === "current"
      && entry.currentness.evaluated_at === report.created_at,
  ));
  assert.doesNotMatch(JSON.stringify(report), /normalized_artifact/u);

  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.scope));
  assert.ok(Object.isFrozen(report.permissions));
  assert.ok(Object.isFrozen(index));
  assert.throws(() => {
    report.assessment = "launch_ready";
  }, TypeError);
  assert.throws(() => {
    index.entries.push({});
  }, TypeError);
  assert.deepEqual(await readdir(directory), before);
});

test("repeated Audits create new Records and Indexes without mutating earlier results", async () => {
  const directory = await fixture();
  const first = await complete(directory);
  const firstSnapshot = JSON.stringify(first);
  const second = await complete(directory);

  assert.notEqual(second.report.report_id, first.report.report_id);
  assert.notEqual(second.evidence_index.index_id, first.evidence_index.index_id);
  assert.ok(!Number.isNaN(Date.parse(first.report.created_at)));
  assert.ok(!Number.isNaN(Date.parse(second.report.created_at)));
  assert.equal(JSON.stringify(first), firstSnapshot);
});

test("an unconfirmed scope still produces a useful local Record with execution gaps", async () => {
  const directory = await fixture();
  const confirmation = await reachConfirmation(directory);
  const result = await runAudit(directory, "0.1.0", {
    resume_token: confirmation.interaction.resume_token,
    confirmation: "cancel",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.outcome, "scope_not_confirmed");
  assert.ok(result.report);
  assert.equal(result.report.scope.release_intent.confirmed, false);
  assert.ok(result.report.permissions.some((permission) => permission.decision === "pending"));
  assert.ok(result.report.results.verification_gaps.some(
    (gap) => gap.reason_code === "execution_skipped",
  ));
  assert.deepEqual(result.report.results.public_evidence_refs, []);
  assert.deepEqual(result.report.results.provider_evidence_refs, []);
  assert.equal(result.report_view.content, renderReportMarkdown(result.report));
});

test("declared content changes make the Record and derived View non-current", async () => {
  const directory = await fixture();
  const result = await complete(directory, {
    content_changes: ["package_manifest_changed"],
  });

  assert.equal(result.report.policy.current, false);
  assert.equal(result.report.assessment, null);
  assert.ok(result.report.policy.currentness.reasons.some((reason) =>
    reason.reason_code === "content_changed"
    && reason.check_id === "web.baseline.package-manifest",
  ));
  assert.equal(result.report_view.content, renderReportMarkdown(result.report));
  assert.match(result.report_view.content, /Assessment: Not Current/u);
  assert.match(result.report_view.content, /Report Current: No/u);
  const packageEvidence = result.evidence_index.entries.find(
    (entry) => entry.target === "repository:package.json",
  );
  assert.equal(packageEvidence.current, false);
  assert.ok(packageEvidence.currentness.reasons.some((reason) =>
    reason.reason_code === "content_changed",
  ));
});

test("Manifest and Report major versions are independent and future majors fail closed", () => {
  assert.equal(MANIFEST_CONTRACT_MAJOR, 2);
  assert.equal(REPORT_CONTRACT_MAJOR, 2);
  assert.equal(assertSupportedManifestVersion(MANIFEST_SCHEMA), 2);
  assert.equal(assertSupportedReportVersion(REPORT_SCHEMA), 2);
  assert.equal(assertSupportedManifestVersion({ schema_version: MANIFEST_SCHEMA }), 2);
  assert.equal(assertSupportedReportVersion({ schema_version: REPORT_SCHEMA }), 2);
  assert.equal(assertSupportedReportVersion("launchrally.dev/report/v1"), 1);

  assert.throws(
    () => assertSupportedManifestVersion("launchrally.dev/manifest/v3"),
    (error) => error.code === "unsupported_manifest_version",
  );
  assert.throws(
    () => assertSupportedReportVersion("launchrally.dev/report/v3"),
    (error) => error.code === "unsupported_report_version",
  );
  assert.throws(
    () => renderReportMarkdown({ schema_version: "launchrally.dev/report/v3" }),
    (error) => error.code === "unsupported_report_version",
  );
  assert.equal(assertSupportedManifestVersion(MANIFEST_SCHEMA), 2);
});
