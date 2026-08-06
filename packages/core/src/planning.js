import {
  CLI_INTERACTION_CONTRACT,
  LAUNCH_PLAN_SCHEMA,
  assertSupportedReportVersion,
  assertValidLaunchPlan,
  assertValidReportPackage,
} from "@launchrally/contracts";

function titleCase(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function releaseImpact(action, environment) {
  const gate = action.gating ? "gates" : "does not gate";
  const journey = {
    direct: "directly affects a core journey",
    indirect: "indirectly affects a core journey",
    none: "does not directly affect a declared core journey",
  }[action.core_journey_impact];
  return `This ${titleCase(action.severity)} Finding ${gate} the declared ${environment} release and ${journey}.`;
}

function unique(values) {
  return [...new Set(values)];
}

function planItem(report, action, index) {
  const check = report.results.checks.find((candidate) => candidate.check_id === action.check_id);
  const declaration = report.catalog.checks.find(
    (candidate) => candidate.check_id === action.check_id,
  );
  return {
    rank: index + 1,
    check_id: action.check_id,
    priority: action.priority,
    severity: action.severity,
    gating: action.gating,
    priority_basis: {
      severity: action.severity,
      dependency_unblocking: action.dependency_unblocking,
      core_journey_impact: action.core_journey_impact,
    },
    problem: check.summary,
    release_impact: releaseImpact(
      action,
      report.scope.release_intent.intended_environment ?? "unspecified",
    ),
    investigation: {
      risk_domain: check.risk_domain,
      required_inputs: structuredClone(declaration.required_inputs),
      evidence_targets: unique(check.evidence.map((evidence) => evidence.target)),
      verification_rules: structuredClone(declaration.verification_rules),
    },
    remediation: action.action,
    evidence_to_recollect: {
      ...structuredClone(declaration.evidence_requirement),
      freshness: structuredClone(declaration.freshness_behavior),
      instruction: `Recollect ${declaration.evidence_requirement.accepted_kinds.join(
        ", ",
      )} Evidence for ${action.check_id}, then run Verify.`,
    },
  };
}

function planGap(gap) {
  const permissionRequest = gap.reason_code === "permission_denied";
  const missingProviderLogin = gap.reason_code === "missing_provider_login";
  return {
    ...structuredClone(gap),
    confirmed_fix: false,
    work_type: permissionRequest ? "permission_request" : "investigation",
    next_action: permissionRequest
      ? "Request explicit read permission before recollecting Evidence; do not treat this Gap as a confirmed fix."
      : missingProviderLogin
        ? "Authenticate the existing read-only Provider CLI outside LaunchRally, then recollect Evidence; LaunchRally never initiates login or handles credentials."
        : "Investigate and recollect the missing Evidence before proposing remediation; this Gap is not a confirmed fix.",
  };
}

function remediationHandoff() {
  return {
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
  };
}

function sameIds(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function hasUniqueIds(items) {
  return new Set(items.map((item) => item.check_id)).size === items.length;
}

function reportRelationshipsAreValid(report) {
  const resultChecks = report.results.checks;
  const catalogChecks = report.catalog.checks;
  if (
    !hasUniqueIds(resultChecks)
    || !hasUniqueIds(catalogChecks)
    || !hasUniqueIds(report.results.action_queue)
    || !hasUniqueIds(report.results.verification_gaps)
  ) return false;
  const checks = new Map(resultChecks.map((check) => [check.check_id, check]));
  const declarations = new Map(catalogChecks.map((check) => [check.check_id, check]));
  const checksValid = resultChecks.every((check) => {
    const declaration = declarations.get(check.check_id);
    return declaration
      && check.check_version === declaration.check_version
      && check.risk_domain === declaration.risk_domain
      && check.severity === declaration.severity_policy.severity
      && check.release_gate === declaration.release_gate_policy.gate;
  });
  const actionsValid = report.results.action_queue.every((action) => {
    const check = checks.get(action.check_id);
    const declaration = declarations.get(action.check_id);
    return check?.status === "failed"
      && declaration
      && action.priority === check.priority
      && action.severity === check.severity
      && action.gating === check.gating
      && action.dependency_unblocking
        === declaration.remediation_order_policy.dependency_unblocking
      && action.core_journey_impact
        === declaration.remediation_order_policy.core_journey_impact;
  });
  const gapsValid = report.results.verification_gaps.every((gap) => {
    const check = checks.get(gap.check_id);
    return check?.status === "unverified"
      && gap.risk_domain === check.risk_domain
      && gap.priority === check.priority
      && gap.severity === check.severity
      && gap.gating === check.gating;
  });
  return checksValid
    && actionsValid
    && gapsValid
    && sameIds(
      resultChecks.map((check) => check.check_id),
      catalogChecks.map((check) => check.check_id),
    )
    && sameIds(
      report.results.action_queue.map((action) => action.check_id),
      report.results.checks.filter((check) => check.status === "failed").map(
        (check) => check.check_id,
      ),
    )
    && sameIds(
      report.results.verification_gaps.map((gap) => gap.check_id),
      report.results.checks.filter((check) => check.status === "unverified").map(
        (check) => check.check_id,
      ),
    );
}

export function runPlan(reportPackage, options = {}) {
  if (!reportPackage) {
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "unavailable",
      operation: "plan",
      reason: "complete_report_required",
      message: "Supply a saved complete current Audit Report before planning.",
    };
  }
  try {
    if (typeof reportPackage?.report?.schema_version === "string") {
      assertSupportedReportVersion(reportPackage.report);
    }
    assertValidReportPackage(reportPackage);
  } catch (error) {
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "execution_error",
      operation: "plan",
      error: error?.code ?? "invalid_report_package",
      message: error?.code === "unsupported_report_version"
        ? "The saved Report uses an unsupported future major version."
        : "The saved Audit JSON is incomplete or invalid; no plan was produced.",
    };
  }
  const report = reportPackage.report;
  if (!report.scope.release_intent.confirmed) {
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "unavailable",
      operation: "plan",
      reason: "confirmed_release_required",
      source_report_id: report.report_id,
      message: "The saved Report has no confirmed release intent; run a new Audit before planning remediation.",
    };
  }
  if (!reportRelationshipsAreValid(report)) {
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "execution_error",
      operation: "plan",
      error: "invalid_report_relationships",
      message: "The saved Report has inconsistent Finding, Action Queue, or Verification Gap relationships.",
    };
  }
  if (!report.policy.current) {
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "unavailable",
      operation: "plan",
      reason: "current_report_required",
      source_report_id: report.report_id,
      message: "The saved Report is non-current; run a new Audit before planning remediation.",
    };
  }
  const plan = {
    contract: CLI_INTERACTION_CONTRACT,
    schema_version: LAUNCH_PLAN_SCHEMA,
    status: "completed",
    operation: "plan",
    source_report_id: report.report_id,
    read_only: true,
    effects: {
      source_mutation: "none",
      deployment_mutation: "none",
      provider_mutation: "none",
      production_mutation: "none",
    },
    assessment: report.assessment,
    determinism: {
      source: "report_action_queue",
      ordering: ["severity", "dependency_unblocking", "core_journey_impact"],
      generated_timestamps: false,
    },
    items: report.results.action_queue.map((action, index) => planItem(report, action, index)),
    verification_gaps: report.results.verification_gaps.map(planGap),
    next: {
      type: "remediation_handoff",
      required: false,
      message: "Request Remediation Handoff explicitly before the host Agent changes local code.",
    },
  };
  if (options.handoff_requested === true) {
    plan.handoff = remediationHandoff();
    plan.next = plan.handoff.return_to_verify;
  }
  assertValidLaunchPlan(plan);
  return plan;
}
