import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  CLI_INTERACTION_CONTRACT,
  REPORT_SCHEMA,
} from "@launchrally/contracts";

import {
  LOCAL_SAFE_SCAN_POLICY,
  scanRepository,
} from "./local-safe-scan.js";
import {
  advanceAuditInteraction,
  createInitialAuditInteraction,
} from "./audit-interaction.js";
import { executeWebBaseline } from "./check-catalog.js";
import { collectPublicEvidence } from "./public-verification.js";

const LOCAL_AUDIT_LIMITATIONS = Object.freeze([
  "Local Checks use only normalized, secret-safe repository facts.",
  "Provider specialist executors are not available in this catalog version, so their Checks remain Unverified.",
]);

export async function discoverProject(cwd) {
  const scan = await scanRepository(cwd);
  const packageFact = scan.facts.find(
    (fact) => fact.kind === "package_manifest" && fact.provenance.path === "package.json",
  );
  const lockfileFacts = scan.facts.filter(
    (fact) => fact.kind === "lockfile" && !fact.provenance.path.includes("/"),
  );
  const packageManifestStatus = packageFact?.status ?? "missing";

  return {
    root: scan.root,
    name: packageFact?.name ?? path.basename(scan.root),
    type: packageManifestStatus === "valid" ? "web" : "unknown",
    package_manifest: { path: "package.json", status: packageManifestStatus },
    package_manager: lockfileFacts[0]?.package_manager ?? "unknown",
    script_names: packageFact?.script_names ?? [],
    detected_files: [
      ...(packageFact ? ["package.json"] : []),
      ...lockfileFacts.map((fact) => fact.provenance.path),
    ],
    facts: scan.facts,
    safe_scan: {
      policy_version: scan.policy_version,
      exclusions: scan.exclusions,
      errors: scan.errors,
    },
  };
}

export async function createInitialSnapshot(cwd) {
  const project = await discoverProject(cwd);

  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "completed",
    kind: "initial_readiness_snapshot",
    project,
    obvious_blockers: {
      valid: [],
      invalid: ["package.json exists but could not be read as a valid package manifest."],
      missing: ["No package.json was found, so a conventional Web repository could not be identified."],
    }[project.package_manifest.status],
    limitations: [...LOCAL_AUDIT_LIMITATIONS],
    next: {
      type: "none",
      required: false,
      message: "No input or approval is required for this local-only Audit.",
    },
  };
}

function providerVerificationGaps(authorizationPlan = []) {
  return authorizationPlan
    .filter((permission) => permission.boundary === "provider_read")
    .map((permission) => {
      const roles = permission.scope.metadata.map((item) => item.split(".")[0]);
      const riskDomain = roles.includes("observability")
        ? "observability_and_operations"
        : roles.includes("deployment")
          ? "deployment"
          : "data_and_integrations";
      return {
        check_id: `provider.${permission.scope.provider}.metadata`,
        risk_domain: riskDomain,
        priority: "p0",
        status: "unverified",
        reason_code: permission.decision === "denied"
          ? "permission_denied"
          : "specialist_support_unavailable",
        reason: permission.decision === "denied"
          ? `Provider read permission was denied for ${permission.scope.provider} metadata: ${permission.scope.metadata.join(", ")}.`
          : `Provider read permission is authorized for ${permission.scope.provider}, but its specialist executor is unavailable.`,
      };
    });
}

export async function runAudit(cwd, version, interactionOptions = {}) {
  const snapshot = await createInitialSnapshot(cwd);
  if (!interactionOptions.resume_token) {
    return createInitialAuditInteraction(snapshot);
  }
  const interactionResult = advanceAuditInteraction(snapshot, interactionOptions);
  if (interactionResult.status !== "completed") return interactionResult;
  if (interactionResult.outcome === "scope_not_confirmed") return interactionResult;
  const publicPermission = interactionResult.authorization_plan.find(
    (permission) => permission.permission_id === "public_verification",
  );
  const publicEvidence = publicPermission?.decision === "approved"
    ? await collectPublicEvidence(interactionResult.audit_brief.public_verification)
    : [];
  const baseline = executeWebBaseline({
    project: snapshot.project,
    audit_brief: interactionResult.audit_brief,
    authorization_plan: interactionResult.authorization_plan,
    public_evidence: publicEvidence,
  });
  const checks = baseline.checks;
  const passedChecks = checks.filter((check) => check.status === "passed").length;
  const failedChecks = checks.filter((check) => check.status === "failed").length;
  const notApplicableChecks = checks.filter(
    (check) => check.status === "not_applicable",
  ).length;
  const providerGaps = providerVerificationGaps(interactionResult.authorization_plan);
  const verificationGaps = [...baseline.verification_gaps, ...providerGaps];
  const reportChecks = checks.map(({ action: _action, reason_code: _reasonCode, ...check }) => check);

  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "completed",
    operation: "audit",
    snapshot,
    audit_brief: interactionResult.audit_brief,
    authorization_plan: interactionResult.authorization_plan,
    interaction: interactionResult.interaction,
    report: {
      schema_version: REPORT_SCHEMA,
      report_id: randomUUID(),
      assessment: failedChecks > 0 ? "no_go" : "inconclusive",
      provenance: {
        cli_version: version,
        check_catalog_version: baseline.catalog.versions.check_catalog,
        baseline_version: baseline.catalog.versions.baseline,
        active_profile_versions: baseline.catalog.versions.active_profiles,
        active_adapter_versions: baseline.catalog.versions.active_adapters,
        scan_policy_version: LOCAL_SAFE_SCAN_POLICY,
      },
      scope: {
        project_root: snapshot.project.root,
        project_type: snapshot.project.type,
        access: publicPermission?.decision === "approved"
          ? "local_and_public_read_only"
          : "local_read_only",
        public_verification: {
          decision: publicPermission?.decision ?? "denied",
          targets: interactionResult.audit_brief.public_verification.targets,
          probe_ids: publicEvidence.map((item) => item.probe_id),
        },
        excluded: publicPermission?.decision === "approved"
          ? ["providers", "production_mutations"]
          : ["public_network", "providers", "production_mutations"],
      },
      catalog: baseline.catalog,
      results: {
        checks: reportChecks,
        public_evidence: publicEvidence,
        action_queue: checks
          .filter((check) => check.status === "failed")
          .map((check) => ({
            check_id: check.check_id,
            priority: check.priority,
            action: check.action ?? "Resolve the failed baseline verification rule.",
          })),
        verification_gaps: verificationGaps,
        domain_coverage: baseline.domain_coverage,
        coverage_summary: [
          {
            priority: "p0",
            applicable_checks: checks.length - notApplicableChecks,
            executed_checks: passedChecks + failedChecks,
            passed_checks: passedChecks,
            failed_checks: failedChecks,
            not_applicable_checks: notApplicableChecks,
            verification_gaps: verificationGaps.length,
            coverage: verificationGaps.length === 0 ? "complete" : "partial",
          },
        ],
      },
      limitations: [...LOCAL_AUDIT_LIMITATIONS],
    },
  };
}

export function createNotImplementedResult(operation) {
  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "not_implemented",
    operation,
    message: `The ${operation} workflow is reserved by the Phase 0 contract but is not implemented in this scaffold.`,
  };
}
