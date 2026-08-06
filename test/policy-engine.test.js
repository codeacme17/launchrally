import assert from "node:assert/strict";
import test from "node:test";

import { evaluateLaunchPolicy } from "../packages/core/src/index.js";

function declaration(check_id, severity, gate, remediation = {}) {
  return {
    check_id,
    severity_policy: { severity },
    release_gate_policy: { gate, unverified_blocks_launch_ready: true },
    freshness_behavior: remediation.freshness_behavior
      ?? { mode: "content_bound", invalidated_by: ["source change"] },
    remediation_order_policy: {
      dependency_unblocking: remediation.dependency_unblocking ?? false,
      core_journey_impact: remediation.core_journey_impact ?? "none",
    },
  };
}

function finding(check_id, status, action) {
  return {
    check_id,
    status,
    summary: `${check_id} is ${status}`,
    evidence: [],
    ...(action ? { action } : {}),
  };
}

function evaluate({
  declarations,
  checks,
  scope_confirmed = true,
  evidence_entries = [],
  evaluated_at = "2026-08-06T12:00:00.000Z",
  content_changes = [],
  additional_gaps = [],
}) {
  return evaluateLaunchPolicy({
    catalog: { checks: declarations },
    checks,
    scope: { confirmed: scope_confirmed, core_journeys: ["checkout"] },
    evidence_index: { entries: evidence_entries },
    evaluated_at,
    content_changes,
    additional_verification_gaps: additional_gaps,
  });
}

test("Passed and Not Applicable remain independent from severity and can be Launch Ready", () => {
  const result = evaluate({
    declarations: [
      declaration("critical-build", "critical", "always"),
      declaration("moderate-optional", "moderate", "never"),
    ],
    checks: [
      finding("critical-build", "passed"),
      finding("moderate-optional", "not_applicable"),
    ],
  });

  assert.equal(result.current, true);
  assert.equal(result.assessment, "launch_ready");
  assert.deepEqual(result.findings.map(({ check_id, status, severity, gating }) => ({
    check_id,
    status,
    severity,
    gating,
  })), [
    { check_id: "critical-build", status: "passed", severity: "critical", gating: true },
    {
      check_id: "moderate-optional",
      status: "not_applicable",
      severity: "moderate",
      gating: false,
    },
  ]);
  assert.deepEqual(result.action_queue, []);
  assert.deepEqual(result.verification_gaps, []);
  assert.deepEqual(result.coverage_summary, {
    applicable_checks: 1,
    passed_checks: 1,
    failed_checks: 0,
    unverified_checks: 0,
    not_applicable_checks: 1,
    coverage: "complete",
  });
});

test("a Critical failure is gating, produces No-Go, and is the only Action Queue item", () => {
  const result = evaluate({
    declarations: [
      declaration("critical-lockfile", "critical", "never", {
        dependency_unblocking: true,
        core_journey_impact: "indirect",
      }),
      declaration("major-observability", "major", "policy"),
    ],
    checks: [
      finding("critical-lockfile", "failed", "Commit the lockfile."),
      finding("major-observability", "passed"),
    ],
  });

  assert.equal(result.assessment, "no_go");
  assert.equal(result.findings[0].gating, true);
  assert.deepEqual(result.action_queue, [{
    check_id: "critical-lockfile",
    severity: "critical",
    gating: true,
    dependency_unblocking: true,
    core_journey_impact: "indirect",
    action: "Commit the lockfile.",
  }]);
  assert.deepEqual(result.verification_gaps, []);
});

test("insufficient Evidence remains Unverified and produces Inconclusive", () => {
  const result = evaluate({
    declarations: [
      declaration("critical-build", "critical", "always"),
      declaration("major-runtime-inputs", "major", "policy"),
    ],
    checks: [
      finding("critical-build", "passed"),
      {
        ...finding("major-runtime-inputs", "unverified"),
        reason_code: "missing_required_input",
      },
    ],
  });

  assert.equal(result.assessment, "inconclusive");
  assert.equal(result.findings[1].status, "unverified");
  assert.equal(result.findings[1].severity, "major");
  assert.equal(result.findings[1].gating, true);
  assert.deepEqual(result.action_queue, []);
  assert.deepEqual(result.verification_gaps, [{
    check_id: "major-runtime-inputs",
    severity: "major",
    gating: true,
    status: "unverified",
    reason_code: "missing_required_input",
    reason: "major-runtime-inputs is unverified",
  }]);
  assert.equal(result.coverage_summary.unverified_checks, 1);
  assert.equal(result.coverage_summary.coverage, "partial");
});

test("a Moderate failure is non-gating and produces Ready with Warnings", () => {
  const result = evaluate({
    declarations: [
      declaration("critical-build", "critical", "always"),
      declaration("moderate-docs", "moderate", "always"),
    ],
    checks: [
      finding("critical-build", "passed"),
      finding("moderate-docs", "failed", "Clarify the runbook."),
    ],
  });

  assert.equal(result.assessment, "ready_with_warnings");
  assert.equal(result.findings[1].status, "failed");
  assert.equal(result.findings[1].severity, "moderate");
  assert.equal(result.findings[1].gating, false);
  assert.equal(result.action_queue.length, 1);
  assert.deepEqual(result.verification_gaps, []);
});

test("Major policy gates require confirmed scope", () => {
  const input = {
    declarations: [declaration("major-runtime-inputs", "major", "policy")],
    checks: [finding("major-runtime-inputs", "failed", "Declare runtime inputs.")],
  };
  const confirmed = evaluate(input);
  const unconfirmed = evaluate({ ...input, scope_confirmed: false });

  assert.equal(confirmed.findings[0].gating, true);
  assert.equal(confirmed.assessment, "no_go");
  assert.equal(unconfirmed.findings[0].gating, false);
  assert.equal(unconfirmed.assessment, "ready_with_warnings");
});

test("Action Queue ordering uses severity, dependency unblocking, then journey impact", () => {
  const specs = [
    ["major-none", "major", false, "none"],
    ["critical-direct", "critical", false, "direct"],
    ["moderate-unblock", "moderate", true, "direct"],
    ["major-direct", "major", false, "direct"],
    ["critical-unblock", "critical", true, "none"],
    ["major-unblock", "major", true, "indirect"],
  ];
  const result = evaluate({
    declarations: specs.map(([id, severity, dependency_unblocking, core_journey_impact]) =>
      declaration(id, severity, "never", { dependency_unblocking, core_journey_impact }),
    ),
    checks: specs.map(([id]) => finding(id, "failed", `Fix ${id}.`)),
  });

  assert.deepEqual(result.action_queue.map((item) => item.check_id), [
    "critical-unblock",
    "critical-direct",
    "major-unblock",
    "major-direct",
    "major-none",
    "moderate-unblock",
  ]);
  assert.ok(result.action_queue.every((item) => !("risk_score" in item)));
});

test("stale live-state Evidence makes the Report non-current with no assessment", () => {
  const evidenceReference = {
    digest: "sha256:live-observation",
    collected_at: "2026-08-06T11:44:00.000Z",
  };
  const result = evaluate({
    declarations: [declaration("critical-availability", "critical", "always", {
      freshness_behavior: {
        mode: "live_state",
        max_age_seconds: 900,
        invalidated_by: ["deployment"],
      },
    })],
    checks: [{
      ...finding("critical-availability", "passed"),
      evidence: [evidenceReference],
    }],
    evidence_entries: [{
      ...evidenceReference,
      evidence_kind: "public_observation",
      normalized_artifact: {},
    }],
  });

  assert.equal(result.current, false);
  assert.equal(result.assessment, null);
  assert.deepEqual(result.currentness, {
    status: "non_current",
    evaluated_at: "2026-08-06T12:00:00.000Z",
    reasons: [{
      check_id: "critical-availability",
      reason_code: "live_evidence_stale",
      evidence_digest: "sha256:live-observation",
      collected_at: "2026-08-06T11:44:00.000Z",
      max_age_seconds: 900,
    }],
  });
});

test("a declared content change makes prior Evidence and the Report non-current", () => {
  const result = evaluate({
    declarations: [declaration("critical-build", "critical", "always")],
    checks: [finding("critical-build", "passed")],
    content_changes: ["source change"],
  });

  assert.equal(result.current, false);
  assert.equal(result.assessment, null);
  assert.deepEqual(result.currentness.reasons, [{
    check_id: "critical-build",
    reason_code: "content_changed",
    change: "source change",
  }]);
});

test("a Passed claim without required Evidence is downgraded and can never be Launch Ready", () => {
  const required = declaration("critical-security", "critical", "always");
  required.evidence_requirement = {
    accepted_kinds: ["public_observation"],
    minimum_items: 1,
    provenance_required: true,
  };
  const result = evaluate({
    declarations: [required],
    checks: [finding("critical-security", "passed")],
  });

  assert.equal(result.findings[0].status, "unverified");
  assert.equal(result.findings[0].reason_code, "insufficient_evidence");
  assert.equal(result.assessment, "inconclusive");
  assert.deepEqual(result.action_queue, []);
  assert.equal(result.verification_gaps[0].reason_code, "insufficient_evidence");
});

test("Provider Verification Gaps use the same engine and prevent Launch Ready", () => {
  const providerGap = {
    check_id: "provider.vercel.metadata",
    status: "unverified",
    reason_code: "missing_provider_tool",
    reason: "The approved Provider tool is missing.",
  };
  const result = evaluate({
    declarations: [declaration("critical-build", "critical", "always")],
    checks: [finding("critical-build", "passed")],
    additional_gaps: [providerGap],
  });

  assert.equal(result.assessment, "inconclusive");
  assert.deepEqual(result.verification_gaps, [{
    ...providerGap,
    severity: "major",
    gating: false,
  }]);
  assert.equal(result.coverage_summary.unverified_checks, 1);
  assert.equal(result.coverage_summary.coverage, "partial");
});
