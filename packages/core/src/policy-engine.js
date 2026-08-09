export const POLICY_ENGINE_VERSION = "launch-policy-engine/v1";

const MACHINE_EVIDENCE_KINDS = new Set([
  "file",
  "local_observation",
  "project_fact",
  "public_observation",
  "machine_evidence",
]);

function releaseGate(declaration, scopeConfirmed) {
  const severity = declaration.severity_policy.severity;
  if (severity === "critical") return true;
  if (severity === "moderate") return false;
  const gate = declaration.release_gate_policy.gate;
  return scopeConfirmed && (gate === "always" || gate === "policy");
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

function compareByRank(left, right, values, select) {
  return values.indexOf(select(left)) - values.indexOf(select(right));
}

function remediationOrder(left, right) {
  return compareByRank(left, right, ["critical", "major", "moderate"], (item) => item.severity)
    || compareByRank(left, right, [true, false], (item) => item.dependency_unblocking)
    || compareByRank(left, right, ["direct", "indirect", "none"], (item) =>
      item.core_journey_impact,
    )
    || left.check_id.localeCompare(right.check_id);
}

function actionEvidenceReference(entry) {
  return {
    digest: entry.digest,
    ...(typeof entry.source === "string" ? { source: entry.source } : {}),
    ...(typeof entry.target === "string" ? { target: entry.target } : {}),
  };
}

function failedPublicObservation(entry) {
  const artifact = entry.normalized_artifact;
  if (
    entry.evidence_kind !== "public_observation"
    || artifact?.kind !== "public_observation"
    || artifact.status !== "failed"
  ) return null;
  const observation = {
    kind: "public_observation",
    evidence_digest: entry.digest,
    probe_id: artifact.probe_id,
    probe_kind: artifact.probe_kind,
    method: artifact.method,
    path: artifact.path,
    outcome: artifact.outcome,
  };
  if (Number.isInteger(artifact.details?.status_code)) {
    observation.status_code = artifact.details.status_code;
  }
  return observation;
}

function localObservation(entry) {
  const artifact = entry.normalized_artifact;
  if (
    entry.evidence_kind !== "local_observation"
    || artifact?.kind !== "local_observation"
  ) return null;
  return {
    kind: "local_observation",
    evidence_digest: entry.digest,
    target: artifact.target,
    outcome: artifact.outcome,
  };
}

function actionEvidence(finding, evidenceByDigest) {
  const entries = finding.evidence
    .map((reference) => evidenceByDigest.get(reference.digest))
    .filter(Boolean);
  const failedPublic = entries.map((entry) => ({
    entry,
    observation: failedPublicObservation(entry),
  })).filter(({ observation }) => observation);
  const supportingEntries = failedPublic.length > 0
    ? failedPublic.map(({ entry }) => entry)
    : entries;
  const observations = failedPublic.length > 0
    ? failedPublic.map(({ observation }) => observation)
    : entries.map(localObservation).filter(Boolean);
  return {
    evidence: supportingEntries.map(actionEvidenceReference),
    observations: observations.length > 0
      ? observations
      : [{ kind: "check_result", summary: finding.summary }],
  };
}

function evidenceRequirement(check, declaration) {
  return check.status === "passed"
    ? declaration.pass_evidence_requirement ?? declaration.evidence_requirement
    : check.status === "failed"
      ? declaration.failure_evidence_requirement
      : null;
}

function qualifyingEvidence(check, requirement, evidenceByDigest) {
  if (!requirement) return [];
  return check.evidence
    .map((reference) => evidenceByDigest.get(reference.digest))
    .filter((evidence) =>
      evidence
      && requirement.accepted_kinds.includes(evidence.evidence_kind)
      && (!requirement.provenance_required || Boolean(evidence.source)),
    );
}

function enforceEvidenceRequirement(check, declaration, evidenceByDigest) {
  if (!["passed", "failed"].includes(check.status)) return check;
  const requirement = evidenceRequirement(check, declaration);
  if (
    requirement
    && qualifyingEvidence(check, requirement, evidenceByDigest).length >= requirement.minimum_items
  ) return check;
  return {
    ...check,
    status: "unverified",
    reason_code: "insufficient_evidence",
    summary: `The declared ${check.status} Evidence Requirement is not satisfied, so this Check remains Unverified.`,
  };
}

function currentness({
  findings,
  declarations,
  evidenceIndex,
  evaluatedAt,
  contentChanges,
  externalReasons,
}) {
  const evidenceByDigest = new Map(
    evidenceIndex.entries.map((entry) => [entry.digest, entry]),
  );
  const evaluatedTime = Date.parse(evaluatedAt);
  const reasons = structuredClone(externalReasons);
  const evidenceCurrentness = new Map(evidenceIndex.entries.map((entry) => [
    entry.digest,
    {
      digest: entry.digest,
      current: true,
      currentness: {
        status: "current",
        evaluated_at: evaluatedAt,
        reasons: [],
      },
    },
  ]));
  function markEvidenceNonCurrent(reference, reason) {
    const state = evidenceCurrentness.get(reference.digest);
    if (!state) return;
    state.current = false;
    state.currentness.status = "non_current";
    state.currentness.reasons.push(structuredClone(reason));
  }
  for (const finding of findings) {
    const freshness = declarations.get(finding.check_id).freshness_behavior;
    for (const change of contentChanges.filter((candidate) =>
      freshness.invalidated_by.includes(candidate),
    )) {
      const reason = {
        check_id: finding.check_id,
        reason_code: "content_changed",
        change,
      };
      reasons.push(reason);
      const references = [
        ...(finding.applicability?.evidence ?? []),
        ...finding.evidence,
      ];
      for (const reference of references) markEvidenceNonCurrent(reference, reason);
    }
    if (freshness.mode !== "live_state" || finding.status === "not_applicable") continue;
    for (const reference of finding.evidence) {
      const evidence = evidenceByDigest.get(reference.digest);
      if (
        evidence
        && evaluatedTime - Date.parse(evidence.collected_at) > freshness.max_age_seconds * 1000
      ) {
        const reason = {
          check_id: finding.check_id,
          reason_code: "live_evidence_stale",
          evidence_digest: reference.digest,
          collected_at: evidence.collected_at,
          max_age_seconds: freshness.max_age_seconds,
        };
        reasons.push(reason);
        markEvidenceNonCurrent(reference, reason);
      }
    }
  }
  return {
    report: {
      status: reasons.length > 0 ? "non_current" : "current",
      evaluated_at: evaluatedAt,
      reasons,
    },
    evidence: [...evidenceCurrentness.values()],
  };
}

export function evaluateLaunchPolicy({
  catalog,
  checks,
  scope,
  evidence_index = { entries: [] },
  evaluated_at,
  content_changes = [],
  currentness_reasons = [],
}) {
  const declarations = new Map(catalog.checks.map((check) => [check.check_id, check]));
  const evidenceByDigest = new Map(
    evidence_index.entries.map((entry) => [entry.digest, entry]),
  );
  const findings = checks.map((check) => {
    const declared = declarations.get(check.check_id);
    let evidenceChecked = enforceEvidenceRequirement(check, declared, evidenceByDigest);
    const gating = releaseGate(declared, scope.confirmed);
    const failureRequirement = evidenceRequirement(check, declared);
    if (
      evidenceChecked.status === "failed"
      && gating
      && !qualifyingEvidence(check, failureRequirement, evidenceByDigest).some((evidence) =>
        MACHINE_EVIDENCE_KINDS.has(evidence.evidence_kind))
    ) {
      evidenceChecked = {
        ...evidenceChecked,
        status: "unverified",
        reason_code: "insufficient_machine_evidence",
        summary: "A gating failure requires qualifying Machine Evidence, so this Check remains Unverified.",
      };
    }
    return {
      ...structuredClone(evidenceChecked),
      severity: declared.severity_policy.severity,
      gating,
    };
  });
  const actionQueue = findings
    .filter((finding) => finding.status === "failed")
    .map((finding) => {
      const remediation = declarations.get(finding.check_id).remediation_order_policy;
      const supportingEvidence = actionEvidence(finding, evidenceByDigest);
      return {
        check_id: finding.check_id,
        ...(finding.priority ? { priority: finding.priority } : {}),
        severity: finding.severity,
        gating: finding.gating,
        dependency_unblocking: remediation.dependency_unblocking,
        core_journey_impact: remediation.core_journey_impact,
        action: finding.action ?? "Resolve the failed verification rule.",
        ...supportingEvidence,
        targeted_verification: {
          operation: "verify",
          scope: "targeted",
          check_ids: [finding.check_id],
        },
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
  const verificationGaps = findingGaps;
  const gatingFailure = findings.some(
    (finding) => finding.status === "failed" && finding.gating,
  );
  const gatingUnverified = findings.some(
    (finding) => finding.status === "unverified" && finding.gating,
  );
  const derivedCurrentness = currentness({
    findings,
    declarations,
    evidenceIndex: evidence_index,
    evaluatedAt: evaluated_at,
    contentChanges: content_changes,
    externalReasons: currentness_reasons,
  });
  const reportCurrentness = derivedCurrentness.report;
  const current = reportCurrentness.status === "current";
  const coverageSummary = coverage(findings);
  return {
    policy_version: POLICY_ENGINE_VERSION,
    current,
    currentness: reportCurrentness,
    evidence_currentness: derivedCurrentness.evidence,
    assessment: !current
      ? null
      : gatingFailure
        ? "no_go"
        : gatingUnverified
          ? "inconclusive"
          : actionQueue.length > 0 || verificationGaps.length > 0
            ? "ready_with_warnings"
            : "launch_ready",
    findings,
    action_queue: actionQueue,
    verification_gaps: verificationGaps,
    coverage_summary: coverageSummary,
  };
}
