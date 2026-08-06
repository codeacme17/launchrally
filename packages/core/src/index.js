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
import { executeProviderAdapters } from "./provider-adapters.js";

const LOCAL_AUDIT_LIMITATIONS = Object.freeze([
  "Local Checks use only normalized, secret-safe repository facts.",
  "Provider Adapter evidence is limited to explicitly disclosed, allowlisted metadata fields.",
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
  const providerResult = await executeProviderAdapters({
    cwd,
    plan: interactionResult.audit_brief.provider_adapters,
    authorization_plan: interactionResult.authorization_plan,
  });
  const baseline = executeWebBaseline({
    project: snapshot.project,
    audit_brief: interactionResult.audit_brief,
    authorization_plan: interactionResult.authorization_plan,
    public_evidence: publicEvidence,
  });
  baseline.catalog.versions.active_adapters = providerResult.active_adapter_versions;
  const checks = baseline.checks;
  const passedChecks = checks.filter((check) => check.status === "passed").length;
  const failedChecks = checks.filter((check) => check.status === "failed").length;
  const notApplicableChecks = checks.filter(
    (check) => check.status === "not_applicable",
  ).length;
  const verificationGaps = [
    ...baseline.verification_gaps,
    ...providerResult.verification_gaps,
  ];
  const reportChecks = checks.map(({ action: _action, reason_code: _reasonCode, ...check }) => check);
  const providerAccess = providerResult.active_adapter_versions.length > 0;
  const publicAccess = publicPermission?.decision === "approved";

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
        active_adapter_versions: providerResult.active_adapter_versions,
        scan_policy_version: LOCAL_SAFE_SCAN_POLICY,
      },
      scope: {
        project_root: snapshot.project.root,
        project_type: snapshot.project.type,
        access: publicAccess && providerAccess
          ? "local_public_and_provider_read_only"
          : publicAccess
            ? "local_and_public_read_only"
            : providerAccess
              ? "local_and_provider_read_only"
              : "local_read_only",
        public_verification: {
          decision: publicPermission?.decision ?? "denied",
          targets: interactionResult.audit_brief.public_verification.targets,
          probe_ids: publicEvidence.map((item) => item.probe_id),
        },
        provider_verification: {
          contract_version: interactionResult.audit_brief.provider_adapters.contract_version,
          requests: interactionResult.audit_brief.provider_adapters.requests.map((request) => ({
            provider: request.provider,
            adapter_version: request.adapter_version,
            target: request.target,
            requested_fields: request.requested_fields,
            decision: interactionResult.authorization_plan.find(
              (permission) => permission.permission_id === request.permission_id,
            )?.decision ?? "denied",
          })),
        },
        excluded: [
          ...(!publicAccess ? ["public_network"] : []),
          ...(!providerAccess ? ["providers"] : ["unrequested_provider_data"]),
          "production_mutations",
        ],
      },
      catalog: baseline.catalog,
      results: {
        checks: reportChecks,
        public_evidence: publicEvidence,
        provider_evidence: providerResult.evidence,
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

export {
  createProviderAdapterPlan,
  executeProviderAdapters,
  PROVIDER_ADAPTER_CONTRACT,
} from "./provider-adapters.js";

export function createNotImplementedResult(operation) {
  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "not_implemented",
    operation,
    message: `The ${operation} workflow is reserved by the Phase 0 contract but is not implemented in this scaffold.`,
  };
}
