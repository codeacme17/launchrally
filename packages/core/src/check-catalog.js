import {
  createProviderAdapterPlan,
  providerRiskDomain,
} from "./provider-adapters.js";

const CHECK_CATALOG_VERSION = "web-baseline-check-catalog/v1";
const BASELINE_VERSION = "web-application-baseline/v1";

const WEB_RISK_DOMAINS = Object.freeze([
  "build_integrity",
  "configuration",
  "deployment",
  "availability",
  "security_and_privacy",
  "data_and_integrations",
  "observability_and_operations",
  "user_experience",
]);

const FILE_EVIDENCE = Object.freeze({
  accepted_kinds: ["file"],
  minimum_items: 1,
  provenance_required: true,
});

const RELEASE_INTENT_EVIDENCE = Object.freeze({
  accepted_kinds: ["release_intent"],
  minimum_items: 1,
  provenance_required: true,
});

const PUBLIC_EVIDENCE = Object.freeze({
  accepted_kinds: ["public_observation"],
  minimum_items: 1,
  provenance_required: true,
});

const MACHINE_EVIDENCE = Object.freeze({
  accepted_kinds: ["machine_evidence"],
  minimum_items: 1,
  provenance_required: true,
});

function declaration({
  check_id,
  risk_domain,
  permission_id,
  required_inputs,
  evidence_requirement,
  verification_rules,
  severity,
  gate,
  freshness,
  dependency_unblocking,
  core_journey_impact,
}) {
  return Object.freeze({
    check_id,
    check_version: 1,
    risk_domain,
    permission_id,
    applicability: {
      rule: "Framework-neutral Web Baseline; applicability is resolved from normalized Project Facts and confirmed release intent.",
      required_evidence: ["project.type", "audit_brief.confirmed_release_intent"],
    },
    required_inputs,
    evidence_requirement,
    verification_rules,
    severity_policy: {
      severity,
      rationale: `${severity} severity in the Web Application Baseline.`,
    },
    release_gate_policy: {
      gate,
      unverified_blocks_launch_ready: true,
    },
    remediation_order_policy: {
      dependency_unblocking,
      core_journey_impact,
    },
    freshness_behavior: freshness,
  });
}

const CHECKS = Object.freeze([
  {
    declaration: declaration({
      check_id: "web.baseline.package-manifest",
      risk_domain: "build_integrity",
      permission_id: "local_safe_scan",
      required_inputs: ["project.package_manifest.status"],
      evidence_requirement: FILE_EVIDENCE,
      verification_rules: [
        "Pass only when the root package.json was parsed as a valid package manifest.",
        "Fail when a root package.json exists but is invalid; missing facts remain Unverified.",
      ],
      severity: "critical",
      gate: "always",
      dependency_unblocking: true,
      core_journey_impact: "indirect",
      freshness: {
        mode: "content_bound",
        invalidated_by: ["package_manifest_changed", "scan_policy_changed"],
      },
    }),
    applicability(project) {
      return applicable("A root package manifest is a conventional Web project fact.", [
        factEvidence("package_manifest.status", project.package_manifest?.status ?? "unknown"),
      ]);
    },
    verify(project) {
      if (project.package_manifest?.status === "valid") {
        return passed("The root package manifest is valid.", [fileEvidence("package.json")]);
      }
      if (project.package_manifest?.status === "invalid") {
        return failed("The root package manifest is invalid.", [fileEvidence("package.json")]);
      }
      return unverified(
        "missing_required_input",
        "No root package manifest fact establishes this conventional Web build input.",
      );
    },
  },
  {
    declaration: declaration({
      check_id: "web.baseline.lockfile",
      risk_domain: "build_integrity",
      permission_id: "local_safe_scan",
      required_inputs: ["project.facts[kind=lockfile]"],
      evidence_requirement: FILE_EVIDENCE,
      verification_rules: [
        "Pass when exactly one root package-manager family is represented by a supported lockfile.",
        "Fail when no root lockfile exists; conflicting package-manager facts remain Unverified.",
      ],
      severity: "critical",
      gate: "always",
      dependency_unblocking: true,
      core_journey_impact: "indirect",
      freshness: {
        mode: "content_bound",
        invalidated_by: ["root_lockfiles_changed", "scan_policy_changed"],
      },
    }),
    applicability(project) {
      return applicable("Dependency reproducibility applies to conventional Web projects.", [
        factEvidence("project.type", project.type ?? "unknown"),
      ]);
    },
    verify(project) {
      const lockfiles = project.facts.filter(
        (fact) => fact.kind === "lockfile" && !fact.provenance.path.includes("/"),
      );
      const managers = new Set(lockfiles.map((fact) => fact.package_manager));
      if (managers.size > 1) {
        return unverified(
          "conflicting_evidence",
          "Root lockfiles identify more than one package manager, so reproducibility is unresolved.",
          lockfiles.map((fact) => fileEvidence(fact.provenance.path)),
        );
      }
      if (lockfiles.length === 1) {
        return passed(
          "A dependency lockfile is present for reproducible installs.",
          [fileEvidence(lockfiles[0].provenance.path)],
        );
      }
      return failed(
        "No dependency lockfile was found, so installs are not reproducible.",
        [],
        "Commit the package manager lockfile generated by the project dependency install.",
      );
    },
  },
  {
    declaration: declaration({
      check_id: "web.baseline.runtime-inputs",
      risk_domain: "configuration",
      permission_id: "local_safe_scan",
      required_inputs: ["project.facts[kind=environment_variables]"],
      evidence_requirement: FILE_EVIDENCE,
      verification_rules: [
        "Pass when runtime input names are discoverable without reading or retaining values.",
        "Absence of declaration evidence remains Unverified rather than implying no configuration risk.",
      ],
      severity: "major",
      gate: "policy",
      dependency_unblocking: true,
      core_journey_impact: "indirect",
      freshness: {
        mode: "content_bound",
        invalidated_by: ["runtime_inputs_changed", "scan_policy_changed"],
      },
    }),
    applicability() {
      return applicable("Runtime configuration is part of the framework-neutral Web Baseline.", [
        intentEvidence("baseline", BASELINE_VERSION),
      ]);
    },
    verify(project) {
      const facts = project.facts.filter((fact) => fact.kind === "environment_variables");
      if (facts.length === 0) {
        return unverified(
          "missing_required_input",
          "No safe local fact declares whether this release requires runtime inputs.",
        );
      }
      return passed(
        "Runtime input names are locally discoverable without exposing their values.",
        facts.map((fact) => fileEvidence(fact.provenance.path)),
      );
    },
  },
  {
    declaration: declaration({
      check_id: "web.baseline.build-command",
      risk_domain: "deployment",
      permission_id: "local_safe_scan",
      required_inputs: ["project.script_names"],
      evidence_requirement: FILE_EVIDENCE,
      verification_rules: [
        "Pass when the root package manifest declares a build script.",
        "Fail when a valid conventional Web manifest has no build script.",
      ],
      severity: "critical",
      gate: "always",
      dependency_unblocking: true,
      core_journey_impact: "direct",
      freshness: {
        mode: "content_bound",
        invalidated_by: ["build_command_changed", "scan_policy_changed"],
      },
    }),
    applicability(project) {
      if (project.package_manifest?.status !== "valid") {
        return unresolvedApplicability(
          "A valid package manifest is required before build-command applicability can be confirmed.",
        );
      }
      return applicable("A valid conventional Web manifest establishes local build applicability.", [
        fileEvidence("package.json"),
      ]);
    },
    verify(project) {
      if (project.script_names.includes("build")) {
        return passed("The root package manifest declares a build command.", [
          fileEvidence("package.json"),
        ]);
      }
      return failed(
        "The root package manifest does not declare a build command.",
        [fileEvidence("package.json")],
        "Declare the production build command in the root package manifest.",
      );
    },
  },
  {
    declaration: declaration({
      check_id: "web.public.availability",
      risk_domain: "availability",
      permission_id: "public_verification",
      required_inputs: ["audit_brief.production_targets.values"],
      evidence_requirement: PUBLIC_EVIDENCE,
      verification_rules: [
        "Pass only after each confirmed production target is observed healthy through public verification.",
      ],
      severity: "critical",
      gate: "always",
      dependency_unblocking: false,
      core_journey_impact: "direct",
      freshness: {
        mode: "live_state",
        max_age_seconds: 900,
        invalidated_by: ["deployment_changed", "dns_changed", "health_route_changed"],
      },
    }),
    applicability(_project, brief) {
      return productionApplicability(brief, "Public availability applies to confirmed production targets.");
    },
    verify(_project, brief, authorizationPlan, publicEvidence) {
      return publicVerificationResult({
        brief,
        authorizationPlan,
        publicEvidence,
        subject: "availability",
        kinds: ["dns", "http", "health"],
        expectedCount: brief.production_targets.values.length * 3,
        passedSummary: "Every confirmed production target resolved and returned successful reachability and health observations.",
      });
    },
  },
  {
    declaration: declaration({
      check_id: "web.public.transport-security",
      risk_domain: "security_and_privacy",
      permission_id: "public_verification",
      required_inputs: ["audit_brief.production_targets.values"],
      evidence_requirement: PUBLIC_EVIDENCE,
      verification_rules: [
        "Pass only after HTTPS and transport-security observations satisfy the Baseline for every confirmed target.",
      ],
      severity: "critical",
      gate: "always",
      dependency_unblocking: false,
      core_journey_impact: "direct",
      freshness: {
        mode: "live_state",
        max_age_seconds: 3600,
        invalidated_by: ["certificate_changed", "dns_changed", "edge_configuration_changed"],
      },
    }),
    applicability(_project, brief) {
      return productionApplicability(brief, "Transport security applies to confirmed production targets.");
    },
    verify(_project, brief, authorizationPlan, publicEvidence) {
      const insecureTargets = brief.production_targets.values.filter(
        (target) => new URL(target).protocol !== "https:",
      );
      if (insecureTargets.length > 0) {
        return failed(
          `Confirmed production targets must use HTTPS: ${insecureTargets.join(", ")}.`,
          insecureTargets.map((target) => intentEvidence("production_target", target)),
          "Use HTTPS for every confirmed production target.",
        );
      }
      return publicVerificationResult({
        brief,
        authorizationPlan,
        publicEvidence,
        subject: "transport security",
        kinds: ["tls"],
        expectedCount: brief.production_targets.values.length,
        passedSummary: "Every confirmed production target completed an authorized TLS handshake.",
      });
    },
  },
  {
    declaration: declaration({
      check_id: "web.baseline.data-state",
      risk_domain: "data_and_integrations",
      permission_id: "local_safe_scan",
      required_inputs: ["audit_brief.provider_roles.values", "project.facts[kind=environment_variables]"],
      evidence_requirement: RELEASE_INTENT_EVIDENCE,
      verification_rules: [
        "Mark Not Applicable only when confirmed provider roles and local runtime-input names contain no data-state signal.",
        "Otherwise remain Unverified until data readiness evidence is available.",
      ],
      severity: "critical",
      gate: "always",
      dependency_unblocking: true,
      core_journey_impact: "indirect",
      freshness: {
        mode: "release_intent_bound",
        invalidated_by: ["provider_roles_changed", "runtime_inputs_changed"],
      },
    }),
    applicability(project, brief) {
      const dataRoles = brief.provider_roles.values.filter(({ role }) =>
        ["data", "database", "storage"].includes(role),
      );
      const environmentFacts = project.facts.filter(
        (fact) => fact.kind === "environment_variables",
      );
      const dataNames = environmentNames(project).filter((name) =>
        /(?:^|_)(?:DATABASE|DB|SUPABASE|REDIS|STORAGE)(?:_|$)/u.test(name),
      );
      if (dataRoles.length === 0 && environmentFacts.length === 0) {
        return unresolvedApplicability(
          "Confirmed provider roles contain no data role, but no local runtime-input fact can exclude a data-state dependency.",
        );
      }
      if (dataRoles.length === 0 && dataNames.length === 0) {
        return notApplicable(
          "Confirmed release intent and local runtime-input names contain no data-state dependency.",
          [
            intentEvidence("provider_roles", "confirmed:no-data-role"),
            ...environmentFacts.map((fact) => fileEvidence(fact.provenance.path)),
          ],
        );
      }
      return applicable("Confirmed intent or local facts identify a data-state dependency.", [
        ...(dataRoles.length > 0
          ? [intentEvidence("provider_roles", "confirmed:data-role")]
          : []),
        ...environmentFactEvidence(project, dataNames),
      ]);
    },
    verify() {
      return unverified(
        "specialist_support_unavailable",
        "Data readiness requires provider or release evidence that the baseline catalog cannot observe locally.",
      );
    },
  },
  {
    declaration: declaration({
      check_id: "web.baseline.observability",
      risk_domain: "observability_and_operations",
      permission_id: "local_safe_scan",
      required_inputs: ["audit_brief.support_layers.values", "audit_brief.provider_roles.values"],
      evidence_requirement: RELEASE_INTENT_EVIDENCE,
      verification_rules: [
        "Mark Not Applicable only when confirmed release intent selects no monitoring or observability support.",
        "Selected support remains Unverified until configuration and signal evidence is available.",
      ],
      severity: "major",
      gate: "policy",
      dependency_unblocking: false,
      core_journey_impact: "none",
      freshness: {
        mode: "release_intent_bound",
        invalidated_by: [
          "support_layers_changed",
          "provider_roles_changed",
          "monitoring_configuration_changed",
        ],
      },
    }),
    applicability(project, brief) {
      const selected = brief.support_layers.values.includes("monitoring")
        || brief.provider_roles.values.some(({ role }) => role === "observability")
        || environmentNames(project).some((name) => name.startsWith("SENTRY_"));
      if (!selected) {
        return notApplicable(
          "Confirmed release intent selects no monitoring or observability support.",
          [
            intentEvidence("support_layers", "confirmed:no-monitoring"),
            intentEvidence("provider_roles", "confirmed:no-observability-role"),
          ],
        );
      }
      return applicable("Confirmed intent or local facts select observability support.", [
        intentEvidence("support_layers", "confirmed:observability-selected"),
      ]);
    },
    verify() {
      return unverified(
        "specialist_support_unavailable",
        "Observability readiness requires specialist configuration and signal evidence that is not available.",
      );
    },
  },
  {
    declaration: declaration({
      check_id: "web.public.core-journeys",
      risk_domain: "user_experience",
      permission_id: "public_verification",
      required_inputs: ["audit_brief.production_targets.values", "audit_brief.core_journeys.values"],
      evidence_requirement: PUBLIC_EVIDENCE,
      verification_rules: [
        "Pass only after every confirmed core journey completes against a confirmed production target with fresh public evidence.",
      ],
      severity: "critical",
      gate: "always",
      dependency_unblocking: false,
      core_journey_impact: "direct",
      freshness: {
        mode: "live_state",
        max_age_seconds: 900,
        invalidated_by: [
          "deployment_changed",
          "journey_definition_changed",
          "production_targets_changed",
        ],
      },
    }),
    applicability(_project, brief) {
      if (brief.core_journeys.values.length === 0) {
        return unresolvedApplicability("Confirmed core journeys are required to resolve applicability.");
      }
      return applicable("Core journeys were explicitly confirmed for this release.", [
        intentEvidence("core_journeys", "confirmed"),
      ]);
    },
    verify(_project, brief, authorizationPlan, publicEvidence) {
      return publicVerificationResult({
        brief,
        authorizationPlan,
        publicEvidence,
        subject: "core journeys",
        kinds: ["journey"],
        expectedCount: brief.production_targets.values.length * brief.core_journeys.values.length,
        passedSummary: "Every declared core journey returned a successful public observation.",
      });
    },
  },
]);

function fileEvidence(path) {
  return { kind: "file", path };
}

function intentEvidence(field, value) {
  return { kind: "release_intent", field, value };
}

function factEvidence(field, value) {
  return { kind: "project_fact", field, value };
}

function applicable(reason, evidence) {
  return { status: "applicable", reason, evidence };
}

function notApplicable(reason, evidence) {
  return { status: "not_applicable", reason, evidence };
}

function unresolvedApplicability(reason) {
  return { status: "unverified", reason, evidence: [] };
}

function passed(summary, evidence) {
  return { status: "passed", summary, evidence };
}

function failed(summary, evidence, action) {
  return { status: "failed", summary, evidence, ...(action ? { action } : {}) };
}

function unverified(reason_code, summary, evidence = []) {
  return { status: "unverified", reason_code, summary, evidence };
}

function providerCheckDeclaration(request) {
  const riskDomain = providerRiskDomain(request.roles);
  const critical = riskDomain === "data_and_integrations";
  return declaration({
    check_id: `provider.${request.provider}.metadata`,
    risk_domain: riskDomain,
    permission_id: request.permission_id,
    required_inputs: [
      "audit_brief.provider_roles.values",
      `provider_result.evidence[provider=${request.provider}]`,
    ],
    evidence_requirement: MACHINE_EVIDENCE,
    verification_rules: [
      `Pass only when ${request.provider} returns current, provenance-backed Machine Evidence for its selected roles.`,
      "Missing, denied, unsupported, or failed Provider reads remain Unverified.",
    ],
    severity: critical ? "critical" : "major",
    gate: critical ? "always" : "policy",
    dependency_unblocking: critical,
    core_journey_impact: riskDomain === "observability_and_operations" ? "none" : "indirect",
    freshness: {
      mode: "live_state",
      max_age_seconds: 900,
      invalidated_by: [
        "provider_roles_changed",
        "provider_configuration_changed",
        "deployment_changed",
      ],
    },
  });
}

function executeProviderCheck(request, providerResult) {
  const declared = providerCheckDeclaration(request);
  const applicability = applicable(
    `Confirmed release intent selects ${request.provider} Provider metadata verification.`,
    [intentEvidence("provider_roles", `confirmed:${request.provider}`)],
  );
  const providerEvidence = providerResult.evidence.filter(
    (evidence) => evidence.provider === request.provider,
  );
  const gap = providerResult.verification_gaps.find(
    (candidate) => candidate.check_id === declared.check_id,
  );
  const result = gap
    ? unverified(gap.reason_code, gap.reason, providerEvidence)
    : providerEvidence.length === 0
      ? unverified(
        "partial_provider_evidence",
        `${request.provider} verification returned no Machine Evidence.`,
      )
      : passed(
        `${request.provider} returned current, provenance-backed Machine Evidence.`,
        providerEvidence,
      );
  return {
    declaration: declared,
    result: {
      ...resultBase(declared, applicability),
      ...result,
    },
  };
}

function environmentNames(project) {
  return project.facts
    .filter((fact) => fact.kind === "environment_variables")
    .flatMap((fact) => fact.names);
}

function environmentFactEvidence(project, matchingNames) {
  if (matchingNames.length === 0) return [];
  return project.facts
    .filter((fact) => fact.kind === "environment_variables")
    .filter((fact) => fact.names.some((name) => matchingNames.includes(name)))
    .map((fact) => fileEvidence(fact.provenance.path));
}

function productionApplicability(brief, reason) {
  if (brief.production_targets.values.length === 0) {
    return unresolvedApplicability("Confirmed production targets are required to resolve applicability.");
  }
  return applicable(reason, [intentEvidence("production_targets", "confirmed")]);
}

function publicPermission(authorizationPlan) {
  return authorizationPlan.find((entry) => entry.permission_id === "public_verification");
}

function unavailablePublicVerification(brief, authorizationPlan, subject) {
  const permission = publicPermission(authorizationPlan);
  if (!permission || permission.decision !== "approved") {
    return unverified(
      permission?.decision === "denied" ? "permission_denied" : "execution_skipped",
      permission?.decision === "denied"
        ? `Public ${subject} verification was not authorized for: ${brief.production_targets.values.join(", ")}.`
        : `Public ${subject} verification remains undecided and was not run for: ${brief.production_targets.values.join(", ")}.`,
    );
  }
  return unverified(
    "specialist_support_unavailable",
    `Public ${subject} verification is authorized but its specialist executor is not available in this catalog version.`,
  );
}

function publicVerificationResult({
  brief,
  authorizationPlan,
  publicEvidence,
  subject,
  kinds,
  expectedCount,
  passedSummary,
}) {
  const permission = publicPermission(authorizationPlan);
  if (!permission || permission.decision !== "approved") {
    return unavailablePublicVerification(brief, authorizationPlan, subject);
  }
  const evidence = publicEvidence.filter((item) => kinds.includes(item.probe_kind));
  if (evidence.length < expectedCount) {
    return unverified(
      "partial_public_evidence",
      `Public ${subject} verification did not return all disclosed observations.`,
      evidence,
    );
  }
  if (evidence.some((item) => item.status === "unverified")) {
    return unverified(
      "partial_public_evidence",
      `Public ${subject} verification was only partially reachable.`,
      evidence,
    );
  }
  if (evidence.some((item) => item.status === "failed")) {
    return failed(`Public ${subject} verification failed.`, evidence);
  }
  return passed(passedSummary, evidence);
}

function resultBase(declared, applicability) {
  return {
    check_id: declared.check_id,
    check_version: declared.check_version,
    risk_domain: declared.risk_domain,
    priority: "p0",
    severity: declared.severity_policy.severity,
    release_gate: declared.release_gate_policy.gate,
    applicability,
  };
}

function executeCheck(
  check,
  project,
  auditBrief,
  authorizationPlan,
  publicEvidence,
) {
  let applicability;
  try {
    applicability = check.applicability(project, auditBrief);
  } catch {
    applicability = unresolvedApplicability(
      "Applicability evaluation failed; this Check cannot be treated as Passed or Not Applicable.",
    );
  }

  const base = resultBase(check.declaration, applicability);
  if (
    check.declaration.permission_id === "local_safe_scan"
    && project.safe_scan?.errors?.length > 0
  ) {
    return {
      ...base,
      status: "unverified",
      reason_code: "execution_skipped",
      summary: "Local execution was skipped because the safe scan did not complete without collection errors.",
      evidence: [],
    };
  }
  if (applicability.status === "not_applicable") {
    return {
      ...base,
      status: "not_applicable",
      summary: applicability.reason,
      evidence: applicability.evidence,
    };
  }
  if (applicability.status !== "applicable") {
    return {
      ...base,
      status: "unverified",
      reason_code: "applicability_unresolved",
      summary: applicability.reason,
      evidence: applicability.evidence,
    };
  }

  try {
    return {
      ...base,
      ...check.verify(project, auditBrief, authorizationPlan, publicEvidence),
    };
  } catch {
    return {
      ...base,
      status: "unverified",
      reason_code: "execution_failure",
      summary: "Check execution failed; no readiness conclusion was produced.",
      evidence: [],
    };
  }
}

export function describeWebBaselineCatalog() {
  return {
    versions: {
      check_catalog: CHECK_CATALOG_VERSION,
      baseline: BASELINE_VERSION,
      active_profiles: [],
      active_adapters: [],
    },
    risk_domains: [...WEB_RISK_DOMAINS],
    checks: CHECKS.map(({ declaration: declared }) => structuredClone(declared)),
  };
}

export function executeWebBaseline({
  project,
  audit_brief,
  authorization_plan = [],
  public_evidence = [],
  provider_result = { evidence: [], verification_gaps: [] },
}) {
  const catalog = describeWebBaselineCatalog();
  const checks = CHECKS.map((check) =>
    executeCheck(
      check,
      project,
      audit_brief,
      authorization_plan,
      public_evidence,
    ),
  );
  const providerRequests = audit_brief.provider_adapters?.requests
    ?? createProviderAdapterPlan(audit_brief.provider_roles.values).requests;
  const providerChecks = providerRequests.map((request) =>
    executeProviderCheck(request, provider_result),
  );
  catalog.checks.push(...providerChecks.map(({ declaration: declared }) =>
    structuredClone(declared),
  ));
  checks.push(...providerChecks.map(({ result }) => result));
  const verification_gaps = checks
    .filter((check) => check.status === "unverified")
    .map((check) => ({
      check_id: check.check_id,
      risk_domain: check.risk_domain,
      priority: check.priority,
      status: "unverified",
      reason_code: check.reason_code,
      reason: check.summary,
    }));

  return {
    catalog,
    checks,
    verification_gaps,
    domain_coverage: WEB_RISK_DOMAINS.map((risk_domain) => {
      const domainChecks = checks.filter((check) => check.risk_domain === risk_domain);
      return {
        risk_domain,
        check_ids: domainChecks.map((check) => check.check_id),
        statuses: [...new Set(domainChecks.map((check) => check.status))].sort(),
      };
    }),
  };
}
