import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  CLI_INTERACTION_CONTRACT,
  REPORT_SCHEMA,
} from "@launchrally/contracts";

const LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
];

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
        LOCKFILES.some(([candidate]) => candidate === file),
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

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readPackageManifest(cwd) {
  const packagePath = path.join(cwd, "package.json");
  if (!(await exists(packagePath))) return { status: "missing", manifest: null };

  try {
    const manifest = JSON.parse(await readFile(packagePath, "utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      return { status: "invalid", manifest: null };
    }
    return { status: "valid", manifest };
  } catch {
    return { status: "invalid", manifest: null };
  }
}

function normalizeScripts(scripts) {
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return {};

  return Object.fromEntries(
    Object.entries(scripts)
      .filter(([, command]) => typeof command === "string")
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export async function discoverProject(cwd) {
  const packageManifest = await readPackageManifest(cwd);
  const packageJson = packageManifest.manifest;
  let packageManager = "unknown";
  const detectedFiles = [];

  if (packageManifest.status !== "missing") detectedFiles.push("package.json");

  for (const [lockfile, manager] of LOCKFILES) {
    if (await exists(path.join(cwd, lockfile))) {
      detectedFiles.push(lockfile);
      if (packageManager === "unknown") packageManager = manager;
    }
  }

  return {
    root: path.resolve(cwd),
    name: typeof packageJson?.name === "string" && packageJson.name.length > 0
      ? packageJson.name
      : path.basename(path.resolve(cwd)),
    type: packageManifest.status === "valid" ? "web" : "unknown",
    package_manifest: { path: "package.json", status: packageManifest.status },
    package_manager: packageManager,
    scripts: normalizeScripts(packageJson?.scripts),
    detected_files: detectedFiles,
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

export async function runAudit(cwd, version) {
  const snapshot = await createInitialSnapshot(cwd);
  const checks = runApplicableChecks(snapshot.project);
  const passedChecks = checks.filter((check) => check.status === "passed").length;
  const failedChecks = checks.filter((check) => check.status === "failed").length;

  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "completed",
    operation: "audit",
    snapshot,
    report: {
      schema_version: REPORT_SCHEMA,
      report_id: randomUUID(),
      assessment: failedChecks > 0 ? "no_go" : "inconclusive",
      provenance: {
        cli_version: version,
        check_catalog_version: "web-baseline/v1",
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
        ],
        coverage_summary: [
          {
            priority: "p0",
            applicable_checks: checks.length,
            executed_checks: checks.length,
            passed_checks: passedChecks,
            failed_checks: failedChecks,
            verification_gaps: 1,
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
