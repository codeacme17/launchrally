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

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(cwd) {
  const packagePath = path.join(cwd, "package.json");
  if (!(await exists(packagePath))) return null;

  try {
    return JSON.parse(await readFile(packagePath, "utf8"));
  } catch {
    return null;
  }
}

export async function discoverProject(cwd) {
  const packageJson = await readPackageJson(cwd);
  let packageManager = "unknown";
  const detectedFiles = [];

  if (packageJson) detectedFiles.push("package.json");

  for (const [lockfile, manager] of LOCKFILES) {
    if (await exists(path.join(cwd, lockfile))) {
      detectedFiles.push(lockfile);
      if (packageManager === "unknown") packageManager = manager;
    }
  }

  return {
    root: path.resolve(cwd),
    name: packageJson?.name ?? path.basename(path.resolve(cwd)),
    package_manager: packageManager,
    scripts: packageJson?.scripts ?? {},
    detected_files: detectedFiles,
  };
}

export async function createInitialSnapshot(cwd) {
  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "completed",
    kind: "initial_readiness_snapshot",
    project: await discoverProject(cwd),
    obvious_blockers: [],
    next: {
      type: "implementation_required",
      message: "The Phase 0 Check Catalog is not implemented in this scaffold.",
    },
  };
}

export async function runTemplateAudit(cwd, version) {
  const snapshot = await createInitialSnapshot(cwd);

  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "completed",
    operation: "audit",
    snapshot,
    report: {
      schema_version: REPORT_SCHEMA,
      report_id: randomUUID(),
      assessment: "inconclusive",
      provenance: {
        cli_version: version,
        check_catalog_version: null,
      },
      scope: {
        project_root: snapshot.project.root,
      },
      results: {
        action_queue: [],
        verification_gaps: [
          {
            check_id: "template.check-catalog",
            status: "unverified",
            reason: "No Checks are implemented in the initial scaffold.",
          },
        ],
        coverage_summary: [],
      },
      limitations: [
        "Template scaffold only: no production readiness Checks were executed.",
        "No Provider, public-network, or production state was accessed.",
      ],
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
