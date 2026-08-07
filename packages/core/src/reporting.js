import { createHash, randomUUID } from "node:crypto";

import {
  EVIDENCE_INDEX_SCHEMA,
  REPORT_SCHEMA,
  REPORT_VIEW_SCHEMA,
  assertSupportedReportVersion,
} from "@launchrally/contracts";

import { LOCAL_SAFE_SCAN_POLICY } from "./local-safe-scan.js";
import { MANIFEST_RELATIVE_PATH } from "./manifest.js";
import { evaluateLaunchPolicy } from "./policy-engine.js";

export const REPORT_GENERATOR_VERSION = "report-generator/v1";

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      canonicalValue(value[key]),
    ]));
  }
  return value;
}

function digest(value) {
  const serialized = JSON.stringify(canonicalValue(value));
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

export function createVerificationContext({ repository_digests = {}, audit_brief }) {
  const repositoryDigests = Object.entries(repository_digests)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, contentDigest]) => ({ path, digest: contentDigest }));
  return {
    digest_version: "verification-scope-digests/v1",
    repository_digests: repositoryDigests,
    manifest_digest: repository_digests[MANIFEST_RELATIVE_PATH] ?? null,
    target_digest: digest({
      intended_environment: audit_brief.intended_environment.value,
      production_targets: audit_brief.production_targets.values,
      core_journeys: audit_brief.core_journeys.values,
      provider_roles: audit_brief.provider_roles.values,
      support_layers: audit_brief.support_layers.values,
    }),
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function evidenceMetadata(evidence, createdAt) {
  if (evidence.kind === "public_observation") {
    return {
      source: evidence.provenance.collector,
      target: evidence.provenance.exact_target,
      collected_at: evidence.collected_at,
      freshness_class: "audit_time",
      redaction_state: "normalized",
    };
  }
  if (evidence.kind === "machine_evidence") {
    return {
      source: evidence.provenance.collector,
      target: evidence.provenance.exact_target,
      collected_at: evidence.collected_at,
      freshness_class: "audit_time",
      redaction_state: "allowlisted",
    };
  }
  if (evidence.kind === "file") {
    return {
      source: "local_safe_scan/v1",
      target: `repository:${evidence.path}`,
      collected_at: createdAt,
      freshness_class: "repository_snapshot",
      redaction_state: "metadata_only",
    };
  }
  if (evidence.kind === "release_intent") {
    return {
      source: "audit-brief/v1",
      target: `release_intent:${evidence.field}`,
      collected_at: createdAt,
      freshness_class: "confirmed_scope",
      redaction_state: "metadata_only",
    };
  }
  if (evidence.kind === "project_fact") {
    return {
      source: "local_safe_scan/v1",
      target: `project_fact:${evidence.field}`,
      collected_at: createdAt,
      freshness_class: "repository_snapshot",
      redaction_state: "metadata_only",
    };
  }
  const error = new Error("Unsupported evidence kind.");
  error.code = "unsupported_evidence_kind";
  throw error;
}

function createEvidenceRegistry({ reportId, createdAt, id, repositoryDigests }) {
  const byDigest = new Map();

  function reference(evidence) {
    const normalizedArtifact = structuredClone(evidence);
    if (evidence.kind === "file") {
      normalizedArtifact.content_digest = repositoryDigests[evidence.path] ?? null;
    }
    const artifactDigest = digest(normalizedArtifact);
    if (!byDigest.has(artifactDigest)) {
      byDigest.set(artifactDigest, {
        digest: artifactDigest,
        evidence_kind: evidence.kind,
        ...evidenceMetadata(evidence, createdAt),
        normalized_artifact: normalizedArtifact,
      });
    }
    const { normalized_artifact: _artifact, evidence_kind: _kind, ...metadata } =
      byDigest.get(artifactDigest);
    return structuredClone(metadata);
  }

  function index() {
    return {
      schema_version: EVIDENCE_INDEX_SCHEMA,
      index_id: id(),
      report_id: reportId,
      created_at: createdAt,
      entries: [...byDigest.values()].map((entry) => structuredClone(entry)),
    };
  }

  return { reference, index };
}

function indexedCheck(check, evidenceRegistry) {
  return {
    ...structuredClone(check),
    applicability: {
      ...structuredClone(check.applicability),
      evidence: check.applicability.evidence.map(evidenceRegistry.reference),
    },
    evidence: check.evidence.map(evidenceRegistry.reference),
  };
}

function accessScope(publicAccess, providerAccess) {
  if (publicAccess && providerAccess) return "local_public_and_provider_read_only";
  if (publicAccess) return "local_and_public_read_only";
  if (providerAccess) return "local_and_provider_read_only";
  return "local_read_only";
}

function reportScope({ snapshot, auditBrief, authorizationPlan, providerResult }) {
  const publicPermission = authorizationPlan.find(
    (permission) => permission.permission_id === "public_verification",
  );
  const publicAccess = publicPermission?.decision === "approved";
  const providerAccess = providerResult.active_adapter_versions.length > 0;
  return {
    project_root: snapshot.project.root,
    project_type: snapshot.project.type,
    project: {
      name: snapshot.project.name,
      root: snapshot.project.root,
      type: snapshot.project.type,
      package_manager: snapshot.project.package_manager,
      obvious_blockers: [...snapshot.obvious_blockers],
    },
    release_intent: {
      intended_environment: auditBrief.intended_environment.value,
      production_targets: structuredClone(auditBrief.production_targets.values),
      core_journeys: structuredClone(auditBrief.core_journeys.values),
      provider_roles: structuredClone(auditBrief.provider_roles.values),
      support_layers: structuredClone(auditBrief.support_layers.values),
      confirmed: [
        auditBrief.intended_environment,
        auditBrief.production_targets,
        auditBrief.core_journeys,
        auditBrief.provider_roles,
        auditBrief.support_layers,
      ].every((selection) => selection.confirmed),
    },
    access: accessScope(publicAccess, providerAccess),
    public_verification: {
      decision: publicPermission?.decision ?? "denied",
      targets: structuredClone(auditBrief.public_verification.targets),
    },
    provider_verification: {
      contract_version: auditBrief.provider_adapters.contract_version,
      requests: auditBrief.provider_adapters.requests.map((request) => ({
        provider: request.provider,
        adapter_version: request.adapter_version,
        target: request.target,
        requested_fields: structuredClone(request.requested_fields),
        decision: authorizationPlan.find(
          (permission) => permission.permission_id === request.permission_id,
        )?.decision ?? "denied",
      })),
    },
    excluded: [
      ...(!publicAccess ? ["public_network"] : []),
      ...(!providerAccess ? ["providers"] : ["unrequested_provider_data"]),
      "production_mutations",
    ],
  };
}

function executionDisclosure({ auditBrief, interaction, evidenceIndex }) {
  return {
    disclosure_version: "audit-execution-disclosure/v1",
    interaction: interaction ? structuredClone(interaction) : null,
    planned_checks: structuredClone(auditBrief.planned_checks),
    public_verification: structuredClone(auditBrief.public_verification),
    provider_adapters: structuredClone(auditBrief.provider_adapters),
    evidence_index: {
      schema_version: evidenceIndex.schema_version,
      index_id: evidenceIndex.index_id,
      entry_count: evidenceIndex.entries.length,
    },
  };
}

function oneLine(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function titleCase(value) {
  return value.split("_").map((word) => `${word[0].toUpperCase()}${word.slice(1)}`).join(" ");
}

function markdownList(items, render, empty = "- None") {
  return items.length > 0 ? items.map((item) => `- ${render(item)}`).join("\n") : empty;
}

export function renderReportMarkdown(record) {
  assertSupportedReportVersion(record);
  const scope = record.scope;
  const lines = [
    "# LaunchRally Audit Report",
    "",
    `Report Record: ${oneLine(record.report_id)}`,
    `Created: ${oneLine(record.created_at)}`,
    `Assessment: ${record.assessment ? titleCase(record.assessment) : "Not Current"}`,
    `Report Current: ${record.policy.current ? "Yes" : "No"}`,
    "",
    "## Audit Brief",
    "",
    `Environment: ${oneLine(scope.release_intent.intended_environment ?? "unconfirmed")}`,
    ...scope.release_intent.production_targets.map((target) => `Target: ${oneLine(target)}`),
    ...scope.release_intent.core_journeys.map((journey) =>
      typeof journey === "string"
        ? `Core journey: ${oneLine(journey)}`
        : `Core journey: ${oneLine(journey.method)} ${oneLine(journey.path)} — ${oneLine(journey.purpose)}`,
    ),
    "",
    "## Initial Readiness Snapshot",
    "",
    `Project: ${oneLine(scope.project.name)} (${oneLine(scope.project.type)})`,
    `Package manager: ${oneLine(scope.project.package_manager)}`,
    `Scope: ${oneLine(scope.access)}`,
    "",
    "### Obvious Blockers",
    "",
    markdownList(scope.project.obvious_blockers, oneLine),
    "",
    "## Permissions",
    "",
    markdownList(record.permissions, (permission) =>
      `${oneLine(permission.permission_id)}: ${oneLine(permission.decision).toUpperCase()}`,
    ),
    "",
    "## Execution Disclosure",
    "",
    `Planned Checks: ${record.execution.planned_checks.length}`,
    `Public Probes: ${record.execution.public_verification.probes.length}`,
    `Provider Reads: ${record.execution.provider_adapters.requests.length}`,
    `Evidence Index: ${oneLine(record.execution.evidence_index.index_id)} (${record.execution.evidence_index.entry_count} entries)`,
    "",
    "## Checks",
    "",
    markdownList(record.results.checks, (check) =>
      `${{ passed: "PASS", failed: "FAIL" }[check.status] ?? check.status.toUpperCase()} [${check.priority.toUpperCase()}] ${oneLine(check.check_id)} — ${oneLine(check.summary)}`,
    ),
    "",
    "## Action Queue",
    "",
    markdownList(record.results.action_queue, (item) =>
      `[${item.priority.toUpperCase()}] ${oneLine(item.check_id)} — ${oneLine(item.action)}`,
    ),
    "",
    "## Verification Gaps",
    "",
    markdownList(record.results.verification_gaps, (gap) =>
      `${gap.status.toUpperCase()} [${gap.priority.toUpperCase()}] ${oneLine(gap.check_id)} — ${oneLine(gap.reason)}`,
    ),
    "",
    "## Limitations",
    "",
    markdownList(record.limitations, oneLine),
    "",
  ];
  return lines.join("\n");
}

export function createReportPackage({
  cli_version,
  snapshot,
  audit_brief,
  authorization_plan,
  interaction,
  baseline,
  public_evidence,
  provider_result,
  limitations,
  content_changes = [],
  repository_digests = {},
  currentness_reasons = [],
}, dependencies = {}) {
  assertSupportedReportVersion(REPORT_SCHEMA);
  const now = dependencies.now ?? (() => new Date());
  const id = dependencies.id ?? randomUUID;
  const createdAt = now().toISOString();
  const reportId = id();
  const evidenceRegistry = createEvidenceRegistry({
    reportId,
    createdAt,
    id,
    repositoryDigests: repository_digests,
  });
  const checks = baseline.checks.map((check) => indexedCheck(check, evidenceRegistry));
  const publicEvidenceRefs = public_evidence.map(evidenceRegistry.reference);
  const providerEvidenceRefs = provider_result.evidence.map(evidenceRegistry.reference);
  const evidenceIndex = evidenceRegistry.index();
  const scopeConfirmed = [
    audit_brief.intended_environment,
    audit_brief.production_targets,
    audit_brief.core_journeys,
    audit_brief.provider_roles,
    audit_brief.support_layers,
  ].every((selection) => selection.confirmed);
  const policyResult = evaluateLaunchPolicy({
    catalog: baseline.catalog,
    checks,
    scope: {
      confirmed: scopeConfirmed,
    },
    evidence_index: evidenceIndex,
    evaluated_at: createdAt,
    content_changes,
    currentness_reasons,
  });
  const evidenceCurrentness = new Map(
    policyResult.evidence_currentness.map((state) => [state.digest, state]),
  );
  for (const entry of evidenceIndex.entries) {
    const state = evidenceCurrentness.get(entry.digest);
    entry.current = state.current;
    entry.currentness = structuredClone(state.currentness);
  }
  const domainCoverage = baseline.catalog.risk_domains.map((risk_domain) => {
    const domainChecks = policyResult.findings.filter(
      (check) => check.risk_domain === risk_domain,
    );
    return {
      risk_domain,
      check_ids: domainChecks.map((check) => check.check_id),
      statuses: [...new Set(domainChecks.map((check) => check.status))].sort(),
    };
  });
  const coverage = policyResult.coverage_summary;
  const reportChecks = policyResult.findings.map(
    ({ action: _action, reason_code: _reasonCode, ...check }) => check,
  );
  const record = {
    schema_version: REPORT_SCHEMA,
    report_id: reportId,
    created_at: createdAt,
    assessment: policyResult.assessment,
    provenance: {
      generator_version: REPORT_GENERATOR_VERSION,
      cli_version,
      check_catalog_version: baseline.catalog.versions.check_catalog,
      baseline_version: baseline.catalog.versions.baseline,
      active_profile_versions: structuredClone(baseline.catalog.versions.active_profiles),
      active_adapter_versions: structuredClone(provider_result.active_adapter_versions),
      scan_policy_version: LOCAL_SAFE_SCAN_POLICY,
    },
    policy: {
      engine_version: policyResult.policy_version,
      current: policyResult.current,
      currentness: structuredClone(policyResult.currentness),
    },
    verification_context: createVerificationContext({
      repository_digests,
      audit_brief,
    }),
    scope: reportScope({
      snapshot,
      auditBrief: audit_brief,
      authorizationPlan: authorization_plan,
      providerResult: provider_result,
    }),
    permissions: structuredClone(authorization_plan),
    execution: executionDisclosure({
      auditBrief: audit_brief,
      interaction,
      evidenceIndex,
    }),
    catalog: structuredClone(baseline.catalog),
    results: {
      checks: reportChecks,
      public_evidence_refs: publicEvidenceRefs,
      provider_evidence_refs: providerEvidenceRefs,
      action_queue: policyResult.action_queue,
      verification_gaps: policyResult.verification_gaps,
      domain_coverage: domainCoverage,
      coverage_summary: [{
        priority: "p0",
        applicable_checks: coverage.applicable_checks,
        executed_checks: coverage.passed_checks + coverage.failed_checks,
        passed_checks: coverage.passed_checks,
        failed_checks: coverage.failed_checks,
        unverified_checks: coverage.unverified_checks,
        not_applicable_checks: coverage.not_applicable_checks,
        verification_gaps: policyResult.verification_gaps.length,
        coverage: coverage.coverage,
      }],
    },
    limitations: structuredClone(limitations),
  };
  assertSupportedReportVersion(record);
  const reportView = {
    schema_version: REPORT_VIEW_SCHEMA,
    report_id: record.report_id,
    report_schema_version: record.schema_version,
    generated_at: record.created_at,
    format: "markdown",
    content: renderReportMarkdown(record),
  };
  return deepFreeze({
    report: record,
    report_view: reportView,
    evidence_index: evidenceIndex,
  });
}
