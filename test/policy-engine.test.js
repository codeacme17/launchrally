import assert from "node:assert/strict";
import test from "node:test";

import { evaluateLaunchPolicy } from "../packages/core/src/index.js";

function declaration(check_id, severity, gate, remediation = {}) {
  return {
    check_id,
    pass_evidence_requirement: {
      accepted_kinds: ["file"],
      minimum_items: 1,
      provenance_required: true,
    },
    failure_evidence_requirement: {
      accepted_kinds: ["file"],
      minimum_items: 1,
      provenance_required: true,
    },
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
    evidence: [{ digest: `sha256:${check_id}` }],
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
}) {
  const supplied = new Map(evidence_entries.map((entry) => [entry.digest, entry]));
  for (const check of checks) {
    for (const reference of check.evidence) {
      if (!supplied.has(reference.digest)) {
        supplied.set(reference.digest, {
          digest: reference.digest,
          evidence_kind: "file",
          source: "local_safe_scan/v1",
          target: `repository:${check.check_id}`,
          collected_at: evaluated_at,
          freshness_class: "repository_snapshot",
          redaction_state: "metadata_only",
        });
      }
    }
  }
  return evaluateLaunchPolicy({
    catalog: { checks: declarations },
    checks,
    scope: { confirmed: scope_confirmed, core_journeys: ["checkout"] },
    evidence_index: { entries: [...supplied.values()] },
    evaluated_at,
    content_changes,
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
    evidence: [{
      digest: "sha256:critical-lockfile",
      source: "local_safe_scan/v1",
      target: "repository:critical-lockfile",
    }],
    observations: [{
      kind: "check_result",
      summary: "critical-lockfile is failed",
    }],
    targeted_verification: {
      operation: "verify",
      scope: "targeted",
      check_ids: ["critical-lockfile"],
    },
  }]);
  assert.deepEqual(result.verification_gaps, []);
});

test("failed public observations become safe deterministic targeted actions", () => {
  const required = declaration("web.public.core-journeys", "critical", "always", {
    core_journey_impact: "direct",
  });
  required.failure_evidence_requirement = {
    accepted_kinds: ["public_observation"],
    minimum_items: 1,
    provenance_required: true,
  };
  const collectedAt = "2026-08-06T12:00:00.000Z";
  const observations = [
    ["sha256:journey-one", "target-1:journey-1", "/critical-path", 500],
    ["sha256:journey-two", "target-1:journey-2", "/secondary-path", 503],
  ].map(([digest, probeId, journeyPath, statusCode]) => ({
    digest,
    evidence_kind: "public_observation",
    source: "public-verification/v1",
    target: `https://example.com${journeyPath}`,
    collected_at: collectedAt,
    freshness_class: "audit_time",
    redaction_state: "normalized",
    normalized_artifact: {
      kind: "public_observation",
      probe_id: probeId,
      probe_kind: "journey",
      target: `https://example.com${journeyPath}`,
      host: "example.com",
      port: 443,
      path: journeyPath,
      method: "GET",
      purpose: "Verify a declared core journey.",
      status: "failed",
      outcome: "http_status_failure",
      collected_at: collectedAt,
      duration_ms: 1,
      details: {
        status_code: statusCode,
        response_body: "must-not-enter-action",
        headers: { authorization: "Bearer must-not-enter-action" },
      },
      raw_provider_output: "must-not-enter-action",
      unallowlisted: "must-not-enter-action",
      provenance: {
        collector: "public-verification/v1",
        exact_target: `https://example.com${journeyPath}`,
        collected_at: collectedAt,
      },
    },
  }));
  const result = evaluate({
    declarations: [required],
    checks: [{
      ...finding("web.public.core-journeys", "failed"),
      priority: "p0",
      evidence: observations.map(({ digest }) => ({ digest })),
    }],
    evidence_entries: observations,
  });

  assert.deepEqual(result.action_queue, [{
    check_id: "web.public.core-journeys",
    priority: "p0",
    severity: "critical",
    gating: true,
    dependency_unblocking: false,
    core_journey_impact: "direct",
    action: "Resolve the failed verification rule.",
    evidence: observations.map((entry) => ({
      digest: entry.digest,
      source: entry.source,
      target: entry.target,
    })),
    observations: [
      {
        kind: "public_observation",
        evidence_digest: "sha256:journey-one",
        probe_id: "target-1:journey-1",
        probe_kind: "journey",
        method: "GET",
        path: "/critical-path",
        outcome: "http_status_failure",
        status_code: 500,
      },
      {
        kind: "public_observation",
        evidence_digest: "sha256:journey-two",
        probe_id: "target-1:journey-2",
        probe_kind: "journey",
        method: "GET",
        path: "/secondary-path",
        outcome: "http_status_failure",
        status_code: 503,
      },
    ],
    targeted_verification: {
      operation: "verify",
      scope: "targeted",
      check_ids: ["web.public.core-journeys"],
    },
  }]);
  assert.doesNotMatch(JSON.stringify(result.action_queue), /must-not-enter-action/u);
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

  const alwaysUnconfirmed = evaluate({
    declarations: [declaration("major-provider", "major", "always")],
    checks: [finding("major-provider", "failed", "Fix provider metadata.")],
    scope_confirmed: false,
  });
  assert.equal(alwaysUnconfirmed.findings[0].gating, false);
  assert.equal(alwaysUnconfirmed.assessment, "ready_with_warnings");
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
  assert.deepEqual(result.evidence_currentness, [{
    digest: evidenceReference.digest,
    current: false,
    currentness: {
      status: "non_current",
      evaluated_at: "2026-08-06T12:00:00.000Z",
      reasons: result.currentness.reasons,
    },
  }]);
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
  required.pass_evidence_requirement = {
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

test("a gating Failed claim without qualifying failure Evidence is Unverified, never No-Go", () => {
  const required = declaration("critical-security", "critical", "always");
  required.failure_evidence_requirement = {
    accepted_kinds: ["public_observation"],
    minimum_items: 1,
    provenance_required: true,
  };
  const result = evaluate({
    declarations: [required],
    checks: [finding("critical-security", "failed", "Fix transport security.")],
  });

  assert.equal(result.findings[0].status, "unverified");
  assert.equal(result.findings[0].reason_code, "insufficient_evidence");
  assert.equal(result.assessment, "inconclusive");
  assert.deepEqual(result.action_queue, []);
});

test("a gating Failed claim backed only by release intent cannot produce No-Go", () => {
  const required = declaration("critical-transport", "critical", "always");
  required.failure_evidence_requirement = {
    accepted_kinds: ["release_intent"],
    minimum_items: 1,
    provenance_required: true,
  };
  const evidence = {
    digest: "sha256:declared-target",
    evidence_kind: "release_intent",
    source: "audit-brief/v1",
    collected_at: "2026-08-06T12:00:00.000Z",
  };
  const unrelatedMachineEvidence = {
    digest: "sha256:unrelated-file",
    evidence_kind: "file",
    source: "local_safe_scan/v1",
    collected_at: "2026-08-06T12:00:00.000Z",
  };
  const result = evaluate({
    declarations: [required],
    checks: [{
      ...finding("critical-transport", "failed"),
      evidence: [
        { digest: evidence.digest },
        { digest: unrelatedMachineEvidence.digest },
      ],
    }],
    evidence_entries: [evidence, unrelatedMachineEvidence],
  });

  assert.equal(result.findings[0].status, "unverified");
  assert.equal(result.findings[0].reason_code, "insufficient_machine_evidence");
  assert.equal(result.assessment, "inconclusive");
});

test("non-gating Unverified produces Ready with Warnings, not Inconclusive", () => {
  const result = evaluate({
    declarations: [declaration("moderate-optional", "moderate", "never")],
    checks: [{
      ...finding("moderate-optional", "unverified"),
      reason_code: "missing_required_input",
    }],
  });

  assert.equal(result.findings[0].gating, false);
  assert.equal(result.assessment, "ready_with_warnings");
});

test("a declared Provider Check uses Machine Evidence and prevents unsupported Passed claims", () => {
  const providerDeclaration = declaration("provider.vercel.metadata", "major", "policy");
  providerDeclaration.pass_evidence_requirement = {
    accepted_kinds: ["machine_evidence"],
    minimum_items: 1,
    provenance_required: true,
  };
  const machineEvidence = {
    digest: "sha256:provider-observation",
    source: "provider-adapter-contract/v1",
    evidence_kind: "machine_evidence",
    collected_at: "2026-08-06T12:00:00.000Z",
  };
  const result = evaluate({
    declarations: [providerDeclaration],
    checks: [{
      ...finding("provider.vercel.metadata", "passed"),
      evidence: [{
        digest: machineEvidence.digest,
        collected_at: machineEvidence.collected_at,
      }],
    }],
    evidence_entries: [machineEvidence],
  });

  assert.equal(result.assessment, "launch_ready");
  assert.equal(result.findings[0].status, "passed");
  assert.equal(result.findings[0].severity, "major");
  assert.equal(result.findings[0].gating, true);

  const unsupportedClaim = evaluate({
    declarations: [providerDeclaration],
    checks: [finding("provider.vercel.metadata", "passed")],
  });
  assert.equal(unsupportedClaim.findings[0].status, "unverified");
  assert.equal(unsupportedClaim.assessment, "inconclusive");
});
