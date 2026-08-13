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
import { throwIfAborted } from "./cancellation.js";
import { executeWebBaseline } from "./check-catalog.js";
import { collectPublicEvidence } from "./public-verification.js";
import { executeProviderAdapters } from "./provider-adapters.js";
import { createReportPackage } from "./reporting.js";

export {
  EXECUTION_AUTHORITY_DESCRIPTOR_PATH,
  resolveExecutionAuthority,
} from "./execution-authority.js";
export { runToolchainLifecycle } from "./toolchain-lifecycle.js";
export { runArchitectureDecisionEngine } from "./architecture-engine.js";
export {
  CAPABILITY_CATALOG_DOMAINS,
  buildCapabilityGraph,
  confirmDerivedObligations,
  createCapabilityCatalog,
  createIntegrationContract,
  invalidatedOutputsForCatalogUpdate,
} from "./capability-model.js";

const LOCAL_AUDIT_LIMITATIONS = Object.freeze([
  "Local Checks use only normalized, secret-safe repository facts.",
  "Provider Adapter evidence is limited to explicitly disclosed, allowlisted metadata fields.",
]);

export async function discoverProject(cwd, { signal } = {}) {
  throwIfAborted(signal);
  const scan = await scanRepository(cwd, { signal });
  throwIfAborted(signal);
  const packageFact = scan.facts.find(
    (fact) => fact.kind === "package_manifest" && fact.provenance.path === "package.json",
  );
  const lockfileFacts = scan.facts.filter(
    (fact) => fact.kind === "lockfile" && !fact.provenance.path.includes("/"),
  );
  const packageManifestStatus = packageFact?.status ?? "missing";

  const project = {
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
      coverage: scan.coverage,
    },
  };
  Object.defineProperty(project, "content_digests", {
    value: scan.content_digests,
    enumerable: false,
  });
  return project;
}

export async function createInitialSnapshot(cwd, { signal } = {}) {
  throwIfAborted(signal);
  const project = await discoverProject(cwd, { signal });
  throwIfAborted(signal);

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

export async function runAudit(cwd, version, interactionOptions = {}, { signal } = {}) {
  throwIfAborted(signal);
  const snapshot = await createInitialSnapshot(cwd, { signal });
  throwIfAborted(signal);
  if (!interactionOptions.resume_token) {
    return createInitialAuditInteraction(snapshot);
  }
  const interactionResult = advanceAuditInteraction(snapshot, interactionOptions);
  if (interactionResult.status !== "completed") return interactionResult;
  const publicPermission = interactionResult.authorization_plan.find(
    (permission) => permission.permission_id === "public_verification",
  );
  const publicEvidence = publicPermission?.decision === "approved"
    ? await collectPublicEvidence(
      interactionResult.audit_brief.public_verification,
      { signal },
    )
    : [];
  throwIfAborted(signal);
  const providerResult = await executeProviderAdapters({
    cwd,
    plan: interactionResult.audit_brief.provider_adapters,
    authorization_plan: interactionResult.authorization_plan,
    signal,
  });
  throwIfAborted(signal);
  const baseline = executeWebBaseline({
    project: snapshot.project,
    audit_brief: interactionResult.audit_brief,
    authorization_plan: interactionResult.authorization_plan,
    public_evidence: publicEvidence,
    authenticated_result: interactionResult.authenticated_result,
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
    authenticated_result: interactionResult.authenticated_result,
    provider_result: providerResult,
    limitations: LOCAL_AUDIT_LIMITATIONS,
    content_changes: interactionOptions.content_changes ?? [],
    repository_digests: snapshot.project.content_digests,
  });
  throwIfAborted(signal);

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
  applyProviderToolRecoveryChoice,
  createProviderToolRecovery,
  inspectProviderTool,
  providerToolInstallationAuthorities,
  runProviderToolRecovery,
} from "./provider-tool-recovery.js";
export { rethrowIfAborted, throwIfAborted } from "./cancellation.js";
export {
  createReportPackage,
  renderReportMarkdown,
  REPORT_GENERATOR_VERSION,
} from "./reporting.js";
export {
  evaluateLaunchPolicy,
  POLICY_ENGINE_VERSION,
} from "./policy-engine.js";
export { evaluateReportCurrentness } from "./report-currentness.js";
export {
  environmentTargetLabel,
  reviewedEnvironmentLabel,
} from "./environment-terminology.js";
export { runInit } from "./initialization.js";
export { runPlan } from "./planning.js";
export { parsePublicJourneyInput } from "./public-journey.js";
export { parsePublicTargetInput } from "./public-target.js";
export { runProviderGuidance } from "./provider-guidance.js";
export {
  PRODUCT_INTENT_ANALYZER_VERSION,
  runProductIntentDiscovery,
} from "./product-intent.js";
export { SUPPORT_LAYER_CATEGORIES } from "./support-layers.js";
export { runVerify } from "./verification.js";
