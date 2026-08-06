import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  CLI_INTERACTION_CONTRACT,
  REPORT_SCHEMA,
} from "@launchrally/contracts";

import {
  LOCAL_SAFE_SCAN_POLICY,
  scanRepository,
  SUPPORTED_LOCKFILES,
} from "./local-safe-scan.js";
import {
  advanceAuditInteraction,
  createInitialAuditInteraction,
} from "./audit-interaction.js";

const WEB_CHECK_CATALOG = Object.freeze([
  {
    check_id: "web.baseline.lockfile",
    check_version: 1,
    priority: "p0",
    appliesTo(project) {
      return project.type === "web";
    },
    run(project) {
      const lockfile = project.detected_files.find((file) =>
        SUPPORTED_LOCKFILES.some(([candidate]) => candidate === file),
      );

      if (lockfile) {
        return {
          status: "passed",
          summary: "A dependency lockfile is present for reproducible installs.",
          evidence: [{ kind: "file", path: lockfile }],
        };
      }

      return {
        status: "failed",
        summary: "No dependency lockfile was found, so installs are not reproducible.",
        evidence: [],
      };
    },
  },
]);

const LOCAL_AUDIT_LIMITATIONS = Object.freeze([
  "Only local repository facts were inspected; public and Provider network Checks were not run.",
  "The P0 Web Check Catalog is incomplete, so this Audit cannot establish Launch Ready status.",
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

function runApplicableChecks(project) {
  return WEB_CHECK_CATALOG
    .filter((check) => check.appliesTo(project))
    .map((check) => ({
      check_id: check.check_id,
      check_version: check.check_version,
      priority: check.priority,
      ...check.run(project),
    }));
}

function permissionVerificationGaps(authorizationPlan = []) {
  return authorizationPlan
    .filter((permission) => permission.decision === "denied")
    .map((permission) => {
      if (permission.boundary === "public_network") {
        return {
          check_id: "web.public.endpoint",
          priority: "p0",
          status: "unverified",
          reason_code: "permission_denied",
          reason: `Public verification permission was denied for: ${permission.scope.targets.join(", ")}.`,
        };
      }
      return {
        check_id: `provider.${permission.scope.provider}.metadata`,
        priority: "p0",
        status: "unverified",
        reason_code: "permission_denied",
        reason: `Provider read permission was denied for ${permission.scope.provider} metadata: ${permission.scope.metadata.join(", ")}.`,
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
  const checks = runApplicableChecks(snapshot.project);
  const passedChecks = checks.filter((check) => check.status === "passed").length;
  const failedChecks = checks.filter((check) => check.status === "failed").length;
  const permissionGaps = permissionVerificationGaps(interactionResult.authorization_plan);

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
        check_catalog_version: "web-baseline/v1",
        scan_policy_version: LOCAL_SAFE_SCAN_POLICY,
      },
      scope: {
        project_root: snapshot.project.root,
        project_type: snapshot.project.type,
        access: "local_read_only",
        excluded: ["public_network", "providers", "production"],
      },
      results: {
        checks,
        action_queue: checks
          .filter((check) => check.status === "failed")
          .map((check) => ({
            check_id: check.check_id,
            priority: check.priority,
            action: "Commit the package manager lockfile generated by the project dependency install.",
          })),
        verification_gaps: [
          {
            check_id: "web.p0.remaining-coverage",
            priority: "p0",
            status: "unverified",
            reason: "The P0 Web Check Catalog is incomplete; only the lockfile baseline is implemented.",
          },
          ...permissionGaps,
        ],
        coverage_summary: [
          {
            priority: "p0",
            applicable_checks: checks.length,
            executed_checks: checks.length,
            passed_checks: passedChecks,
            failed_checks: failedChecks,
            verification_gaps: 1 + permissionGaps.length,
            coverage: "partial",
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
