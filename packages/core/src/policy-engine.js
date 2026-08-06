export const POLICY_ENGINE_VERSION = "launch-policy-engine/v1";

function releaseGate(declaration, scopeConfirmed) {
  const severity = declaration.severity_policy.severity;
  if (severity === "critical") return true;
  if (severity === "moderate") return false;
  const gate = declaration.release_gate_policy.gate;
  return gate === "always" || (gate === "policy" && scopeConfirmed);
}

function coverage(findings) {
  const count = (status) => findings.filter((finding) => finding.status === status).length;
  const unverified = count("unverified");
  return {
    applicable_checks: findings.length - count("not_applicable"),
    passed_checks: count("passed"),
    failed_checks: count("failed"),
    unverified_checks: unverified,
    not_applicable_checks: count("not_applicable"),
    coverage: unverified === 0 ? "complete" : "partial",
  };
}

function orderedBefore(left, right, values, select) {
  return values.indexOf(select(left)) - values.indexOf(select(right));
}

function remediationOrder(left, right) {
  return orderedBefore(left, right, ["critical", "major", "moderate"], (item) => item.severity)
    || orderedBefore(left, right, [true, false], (item) => item.dependency_unblocking)
    || orderedBefore(left, right, ["direct", "indirect", "none"], (item) =>
      item.core_journey_impact,
    )
    || left.check_id.localeCompare(right.check_id);
}

function enforceEvidenceRequirement(check, declaration, evidenceByDigest) {
  if (check.status !== "passed" || !declaration.evidence_requirement) return check;
  const requirement = declaration.evidence_requirement;
  const qualifyingEvidence = check.evidence
    .map((reference) => evidenceByDigest.get(reference.digest))
    .filter((evidence) =>
      evidence
      && requirement.accepted_kinds.includes(evidence.evidence_kind)
      && (!requirement.provenance_required || Boolean(evidence.source)),
    );
  if (qualifyingEvidence.length >= requirement.minimum_items) return check;
  return {
    ...check,
    status: "unverified",
    reason_code: "insufficient_evidence",
    summary: "The declared Evidence Requirement is not satisfied, so this Check cannot be Passed.",
  };
}

function currentness({
  findings,
  declarations,
  evidenceIndex,
  evaluatedAt,
  contentChanges,
}) {
  const evidenceByDigest = new Map(
    evidenceIndex.entries.map((entry) => [entry.digest, entry]),
  );
  const evaluatedTime = Date.parse(evaluatedAt);
  const reasons = [];
  for (const finding of findings) {
    const freshness = declarations.get(finding.check_id).freshness_behavior;
    for (const change of contentChanges.filter((candidate) =>
      freshness.invalidated_by.includes(candidate),
    )) {
      reasons.push({
        check_id: finding.check_id,
        reason_code: "content_changed",
        change,
      });
    }
    if (freshness.mode !== "live_state" || finding.status === "not_applicable") continue;
    for (const reference of finding.evidence) {
      const evidence = evidenceByDigest.get(reference.digest);
      if (
        evidence
        && evaluatedTime - Date.parse(evidence.collected_at) > freshness.max_age_seconds * 1000
      ) {
        reasons.push({
          check_id: finding.check_id,
          reason_code: "live_evidence_stale",
          evidence_digest: reference.digest,
          collected_at: evidence.collected_at,
          max_age_seconds: freshness.max_age_seconds,
        });
      }
    }
  }
  return {
    status: reasons.length > 0 ? "non_current" : "current",
    evaluated_at: evaluatedAt,
    reasons,
  };
}

export function evaluateLaunchPolicy({
  catalog,
  checks,
  scope,
  evidence_index = { entries: [] },
  evaluated_at,
  content_changes = [],
  additional_verification_gaps = [],
}) {
  const declarations = new Map(catalog.checks.map((check) => [check.check_id, check]));
  const evidenceByDigest = new Map(
    evidence_index.entries.map((entry) => [entry.digest, entry]),
  );
  const findings = checks.map((check) => {
    const declared = declarations.get(check.check_id);
    const evidenceChecked = enforceEvidenceRequirement(check, declared, evidenceByDigest);
    return {
      ...structuredClone(evidenceChecked),
      severity: declared.severity_policy.severity,
      gating: releaseGate(declared, scope.confirmed),
    };
  });
  const actionQueue = findings
    .filter((finding) => finding.status === "failed")
    .map((finding) => {
      const remediation = declarations.get(finding.check_id).remediation_order_policy;
      return {
        check_id: finding.check_id,
        ...(finding.priority ? { priority: finding.priority } : {}),
        severity: finding.severity,
        gating: finding.gating,
        dependency_unblocking: remediation.dependency_unblocking,
        core_journey_impact: remediation.core_journey_impact,
        action: finding.action ?? "Resolve the failed verification rule.",
      };
    })
    .sort(remediationOrder);
  const findingGaps = findings
    .filter((finding) => finding.status === "unverified")
    .map((finding) => ({
      check_id: finding.check_id,
      ...(finding.risk_domain ? { risk_domain: finding.risk_domain } : {}),
      ...(finding.priority ? { priority: finding.priority } : {}),
      severity: finding.severity,
      gating: finding.gating,
      status: "unverified",
      reason_code: finding.reason_code ?? "missing_required_input",
      reason: finding.summary,
    }));
  const externalGaps = additional_verification_gaps.map((gap) => ({
    ...structuredClone(gap),
    severity: gap.severity ?? "major",
    gating: gap.gating ?? false,
  }));
  const verificationGaps = [...findingGaps, ...externalGaps];
  const gatingFailure = findings.some(
    (finding) => finding.status === "failed" && finding.gating,
  );
  const reportCurrentness = currentness({
    findings,
    declarations,
    evidenceIndex: evidence_index,
    evaluatedAt: evaluated_at,
    contentChanges: content_changes,
  });
  const current = reportCurrentness.status === "current";
  const coverageSummary = coverage(findings);
  coverageSummary.applicable_checks += additional_verification_gaps.length;
  coverageSummary.unverified_checks += additional_verification_gaps.length;
  if (coverageSummary.unverified_checks > 0) coverageSummary.coverage = "partial";
  return {
    policy_version: POLICY_ENGINE_VERSION,
    current,
    currentness: reportCurrentness,
    assessment: !current
      ? null
      : gatingFailure
        ? "no_go"
        : verificationGaps.length > 0
          ? "inconclusive"
          : actionQueue.length > 0
            ? "ready_with_warnings"
            : "launch_ready",
    findings,
    action_queue: actionQueue,
    verification_gaps: verificationGaps,
    coverage_summary: coverageSummary,
  };
}
