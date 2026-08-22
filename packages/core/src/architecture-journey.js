import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ARCHITECT_INTERACTION_SCHEMA,
  PHASE_1_MIGRATION_PREVIEW_SCHEMA,
  assertValidArchitectInteraction,
  assertValidPhase1Adoption,
  assertValidPhase1MigrationPreview,
} from "@launchrally/contracts";

import { resolveExecutionAuthority } from "./execution-authority.js";
import { loadArchitectureState, storeArchitectureState } from "./architecture-state.js";
import { runArchitectureDecisionEngine } from "./architecture-engine.js";

const STATE_VERSION = "architecture-journey/v1";
const ADOPTION_PATH = ".launchrally/phase-1/adoption.json";
const MIGRATION_FILES = Object.freeze([
  ADOPTION_PATH,
  ".launchrally/phase-1/records/",
  ".launchrally/phase-1/transactions/",
]);
const PRESERVED_PATHS = Object.freeze([
  ".launchrally/manifest.yaml",
  ".launchrally/reports/",
  ".launchrally/evidence/",
]);

async function optionalStat(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function validAdoption(root) {
  const launchrally = await optionalStat(path.join(root, ".launchrally"));
  const phase1 = await optionalStat(path.join(root, ".launchrally", "phase-1"));
  if (!launchrally) return false;
  if (!launchrally.isDirectory() || launchrally.isSymbolicLink()) {
    throw new Error("invalid_p1_adoption");
  }
  if (!phase1) return false;
  if (!phase1.isDirectory() || phase1.isSymbolicLink()) {
    throw new Error("invalid_p1_adoption");
  }
  const selected = path.join(root, ADOPTION_PATH);
  const stat = await optionalStat(selected);
  if (!stat) throw new Error("invalid_p1_adoption");
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid_p1_adoption");
  for (const directory of ["records", "transactions"]) {
    const directoryStat = await optionalStat(path.join(root, ".launchrally", "phase-1", directory));
    if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("invalid_p1_adoption");
    }
  }
  const value = JSON.parse(await readFile(selected, "utf8"));
  assertValidPhase1Adoption(value);
  return true;
}

async function initializedP0Project(root, launcherVersion) {
  const manifest = await optionalStat(path.join(root, ".launchrally", "manifest.yaml"));
  if (!manifest?.isFile() || manifest.isSymbolicLink()) return false;
  const authority = await resolveExecutionAuthority({
    cwd: root,
    launcher_version: launcherVersion,
  });
  return authority.state === "ready"
    && authority.source === "project_toolchain"
    && authority.selection?.project_root === root;
}

function adoptionInteraction(status, state, token, request, extra = {}) {
  const migrationPreview = {
    schema_version: PHASE_1_MIGRATION_PREVIEW_SCHEMA,
    migration: "additive",
    files: [...MIGRATION_FILES],
    preserved_paths: [...PRESERVED_PATHS],
  };
  assertValidPhase1MigrationPreview(migrationPreview);
  const preview = {
    effect_classes: ["local_source"],
    user_visible_effects: [
      "Add Phase 1 adoption metadata and empty local record/transaction directories.",
      "Preserve the Manifest plus immutable Phase 0 Report and Evidence history byte-for-byte.",
    ],
  };
  const interaction = {
    schema_version: ARCHITECT_INTERACTION_SCHEMA,
    interaction_id: "interaction_architecture_p1_migration",
    operation: "architect",
    status,
    state,
    resume_token: token,
    source_refs: [],
    request,
    preview,
  };
  assertValidArchitectInteraction(interaction);
  return {
    contract: ARCHITECT_INTERACTION_SCHEMA,
    operation: "architect",
    status,
    state,
    resume_token: token,
    request,
    preview,
    migration_preview: migrationPreview,
    interaction,
    ...extra,
  };
}

function migrationState(root, source, options) {
  return {
    state_version: STATE_VERSION,
    root,
    stage: "p1_migration_preview",
    source: structuredClone(source),
    review_date: options.review_date,
    launcher_version: options.launcher_version,
    desktop_shared_backend_capability_ids: structuredClone(
      options.desktop_shared_backend_capability_ids,
    ),
  };
}

async function applyAdoption(state, fileOperations = {}) {
  const phase1 = path.join(state.root, ".launchrally", "phase-1");
  const adoption = path.join(state.root, ADOPTION_PATH);
  if (await optionalStat(adoption)) {
    const error = new Error("The Phase 1 adoption target changed after preview.");
    error.code = "p1_migration_project_changed";
    throw error;
  }
  const staging = path.join(
    state.root,
    ".launchrally",
    `.phase-1-staging-${randomUUID()}`,
  );
  const content = {
    schema_version: "launchrally.dev/phase-1-adoption/v1",
    adopted: true,
    launcher_version: state.launcher_version,
    migration: "additive",
    preserved_contracts: [
      "launchrally.dev/manifest/v2",
      "launchrally.dev/report/v2",
      "launchrally.dev/evidence-index/v1",
    ],
    historical_reports_relabelled: false,
  };
  try {
    await mkdir(path.join(staging, "records"), { recursive: true });
    await mkdir(path.join(staging, "transactions"), { recursive: true });
    await writeFile(path.join(staging, "adoption.json"), `${JSON.stringify(content, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fileOperations.before_migration_commit?.();
    await rename(staging, phase1);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runArchitectureJourney(cwd, source = {}, options = {}, dependencies = {}) {
  const selectedRoot = path.resolve(cwd);
  const root = await realpath(selectedRoot);
  const launcherVersion = options.launcher_version ?? "0.4.1";
  if (options.resume_token) {
    const candidate = (dependencies.load_state ?? loadArchitectureState)(options.resume_token);
    const state = candidate?.state_version === STATE_VERSION ? candidate : null;
    if (!state) return runArchitectureDecisionEngine(selectedRoot, source, options, dependencies);
    if (state.root !== root || state.stage !== "p1_migration_preview") {
      return {
        contract: ARCHITECT_INTERACTION_SCHEMA,
        status: "execution_error",
        operation: "architect",
        error: "invalid_resume_token",
      };
    }
    if (["deny", "cancel"].includes(options.migration_confirmation)) {
      return adoptionInteraction(
        options.migration_confirmation === "deny" ? "denied" : "cancelled",
        "blueprint_review",
        null,
        { kind: "none", choices: ["none"] },
        { outcome: options.migration_confirmation === "deny"
          ? "p1_migration_denied"
          : "p1_migration_cancelled" },
      );
    }
    if (options.migration_confirmation !== "confirm") {
      return adoptionInteraction(
        "needs_confirmation",
        "blueprint_review",
        options.resume_token,
        { kind: "p1_migration_confirmation", choices: ["confirm", "deny", "cancel"] },
      );
    }
    if (!await initializedP0Project(root, state.launcher_version)) {
      return {
        contract: ARCHITECT_INTERACTION_SCHEMA,
        status: "execution_error",
        operation: "architect",
        error: "p1_migration_project_changed",
      };
    }
    const decision = runArchitectureDecisionEngine(root, state.source, {
      review_date: state.review_date,
      desktop_shared_backend_capability_ids: state.desktop_shared_backend_capability_ids,
    }, dependencies);
    if (decision.status !== "needs_confirmation") return decision;
    try {
      await applyAdoption(state, options.file_operations);
    } catch (error) {
      return {
        contract: ARCHITECT_INTERACTION_SCHEMA,
        status: "execution_error",
        operation: "architect",
        error: error.code ?? "p1_migration_failed",
      };
    }
    return decision;
  }

  let adoption;
  try {
    adoption = await validAdoption(root);
  } catch {
    return {
      contract: ARCHITECT_INTERACTION_SCHEMA,
      status: "execution_error",
      operation: "architect",
      error: "invalid_p1_adoption",
    };
  }
  if (!adoption && await initializedP0Project(root, launcherVersion)) {
    const state = migrationState(root, source, { ...options, launcher_version: launcherVersion });
    return adoptionInteraction(
      "needs_confirmation",
      "blueprint_review",
      (dependencies.store_state ?? storeArchitectureState)(state),
      { kind: "p1_migration_confirmation", choices: ["confirm", "deny", "cancel"] },
    );
  }
  return runArchitectureDecisionEngine(root, source, options, dependencies);
}
