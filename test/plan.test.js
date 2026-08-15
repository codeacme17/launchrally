import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { assertValidLaunchPlan } from "../packages/contracts/src/index.js";
import {
  evaluateReportCurrentness,
  runAudit,
  runPlan as runPlanCore,
} from "../packages/core/src/index.js";

const execFileAsync = promisify(execFile);
const cli = path.resolve("packages/cli/bin/rally.js");

function runPlan(reportPackage, options = {}) {
  return runPlanCore(reportPackage, {
    ...(reportPackage?.report?.scope?.project_root
      ? { cwd: reportPackage.report.scope.project_root }
      : {}),
    ...options,
  });
}

const ANSWERS = Object.freeze({
  intended_environment: "production",
  production_targets: ["https://example.com"],
  core_journeys: ["homepage loads"],
  provider_roles: [],
  support_layers: [],
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-plan-"));
  await writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify({ name: "plan-web", scripts: {} }, null, 2)}\n`,
  );
  return directory;
}

async function completeAudit(directory, finalOptions = {}) {
  const initial = await runAudit(directory, "0.1.0");
  const confirmation = await runAudit(directory, "0.1.0", {
    resume_token: initial.interaction.resume_token,
    answers: ANSWERS,
  });
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

async function unconfirmedAudit(directory) {
  const initial = await runAudit(directory, "0.1.0");
  const confirmation = await runAudit(directory, "0.1.0", {
    resume_token: initial.interaction.resume_token,
    answers: ANSWERS,
  });
  return runAudit(directory, "0.1.0", {
    resume_token: confirmation.interaction.resume_token,
    confirmation: "cancel",
  });
}

test("a complete current Report becomes a prioritized explanatory read-only Launch Plan", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);

  const result = runPlan(audit);

  assert.equal(result.contract, "launchrally.dev/cli/v2");
  assert.equal(result.schema_version, "launchrally.dev/launch-plan/v2");
  assert.equal(result.status, "completed");
  assert.equal(result.operation, "plan");
  assert.equal(result.source_report_id, audit.report.report_id);
  assert.equal(result.read_only, true);
  assert.deepEqual(
    result.items.map((item) => item.check_id),
    audit.report.results.action_queue.map((item) => item.check_id),
  );
  assert.deepEqual(result.items[0], {
    rank: 1,
    check_id: "web.baseline.build-command",
    priority: "p0",
    severity: "critical",
    gating: true,
    priority_basis: {
      severity: "critical",
      dependency_unblocking: true,
      core_journey_impact: "direct",
    },
    problem: "The root package manifest does not declare a build command.",
    release_impact:
      "This Critical Finding gates the declared production release and directly affects a core journey.",
    investigation: {
      risk_domain: "deployment",
      required_inputs: ["project.script_names"],
      evidence_targets: ["repository:package.json"],
      verification_rules: [
        "Pass when the root package manifest declares a build script.",
        "Fail when a valid conventional Web manifest has no build script.",
      ],
    },
    remediation: "Declare the production build command in the root package manifest.",
    evidence_to_recollect: {
      accepted_kinds: ["file"],
      minimum_items: 1,
      provenance_required: true,
      freshness: {
        mode: "content_bound",
        invalidated_by: ["build_command_changed", "scan_policy_changed"],
      },
      instruction: "Recollect file Evidence for web.baseline.build-command, then run Verify.",
    },
  });
});

test("Verification Gaps remain separate investigation or permission work, not confirmed fixes", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);

  const result = runPlan(audit);

  assert.equal(result.verification_gaps.length > 0, true);
  assert.ok(result.verification_gaps.every((gap) => gap.confirmed_fix === false));
  assert.ok(result.verification_gaps.every((gap) => !("remediation" in gap)));
  assert.ok(result.verification_gaps.every((gap) =>
    !result.items.some((item) => item.check_id === gap.check_id)));
  assert.deepEqual(
    [...new Set(result.verification_gaps.map((gap) => gap.work_type))].sort(),
    ["investigation", "permission_request"],
  );
  const denied = result.verification_gaps.find(
    (gap) => gap.reason_code === "permission_denied",
  );
  assert.equal(denied.work_type, "permission_request");
  assert.equal(
    denied.next_action,
    "Request explicit read permission before recollecting Evidence; do not treat this Gap as a confirmed fix.",
  );
});

test("the same Report produces byte-stable plan data with disclosed ordering semantics", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);

  const first = runPlan(audit);
  const second = runPlan(audit);

  assert.deepEqual(second, first);
  assert.deepEqual(first.determinism, {
    source: "report_action_queue",
    ordering: ["severity", "dependency_unblocking", "core_journey_impact"],
    generated_timestamps: false,
  });
});

test("planning fails closed without a complete current Report", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const nonCurrent = await completeAudit(directory, {
    content_changes: ["package_manifest_changed"],
  });

  assert.deepEqual(runPlan(), {
    contract: "launchrally.dev/cli/v2",
    status: "unavailable",
    operation: "plan",
    reason: "complete_report_required",
    message: "Supply a saved complete current Audit Report before planning.",
  });
  const incomplete = runPlan({
    status: audit.status,
    operation: audit.operation,
    report: audit.report,
  });
  assert.equal(incomplete.status, "execution_error");
  assert.equal(incomplete.error, "invalid_report_package");
  assert.deepEqual(runPlan(nonCurrent), {
    contract: "launchrally.dev/cli/v2",
    status: "needs_refresh",
    operation: "plan",
    reason: "current_report_required",
    source_report_id: nonCurrent.report.report_id,
    request: {
      type: "refresh",
      operation: "verify",
      scope: "full",
    },
    message: "The saved Report is non-current; run full Verify before planning remediation.",
  });
});

test("read-time repository drift blocks Plan", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  await writeFile(path.join(directory, "new-runtime-config.json"), '{"enabled":true}\n');

  const plan = runPlan(audit);
  assert.equal(plan.status, "needs_refresh");
  assert.equal(plan.reason, "current_report_required");

});

test("read-time support versions and Not Applicable evidence cannot be forged current", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const unsupportedProfile = structuredClone(audit);
  unsupportedProfile.report.provenance.active_profile_versions = ["unknown-profile/v9"];
  unsupportedProfile.report.catalog.versions.active_profiles = ["unknown-profile/v9"];
  assert.equal(runPlan(unsupportedProfile).status, "needs_refresh");

  const missingApplicabilityEvidence = structuredClone(audit);
  const notApplicable = missingApplicabilityEvidence.report.results.checks.find(
    (check) => check.status === "not_applicable",
  );
  const removedDigest = notApplicable.applicability.evidence[0].digest;
  missingApplicabilityEvidence.evidence_index.entries =
    missingApplicabilityEvidence.evidence_index.entries.filter(
      (entry) => entry.digest !== removedDigest,
    );
  assert.equal(runPlan(missingApplicabilityEvidence).status, "needs_refresh");
});

test("read-time currentness rejects Passed and Failed findings without declared Evidence", async () => {
  const directory = await fixture();
  const original = await completeAudit(directory);
  for (const status of ["passed", "failed"]) {
    const audit = structuredClone(original);
    const finding = audit.report.results.checks.find(
      (check) => check.status === status && check.evidence.length > 0,
    );
    assert.ok(finding, `expected an evidenced ${status} finding`);
    const removedDigest = finding.evidence[0].digest;
    audit.evidence_index.entries = audit.evidence_index.entries.filter(
      (entry) => entry.digest !== removedDigest,
    );

    const result = runPlan(audit);

    assert.equal(result.status, "needs_refresh");
    assert.equal(result.reason, "current_report_required");
  }
});

test("read-time currentness rejects tampered references and stored non-current Evidence", async () => {
  const directory = await fixture();
  const original = await completeAudit(directory);
  const finding = original.report.results.checks.find(
    (check) => check.status === "passed" && check.evidence.length > 0,
  );
  assert.ok(finding, "expected an evidenced passed finding");

  const tamperedReference = structuredClone(original);
  tamperedReference.report.results.checks
    .find((check) => check.check_id === finding.check_id)
    .evidence[0].source = "forged-source";

  const storedNonCurrent = structuredClone(original);
  const evidence = storedNonCurrent.evidence_index.entries.find(
    (entry) => entry.digest === finding.evidence[0].digest,
  );
  evidence.current = false;

  const storedNonCurrentStatus = structuredClone(original);
  storedNonCurrentStatus.evidence_index.entries.find(
    (entry) => entry.digest === finding.evidence[0].digest,
  ).currentness.status = "non_current";

  for (const reportPackage of [
    tamperedReference,
    storedNonCurrent,
    storedNonCurrentStatus,
  ]) {
    assert.equal(runPlan(reportPackage).status, "needs_refresh");
  }
});

test("read-time currentness uses current declarations and rederives gating", async () => {
  const directory = await fixture();
  const audit = structuredClone(await completeAudit(directory));
  const finding = audit.report.results.checks.find(
    (check) => check.status === "failed" && check.gating && check.evidence.length > 0,
  );
  assert.ok(finding, "expected an evidenced gating failure");
  const declaration = audit.report.catalog.checks.find(
    (check) => check.check_id === finding.check_id,
  );
  declaration.failure_evidence_requirement.accepted_kinds = ["release_intent"];
  const evidence = audit.evidence_index.entries.find(
    (entry) => entry.digest === finding.evidence[0].digest,
  );
  evidence.evidence_kind = "release_intent";
  finding.gating = false;

  const currentness = evaluateReportCurrentness(audit, { cwd: directory });

  assert.equal(currentness.current, false);
  assert.ok(currentness.currentness.reasons.some(
    (reason) => reason.reason_code === "insufficient_evidence",
  ));
  assert.ok(currentness.currentness.reasons.some(
    (reason) => reason.reason_code === "gating_policy_mismatch",
  ));
});

test("a valid historical Report without digest context needs refresh instead of throwing", async () => {
  const directory = await fixture();
  const historical = structuredClone(await completeAudit(directory));
  delete historical.report.verification_context;

  const result = runPlan(historical);

  assert.equal(result.status, "needs_refresh");
  assert.equal(result.reason, "current_report_required");
});

test("read-time currentness advances the clock for live Evidence", async () => {
  const directory = await fixture();
  const audit = structuredClone(await completeAudit(directory));
  const availability = audit.report.results.checks.find(
    (check) => check.check_id === "web.public.availability",
  );
  const evidence = audit.evidence_index.entries[0];
  availability.status = "passed";
  availability.evidence = [{
    digest: evidence.digest,
    source: evidence.source,
    target: evidence.target,
    collected_at: evidence.collected_at,
    freshness_class: evidence.freshness_class,
    redaction_state: evidence.redaction_state,
  }];
  const result = evaluateReportCurrentness(audit, {
    cwd: directory,
    now: () => new Date(Date.parse(evidence.collected_at) + 901_000),
  });

  assert.equal(result.current, false);
  assert.ok(result.currentness.reasons.some(
    (reason) => reason.reason_code === "live_evidence_stale",
  ));
});

test("planning rejects inconsistent Action Queue and Check relationships", async () => {
  const directory = await fixture();
  const audit = structuredClone(await completeAudit(directory));
  audit.report.results.action_queue[0].check_id = "missing.confirmed-finding";

  const result = runPlan(audit);

  assert.deepEqual(result, {
    contract: "launchrally.dev/cli/v2",
    status: "execution_error",
    operation: "plan",
    error: "invalid_report_relationships",
    message: "The saved Report has inconsistent Finding, Action Queue, or Verification Gap relationships.",
  });
});

test("planning rejects ambiguous or tampered Check and catalog relationships", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const changedDomain = structuredClone(audit);
  changedDomain.report.results.checks[0].risk_domain = "availability";
  const duplicateCheck = structuredClone(audit);
  duplicateCheck.report.results.checks.push(structuredClone(
    duplicateCheck.report.results.checks.find((check) => check.status === "passed"),
  ));
  const duplicateDeclaration = structuredClone(audit);
  duplicateDeclaration.report.catalog.checks.push(structuredClone(
    duplicateDeclaration.report.catalog.checks[0],
  ));

  for (const tampered of [changedDomain, duplicateCheck, duplicateDeclaration]) {
    const result = runPlan(tampered);
    assert.equal(result.status, "execution_error");
    assert.equal(result.error, "invalid_report_relationships");
  }
});

test("missing Provider login remains setup investigation and never requests permission again", async () => {
  const directory = await fixture();
  const audit = structuredClone(await completeAudit(directory));
  const gap = audit.report.results.verification_gaps.find(
    (candidate) => candidate.reason_code === "permission_denied",
  );
  gap.reason_code = "missing_provider_login";
  gap.reason = "The existing read-only Provider CLI is not authenticated.";

  const result = runPlan(audit);
  const plannedGap = result.verification_gaps.find(
    (candidate) => candidate.check_id === gap.check_id,
  );

  assert.equal(plannedGap.work_type, "investigation");
  assert.equal(
    plannedGap.next_action,
    "Authenticate the existing read-only Provider CLI outside LaunchRally, then recollect Evidence; LaunchRally never initiates login or handles credentials.",
  );
});

test("planning requires confirmed release intent before describing release impact", async () => {
  const directory = await fixture();
  const audit = await unconfirmedAudit(directory);

  const result = runPlan(audit);

  assert.deepEqual(result, {
    contract: "launchrally.dev/cli/v2",
    status: "unavailable",
    operation: "plan",
    reason: "confirmed_release_required",
    source_report_id: audit.report.report_id,
    message: "The saved Report has no confirmed release intent; run a new Audit before planning remediation.",
  });
});

test("Remediation Handoff occurs only after an explicit request and grants no write authority", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);

  const ordinaryPlan = runPlan(audit);
  const ambiguousPlan = runPlan(audit, { handoff_requested: "true" });
  const requestedPlan = runPlan(audit, { handoff_requested: true });

  assert.equal("handoff" in ordinaryPlan, false);
  assert.equal("handoff" in ambiguousPlan, false);
  assert.deepEqual(ordinaryPlan.next, {
    type: "remediation_handoff",
    required: false,
    message: "Request Remediation Handoff explicitly before the host Agent changes local code.",
  });
  assert.deepEqual(requestedPlan.handoff, {
    requested: true,
    owner: "host_agent",
    scope: "local_code_remediation",
    instructions: [
      "The host Agent owns any explicitly requested local remediation work.",
      "LaunchRally remains read-only and grants no deployment, production, or Provider-write authority.",
      "Implement only confirmed Finding work; keep Verification Gaps as investigation or permission work.",
    ],
    authority: {
      launchrally_mutation: false,
      provider_write_permission: "not_granted",
      deployment_write_permission: "not_granted",
      production_write_permission: "not_granted",
    },
    return_to_verify: {
      required: true,
      operation: "verify",
      message: "After remediation, run Verify to recollect required Evidence and produce a new Report.",
    },
  });
  assert.deepEqual(requestedPlan.next, requestedPlan.handoff.return_to_verify);
});

test("the structured Launch Plan is versioned and rejects incomplete plan items", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const plan = runPlan(audit, { handoff_requested: true });

  assert.equal(assertValidLaunchPlan(plan), true);
  const historical = structuredClone(plan);
  delete historical.authenticated_journeys;
  assert.equal(assertValidLaunchPlan(historical), true);
  const incomplete = structuredClone(plan);
  delete incomplete.items[0].problem;
  assert.throws(
    () => assertValidLaunchPlan(incomplete),
    (error) => error.code === "invalid_launch_plan",
  );
});

test("Agent Mode returns the structured Plan without changing the project", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const savedReports = await mkdtemp(path.join(os.tmpdir(), "launchrally-saved-report-"));
  const reportPath = path.join(savedReports, "audit.json");
  await writeFile(reportPath, JSON.stringify(audit));
  const beforeEntries = await readdir(directory);
  const beforePackage = await readFile(path.join(directory, "package.json"), "utf8");

  const processResult = await execFileAsync(process.execPath, [
    cli,
    "plan",
    "--json",
    "--cwd",
    directory,
    "--report",
    reportPath,
  ]);
  const result = JSON.parse(processResult.stdout);

  assert.deepEqual(result, runPlan(audit, { cwd: directory }));
  assert.deepEqual(result.effects, {
    source_mutation: "none",
    deployment_mutation: "none",
    provider_mutation: "none",
    production_mutation: "none",
  });
  assert.deepEqual(await readdir(directory), beforeEntries);
  assert.equal(await readFile(path.join(directory, "package.json"), "utf8"), beforePackage);
});

test("Plan currentness uses the explicit repository cwd rather than a Report-supplied path", async () => {
  const directory = await fixture();
  const unrelated = await fixture();
  await writeFile(path.join(unrelated, "package.json"), "{\"name\":\"unrelated\"}\n");
  const audit = structuredClone(await completeAudit(directory));
  audit.report.scope.project_root = unrelated;
  audit.report.scope.project.root = unrelated;

  const result = runPlan(audit, { cwd: directory });

  assert.equal(result.status, "completed");
  assert.equal(result.source_report_id, audit.report.report_id);
  assert.equal(runPlanCore(audit).status, "needs_refresh");
});

test("Plan preserves each protected declaration and its typed authenticated result", async () => {
  const directory = await fixture();
  const initial = await runAudit(directory, "0.1.0");
  const confirmation = await runAudit(directory, "0.1.0", {
    resume_token: initial.interaction.resume_token,
    answers: {
      ...ANSWERS,
      core_journeys: [{
        schema_version: "launchrally.dev/protected-journey/v1",
        method: "GET",
        path: "/control",
        purpose: "authenticated Core Journey",
        access: {
          authentication_class: "staff",
          authenticated_status_codes: [200],
        },
      }],
    },
  });
  const permission = await runAudit(directory, "0.1.0", {
    resume_token: confirmation.interaction.resume_token,
    confirmation: "confirm",
  });
  const input = await runAudit(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: {
      public_verification: "denied",
      authenticated_journey_verification: "approved",
    },
  });
  const audit = await runAudit(directory, "0.1.0", {
    resume_token: input.interaction.resume_token,
    journey_results: {
      schema_version: "launchrally.dev/authenticated-journey-results/v1",
      adapter_version: "host-agent-authenticated-journey/v1",
      results: [{
        journey_id: "target-1:journey-1:authenticated",
        status: "unverified",
        outcome: "insufficient_capability",
        status_code: null,
        collected_at: new Date().toISOString(),
      }],
    },
  });

  const result = runPlan(audit);
  assert.deepEqual(result.authenticated_journeys, [{
    journey_id: "target-1:journey-1:authenticated",
    target: "https://example.com/control",
    method: "GET",
    purpose: "authenticated Core Journey",
    authentication_class: "staff",
    expected_status_codes: [200],
    result: {
      status: "unverified",
      outcome: "unsupported_adapter",
      status_code: null,
      collected_at: audit.report.results.authenticated_journey_gaps[0].collected_at,
      verification_gap: true,
    },
  }]);
});

test("Human Mode explains Findings, investigation locations, Evidence, and Gaps separately", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const savedReports = await mkdtemp(path.join(os.tmpdir(), "launchrally-human-plan-"));
  const reportPath = path.join(savedReports, "audit.json");
  await writeFile(reportPath, JSON.stringify(audit));

  const processResult = await execFileAsync(process.execPath, [
    cli,
    "plan",
    "--cwd",
    directory,
    "--report",
    reportPath,
  ]);

  assert.match(processResult.stdout, /^LaunchRally Read-only Launch Plan/mu);
  assert.match(
    processResult.stdout,
    /1\. \[P0 CRITICAL\] web\.baseline\.build-command — RELEASE GATE/u,
  );
  assert.match(processResult.stdout, /What is wrong: The root package manifest/u);
  assert.match(processResult.stdout, /Why it affects release: This Critical Finding gates/u);
  assert.match(processResult.stdout, /Investigate: deployment/u);
  assert.match(processResult.stdout, /Evidence targets: repository:package\.json/u);
  assert.match(processResult.stdout, /Recollect: file Evidence/u);
  assert.match(processResult.stdout, /Verification Gaps \(not confirmed fixes\)/u);
  assert.match(processResult.stdout, /PERMISSION_REQUEST/u);
  assert.match(processResult.stdout, /Request Remediation Handoff explicitly/u);
});

test("the explicit CLI handoff assigns work to the host Agent and returns to Verify", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const savedReports = await mkdtemp(path.join(os.tmpdir(), "launchrally-handoff-plan-"));
  const reportPath = path.join(savedReports, "audit.json");
  await writeFile(reportPath, JSON.stringify(audit));

  const processResult = await execFileAsync(process.execPath, [
    cli,
    "plan",
    "--cwd",
    directory,
    "--report",
    reportPath,
    "--handoff",
  ]);

  assert.match(processResult.stdout, /Remediation Handoff \(explicitly requested\)/u);
  assert.match(processResult.stdout, /Owner: host Agent/u);
  assert.match(processResult.stdout, /Provider write permission: NOT GRANTED/u);
  assert.match(processResult.stdout, /After remediation, run Verify/u);
});
