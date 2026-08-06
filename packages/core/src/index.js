import path from "node:path";

import {
  CLI_INTERACTION_CONTRACT,
} from "@launchrally/contracts";

import {
  scanRepository,
} from "./local-safe-scan.js";
import {
  advanceAuditInteraction,
  createInitialAuditInteraction,
} from "./audit-interaction.js";
import { executeWebBaseline } from "./check-catalog.js";
import { collectPublicEvidence } from "./public-verification.js";
import { executeProviderAdapters } from "./provider-adapters.js";
import { createReportPackage } from "./reporting.js";

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
    provider_result: providerResult,
  });
  baseline.catalog.versions.active_adapters = providerResult.active_adapter_versions;
  const reportPackage = createReportPackage({
    cli_version: version,
    snapshot,
    audit_brief: interactionResult.audit_brief,
    authorization_plan: interactionResult.authorization_plan,
    interaction: interactionResult.interaction,
    baseline,
    public_evidence: publicEvidence,
    provider_result: providerResult,
    limitations: LOCAL_AUDIT_LIMITATIONS,
    content_changes: interactionOptions.content_changes ?? [],
  });

  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "completed",
    operation: "audit",
    outcome: interactionResult.outcome,
    snapshot,
    audit_brief: interactionResult.audit_brief,
    authorization_plan: interactionResult.authorization_plan,
    interaction: interactionResult.interaction,
    ...reportPackage,
    next: {
      type: "init",
      required: false,
      report_id: reportPackage.report.report_id,
      message: "Save this complete Audit JSON, then run rally init --report <path> to preview adoption.",
    },
  };
}

export {
  createProviderAdapterPlan,
  executeProviderAdapters,
  PROVIDER_ADAPTER_CONTRACT,
} from "./provider-adapters.js";
export {
  createReportPackage,
  renderReportMarkdown,
  REPORT_GENERATOR_VERSION,
} from "./reporting.js";
export {
  evaluateLaunchPolicy,
  POLICY_ENGINE_VERSION,
} from "./policy-engine.js";
export { runInit } from "./initialization.js";
export { runPlan } from "./planning.js";

export function createNotImplementedResult(operation) {
  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "not_implemented",
    operation,
    message: `The ${operation} workflow is reserved by the Phase 0 contract but is not implemented in this scaffold.`,
  };
}
