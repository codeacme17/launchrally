import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertAppendOnlyLog,
  isRepositoryRelativePath,
  walkValidationValue,
} from "./validation-log-shared.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const PERMITTED_SOURCES = new Set([
  "clean_environment_checks",
  "opt_in_maintainer_summary",
  "public_aggregate_package_trends",
  "voluntary_github_feedback",
]);
const TAXONOMY = Object.freeze({
  interfaces: new Set(["cli_human_mode"]),
  repositoryShapes: new Set(["typescript_pnpm_web_monorepo"]),
  environments: new Set(["staging_verification"]),
  journeyScopes: new Set(["p0_p1_end_to_end"]),
  journeyOutcomes: new Set(["completed_with_documented_workarounds"]),
  comprehensionSignals: new Set([
    "assurance",
    "capability_obligations",
    "integration_contracts",
    "manual_handoff_boundaries",
    "permission_boundaries",
    "product_intent_confirmation",
    "unknowns",
  ]),
  defectPatterns: new Set([
    "human_mode_presentation_gap",
    "intent_candidate_precision",
    "integration_contract_vocabulary_mismatch",
    "launchrally_history_self_invalidation",
    "local_history_input_inconsistency",
    "permission_collector_disclosure",
  ]),
  resolutionStates: new Set(["fixed", "open"]),
  productDecisions: new Set([
    "continue_collecting",
    "keep_p1_not_validated",
    "keep_stable_promotion_unapproved",
  ]),
  qualityFloorEvents: new Set(["authority_restored", "fix_verified", "regression_opened"]),
  lifecycle: Object.freeze({
    product_status: new Set(["complete", "incomplete", "suspended"]),
    publication_status: new Set(["not_published", "published"]),
    telemetry_free_validation: new Set(["collecting", "complete"]),
    validation_status: new Set(["not_validated", "validated"]),
    release_status: new Set(["experimental", "stable"]),
    stable_promotion_status: new Set(["not_approved", "approved"]),
  }),
});

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function assertExactKeys(value, keys, owner) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
  ) fail("p1_validation_entry_incomplete", owner);
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail("p1_validation_unknown_field", `${owner}.${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail("p1_validation_entry_incomplete", `${owner}.${key}`);
  }
}

function assertTaxonomyValue(value, permitted, owner) {
  if (typeof value !== "string" || !permitted.has(value)) {
    fail("p1_validation_taxonomy_forbidden", `${owner}: ${String(value)}`);
  }
}

function assertTaxonomyArray(values, permitted, owner) {
  if (!Array.isArray(values) || new Set(values).size !== values.length) {
    fail("p1_validation_entry_incomplete", owner);
  }
  for (const value of values) assertTaxonomyValue(value, permitted, owner);
}

function isCalendarDate(value) {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function assertReviewedShape(log) {
  assertExactKeys(log, ["collection_mode", "entries", "schema_version", "updated_at"], "log");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(log.updated_at) || !isCalendarDate(log.updated_at)) {
    fail("p1_validation_entry_incomplete", "log.updated_at");
  }
  let previousPeriod = null;
  for (const [index, entry] of log.entries.entries()) {
    const owner = `entries.${index}`;
    assertExactKeys(entry, [
      "comprehension_signals",
      "defect_patterns",
      "journey",
      "lifecycle",
      "period",
      "product_decisions",
      "quality_floor",
      "release_version",
      "represented_contexts",
      "sources",
    ], owner);
    const periodMatch = /^(\d{4}-\d{2}-\d{2})-\d{2}$/u.exec(entry.period);
    if (
      !periodMatch
      || !isCalendarDate(periodMatch[1])
      || !/^\d+\.\d+\.\d+$/u.test(entry.release_version)
    ) fail("p1_validation_entry_incomplete", owner);
    if (previousPeriod !== null && entry.period <= previousPeriod) {
      fail("p1_validation_entry_order_invalid", owner);
    }
    previousPeriod = entry.period;
    assertTaxonomyArray(entry.sources, PERMITTED_SOURCES, `${owner}.sources`);
    assertExactKeys(
      entry.represented_contexts,
      ["environments", "interfaces", "repository_shapes"],
      `${owner}.represented_contexts`,
    );
    assertTaxonomyArray(
      entry.represented_contexts.interfaces,
      TAXONOMY.interfaces,
      `${owner}.represented_contexts.interfaces`,
    );
    assertTaxonomyArray(
      entry.represented_contexts.repository_shapes,
      TAXONOMY.repositoryShapes,
      `${owner}.represented_contexts.repository_shapes`,
    );
    assertTaxonomyArray(
      entry.represented_contexts.environments,
      TAXONOMY.environments,
      `${owner}.represented_contexts.environments`,
    );
    assertExactKeys(entry.journey, ["outcome", "scope"], `${owner}.journey`);
    assertTaxonomyValue(entry.journey.scope, TAXONOMY.journeyScopes, `${owner}.journey.scope`);
    assertTaxonomyValue(
      entry.journey.outcome,
      TAXONOMY.journeyOutcomes,
      `${owner}.journey.outcome`,
    );
    assertTaxonomyArray(
      entry.comprehension_signals,
      TAXONOMY.comprehensionSignals,
      `${owner}.comprehension_signals`,
    );
    if (!Array.isArray(entry.defect_patterns)) {
      fail("p1_validation_entry_incomplete", `${owner}.defect_patterns`);
    }
    for (const [patternIndex, pattern] of entry.defect_patterns.entries()) {
      const patternOwner = `${owner}.defect_patterns.${patternIndex}`;
      assertExactKeys(pattern, ["issue_ids", "pattern", "resolution_state"], patternOwner);
      assertTaxonomyValue(pattern.pattern, TAXONOMY.defectPatterns, `${patternOwner}.pattern`);
      assertTaxonomyValue(
        pattern.resolution_state,
        TAXONOMY.resolutionStates,
        `${patternOwner}.resolution_state`,
      );
      if (
        !Array.isArray(pattern.issue_ids)
        || pattern.issue_ids.length === 0
        || new Set(pattern.issue_ids).size !== pattern.issue_ids.length
        || pattern.issue_ids.some((issueId) => !/^#[1-9]\d*$/u.test(issueId))
      ) fail("p1_validation_entry_incomplete", `${patternOwner}.issue_ids`);
    }
    assertTaxonomyArray(
      entry.product_decisions,
      TAXONOMY.productDecisions,
      `${owner}.product_decisions`,
    );
    assertExactKeys(
      entry.quality_floor,
      ["events", "status", "suspended_authority_scopes"],
      `${owner}.quality_floor`,
    );
    if (
      !["satisfied", "suspended"].includes(entry.quality_floor.status)
      || !Array.isArray(entry.quality_floor.events)
      || !Array.isArray(entry.quality_floor.suspended_authority_scopes)
    ) fail("p1_validation_entry_incomplete", `${owner}.quality_floor`);
    for (const [eventIndex, event] of entry.quality_floor.events.entries()) {
      const eventOwner = `${owner}.quality_floor.events.${eventIndex}`;
      assertExactKeys(event, [
        "affected_authority_scopes",
        "condition_id",
        "event",
        "regression_id",
      ], eventOwner);
      if (
        !/^P1-REG-\d{4}$/u.test(event.regression_id)
        || !/^P1-QF-(?:0[1-9]|1[0-4])$/u.test(event.condition_id)
        || !Array.isArray(event.affected_authority_scopes)
        || event.affected_authority_scopes.length === 0
      ) fail("p1_validation_entry_incomplete", eventOwner);
      assertTaxonomyValue(event.event, TAXONOMY.qualityFloorEvents, `${eventOwner}.event`);
    }
    assertExactKeys(entry.lifecycle, [
      "product_status",
      "publication_status",
      "release_status",
      "stable_promotion_status",
      "telemetry_free_validation",
      "validation_status",
    ], `${owner}.lifecycle`);
    for (const [field, permitted] of Object.entries(TAXONOMY.lifecycle)) {
      assertTaxonomyValue(
        entry.lifecycle[field],
        permitted,
        `${owner}.lifecycle.${field}`,
      );
    }
  }
  if (log.updated_at !== log.entries.at(-1)?.period.slice(0, 10)) {
    fail("p1_validation_entry_order_invalid", "log.updated_at");
  }
}

function assertNonIdentifying(value) {
  walkValidationValue(value, {
    string(nested) {
      if (
        /(?:https?:\/\/|ssh:\/\/|git@|\bgithub\.com\/)/iu.test(nested)
        || /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/u.test(nested)
        || /(?<![A-Za-z0-9._~/])(?:~\/|\/(?!\/))[^\s,;)\]}"'`>]+/u.test(nested)
        || /(?<![A-Za-z0-9._~/])[A-Za-z]:[\\/][^\s,;)\]}"'`>]+/u.test(nested)
        || /(?<![A-Za-z0-9._~/])\\\\[^\\\s]+\\[^\s,;)\]}"'`>]+/u.test(nested)
        || /(?:\bBearer\s+[A-Za-z0-9._~-]+|\b(?:ghp|github_pat|sk)-[A-Za-z0-9_-]+|\bAKIA[A-Z0-9]{16}\b)/u.test(nested)
      ) fail("p1_validation_identifying_data_forbidden", "prohibited value");
    },
  });
}

function assertNoValidationQuota(value) {
  walkValidationValue(value, {
    key(key) {
      if (
        /(?:quota|threshold|adoption_(?:count|target)|download_(?:count|target)|elapsed_(?:days|time)|minimum_(?:downloads|installs|users|repositories|days))/u.test(key)
      ) fail("p1_validation_quota_forbidden", key);
    },
    string(nested) {
      if (
        /\b(?:at\s+least|minimum(?:\s+of)?|after|once)\s+\d[\d,]*\s+(?:downloads?|installs?|users?|repositories?|days?|weeks?|months?)\b/iu.test(nested)
        || /\b(?:downloads?|installs?|users?|repositories?)\s+(?:reach|reaches|exceed|exceeds)\s+\d[\d,]*\b/iu.test(nested)
      ) fail("p1_validation_quota_forbidden", "numeric validation threshold");
    },
  });
}

async function readJson(root, relativePath) {
  try {
    return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
  } catch (error) {
    fail("p1_validation_invalid_json", `${relativePath}: ${error.message}`);
  }
}

function deriveQualityFloor(matrix) {
  const suspended = new Set();
  for (const condition of matrix.quality_floor ?? []) {
    for (const regression of condition.regressions ?? []) {
      if (regression.status === "restored") continue;
      for (const scope of regression.affected_authority_scopes ?? []) suspended.add(scope);
    }
  }
  return {
    status: suspended.size === 0 ? "satisfied" : "suspended",
    suspendedAuthorities: [...suspended].sort(),
  };
}

function assertQualityFloorHistory(log, matrix, registry) {
  if (
    registry?.schema_version !== "launchrally.dev/p1-regression-registry/v1"
    || !Array.isArray(registry.assignments)
  ) fail("p1_validation_quality_floor_invalid", "regression registry");
  const assignments = new Map(registry.assignments.map((assignment) => [
    assignment.regression_id,
    assignment,
  ]));
  const matrixRegressions = new Map();
  for (const condition of matrix.quality_floor ?? []) {
    for (const regression of condition.regressions ?? []) {
      matrixRegressions.set(regression.regression_id, { condition, regression });
    }
  }
  const states = new Map();
  for (const [entryIndex, entry] of log.entries.entries()) {
    for (const event of entry.quality_floor.events) {
      const assignment = assignments.get(event.regression_id);
      const matrixRecord = matrixRegressions.get(event.regression_id);
      if (
        assignment?.condition_id !== event.condition_id
        || JSON.stringify(assignment?.authority_scopes)
          !== JSON.stringify(event.affected_authority_scopes)
        || matrixRecord?.condition.id !== event.condition_id
        || JSON.stringify(matrixRecord?.regression.affected_authority_scopes)
          !== JSON.stringify(event.affected_authority_scopes)
      ) fail("p1_validation_quality_floor_invalid", event.regression_id);
      const current = states.get(event.regression_id);
      if (event.event === "regression_opened") {
        if (current) fail("p1_validation_quality_floor_invalid", `reused ${event.regression_id}`);
        states.set(event.regression_id, { status: "open", entryIndex, event });
      } else if (event.event === "fix_verified") {
        if (current?.status !== "open" || current.entryIndex >= entryIndex) {
          fail("p1_validation_fix_missing", event.regression_id);
        }
        states.set(event.regression_id, { status: "fixed", entryIndex, event });
      } else {
        if (current?.status !== "fixed" || current.entryIndex >= entryIndex) {
          fail("p1_validation_restoration_blocked", event.regression_id);
        }
        states.set(event.regression_id, { status: "restored", entryIndex, event });
      }
    }
    const suspended = new Set();
    for (const state of states.values()) {
      if (state.status === "restored") continue;
      for (const scope of state.event.affected_authority_scopes) suspended.add(scope);
    }
    const suspendedAuthorities = [...suspended].sort();
    const expectedStatus = suspendedAuthorities.length === 0 ? "satisfied" : "suspended";
    if (
      entry.quality_floor.status !== expectedStatus
      || JSON.stringify(entry.quality_floor.suspended_authority_scopes)
        !== JSON.stringify(suspendedAuthorities)
    ) fail("p1_validation_quality_floor_drift", `entry ${entryIndex}`);
  }
  for (const [regressionId, { regression }] of matrixRegressions) {
    if (states.get(regressionId)?.status !== regression.status) {
      fail("p1_validation_quality_floor_drift", regressionId);
    }
  }
  for (const regressionId of states.keys()) {
    if (!matrixRegressions.has(regressionId)) {
      fail("p1_validation_quality_floor_invalid", regressionId);
    }
  }
}

function assertAppendOnly(current, baseline) {
  assertAppendOnlyLog(current, baseline, (detail) => {
    fail("p1_validation_history_changed", detail);
  });
}

async function baselineValidationLog(root, baselineRef) {
  if (
    !baselineRef
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(baselineRef)
    || baselineRef.includes("..")
  ) fail("p1_validation_baseline_missing", "--baseline-ref");
  try {
    await execFileAsync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], {
      cwd: root,
    });
    const { stdout: contractContent } = await execFileAsync(
      "git",
      ["show", `${baselineRef}:release/p1.json`],
      { cwd: root, encoding: "utf8" },
    );
    const baselineContract = JSON.parse(contractContent);
    if (baselineContract.validation_log === undefined) return null;
    const relativePath = baselineContract.validation_log;
    if (!isRepositoryRelativePath(relativePath)) throw new Error("invalid baseline log path");
    const { stdout: logContent } = await execFileAsync(
      "git",
      ["show", `${baselineRef}:${relativePath}`],
      { cwd: root, encoding: "utf8" },
    );
    return JSON.parse(logContent);
  } catch {
    fail("p1_validation_baseline_missing", baselineRef);
  }
}

export async function validateP1ValidationLog({
  root,
  baselineLog = null,
  baselineRef = null,
} = {}) {
  const reviewedLog = baselineRef === null
    ? baselineLog
    : await baselineValidationLog(root, baselineRef);
  const contract = await readJson(root, "release/p1.json");
  const matrix = await readJson(root, "release/p1-acceptance.json");
  const registry = await readJson(root, "release/p1-regression-registry.json");
  const p0 = await readJson(root, "release/p0.json");
  const logPath = contract.validation_log ?? "docs/maintainers/phase-1-validation-log.json";
  if (!isRepositoryRelativePath(logPath)) {
    fail("p1_validation_log_path_invalid", String(logPath));
  }
  const log = await readJson(root, logPath);
  if (
    contract.validation_mode !== "telemetry_free"
    || !TAXONOMY.lifecycle.product_status.has(contract.product_status)
    || !TAXONOMY.lifecycle.publication_status.has(contract.publication_status)
    || !TAXONOMY.lifecycle.telemetry_free_validation.has(contract.validation_collection_status)
    || contract.validation_log !== logPath
    || !TAXONOMY.lifecycle.validation_status.has(contract.validation_status)
    || !TAXONOMY.lifecycle.release_status.has(contract.release_status)
    || !TAXONOMY.lifecycle.stable_promotion_status.has(contract.stable_promotion?.status)
  ) fail("p1_validation_release_contract_invalid", "release/p1.json");
  if (
    log.schema_version !== "launchrally.dev/phase-1-validation-log/v1"
    || log.collection_mode !== "telemetry_free"
    || !Array.isArray(log.entries)
    || log.entries.length === 0
  ) fail("p1_validation_log_incomplete", logPath);
  if (reviewedLog) {
    assertAppendOnly(log, reviewedLog);
  }
  assertNonIdentifying(log);
  assertNoValidationQuota(log);
  assertReviewedShape(log);
  assertQualityFloorHistory(log, matrix, registry);
  if (p0.release_status !== "stable") {
    fail("p1_validation_p0_independence_violation", "P0 Stable changed");
  }
  const latest = log.entries.at(-1);
  const qualityFloor = deriveQualityFloor(matrix);
  const expectedLifecycle = {
    product_status: contract.product_status,
    publication_status: contract.publication_status,
    telemetry_free_validation: contract.validation_collection_status,
    validation_status: contract.validation_status,
    release_status: contract.release_status,
    stable_promotion_status: contract.stable_promotion?.status,
  };
  if (JSON.stringify(latest.lifecycle) !== JSON.stringify(expectedLifecycle)) {
    fail("p1_validation_state_drift", "latest lifecycle does not match release/p1.json");
  }
  if (
    latest.quality_floor?.status !== qualityFloor.status
    || JSON.stringify(latest.quality_floor?.suspended_authority_scopes)
      !== JSON.stringify(qualityFloor.suspendedAuthorities)
  ) fail("p1_validation_quality_floor_drift", "latest Quality Floor snapshot");
  if (
    (latest.lifecycle.telemetry_free_validation === "collecting"
      && latest.lifecycle.validation_status !== "not_validated")
    || (latest.lifecycle.validation_status !== "validated"
      && latest.lifecycle.stable_promotion_status !== "not_approved")
    || (latest.lifecycle.release_status === "stable"
      && (
        latest.lifecycle.validation_status !== "validated"
        || latest.lifecycle.stable_promotion_status !== "approved"
      ))
  ) {
    fail(
      "p1_validation_advancement_blocked",
      "collection, validation, publication, and Stable promotion remain independent",
    );
  }

  return {
    status: "completed",
    schema_version: log.schema_version,
    collection_mode: log.collection_mode,
    telemetry_free_validation: latest.lifecycle.telemetry_free_validation,
    validation_status: latest.lifecycle.validation_status,
    release_status: latest.lifecycle.release_status,
    stable_promotion_status: latest.lifecycle.stable_promotion_status,
    quality_floor_status: qualityFloor.status,
    suspended_authorities: qualityFloor.suspendedAuthorities,
    p0_release_status: p0.release_status,
    entries: log.entries.length,
  };
}

async function main() {
  const rootOption = process.argv.indexOf("--root");
  const root = rootOption === -1
    ? scriptRoot
    : path.resolve(process.argv[rootOption + 1] ?? "");
  const baselineLogOption = process.argv.indexOf("--baseline-log");
  const baselineRefOption = process.argv.indexOf("--baseline-ref");
  let baselineLog = null;
  if (baselineLogOption !== -1) {
    const relativePath = process.argv[baselineLogOption + 1];
    if (!isRepositoryRelativePath(relativePath)) {
      fail("p1_validation_baseline_missing", "--baseline-log");
    }
    baselineLog = await readJson(root, relativePath);
  }
  const baselineRef = baselineRefOption === -1 ? null : process.argv[baselineRefOption + 1];
  const result = await validateP1ValidationLog({ root, baselineLog, baselineRef });
  process.stdout.write(
    process.argv.includes("--json")
      ? `${JSON.stringify(result)}\n`
      : "Phase 1 Validation Log contract is complete.\n",
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
