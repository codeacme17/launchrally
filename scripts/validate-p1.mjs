import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootOption = process.argv.indexOf("--root");
const root = rootOption === -1
  ? scriptRoot
  : path.resolve(process.argv[rootOption + 1] ?? "");
const baselineRefOption = process.argv.indexOf("--baseline-ref");
const baselineRef = baselineRefOption === -1 ? null : process.argv[baselineRefOption + 1];
const execFileAsync = promisify(execFile);
const AUTHORITY_SCOPES = new Set([
  "active_verification",
  "architecture_recommendation",
  "composite_assurance",
  "external_handoff",
  "intent_declaration",
  "machine_evidence",
  "p1_persistence",
  "provider_recommendation",
  "reference_coverage",
]);
const MANDATORY_P1_GATES = Object.freeze([
  "p1_traceability",
  "p1_quality_floor",
  "p1_supply_chain",
  "p1_exact_artifacts",
  "p1_external_verification",
]);

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

async function json(relativePath) {
  try {
    return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
  } catch (error) {
    fail("p1_invalid_json", `${relativePath}: ${error.message}`);
  }
}

async function assertFile(relativePath, owner) {
  if (
    typeof relativePath !== "string"
    || relativePath.length === 0
    || path.isAbsolute(relativePath)
    || relativePath.split(/[\\/]/u).includes("..")
  ) fail("p1_invalid_path", `${owner}: ${relativePath}`);
  try {
    if (!(await stat(path.join(root, relativePath))).isFile()) throw new Error("not a file");
  } catch {
    fail("p1_stale_path", `${owner}: ${relativePath}`);
  }
}

async function assertTest(record, owner) {
  await assertFile(record.path, owner);
  const source = await readFile(path.join(root, record.path), "utf8");
  if (!source.includes(`test(${JSON.stringify(record.name)}`)) {
    fail("p1_stale_test", `${owner}: ${record.path}: ${record.name}`);
  }
}

function documentedRequirements(markdown) {
  const entries = new Map();
  for (const line of markdown.split("\n")) {
    const match = line.match(
      /^\| (P1-[A-Z0-9-]+) \| (.+) \| (.+) \| (#\d+) \| (Complete|Open) \|$/u,
    );
    if (!match) continue;
    const [, id, requirement, , tracking, status] = match;
    if (entries.has(id)) fail("p1_duplicate_requirement", id);
    entries.set(id, { requirement, tracking, status: status.toLowerCase() });
  }
  return entries;
}

function expandedScript(scripts, name, visiting = new Set()) {
  const command = scripts?.[name];
  if (typeof command !== "string" || visiting.has(name)) return command ?? "";
  const nested = [...command.matchAll(/\bnpm run ([a-z0-9:_-]+)/giu)]
    .map(([, child]) => expandedScript(scripts, child, new Set(visiting).add(name)));
  return [command, ...nested].join("\n");
}

function isMidnightIsoTimestamp(value) {
  const timestamp = Date.parse(value);
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u.test(value)
    && Number.isFinite(timestamp)
    && new Date(timestamp).toISOString() === value;
}

function isNonEmptyRecord(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assertRegressionRegistry(registry) {
  if (
    registry?.schema_version !== "launchrally.dev/p1-regression-registry/v1"
    || !Array.isArray(registry.assignments)
  ) fail("p1_invalid_regression_registry", "release/p1-regression-registry.json");
  const ids = new Set();
  for (const assignment of registry.assignments) {
    if (
      !/^P1-REG-[0-9]{4}$/u.test(assignment?.regression_id ?? "")
      || ids.has(assignment.regression_id)
      || !/^P1-QF-(?:0[1-9]|1[0-4])$/u.test(assignment.condition_id ?? "")
      || !Array.isArray(assignment.authority_scopes)
      || assignment.authority_scopes.length === 0
      || assignment.authority_scopes.some((scope) => !AUTHORITY_SCOPES.has(scope))
    ) fail("p1_invalid_regression_registry", assignment?.regression_id ?? "missing");
    ids.add(assignment.regression_id);
  }
}

async function baselineRegressionRegistry() {
  if (baselineRef === null) return null;
  if (!isNonEmptyRecord(baselineRef)) fail("p1_invalid_baseline_ref", "missing ref");
  try {
    await execFileAsync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { cwd: root });
  } catch {
    fail("p1_invalid_baseline_ref", baselineRef);
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["show", `${baselineRef}:release/p1-regression-registry.json`],
      { cwd: root },
    );
    return JSON.parse(stdout);
  } catch (error) {
    if (/does not exist|exists on disk, but not in/iu.test(error.stderr ?? "")) {
      return {
        schema_version: "launchrally.dev/p1-regression-registry/v1",
        assignments: [],
      };
    }
    fail("p1_invalid_regression_registry", `baseline ${baselineRef}`);
  }
}

export async function validateP1() {
  const [contract, matrix, regressionRegistry, p0, packageJson, markdown, baselineRegistry] = await Promise.all([
    json("release/p1.json"),
    json("release/p1-acceptance.json"),
    json("release/p1-regression-registry.json"),
    json("release/p0.json"),
    json("package.json"),
    readFile(path.join(root, "docs/maintainers/p1-acceptance.md"), "utf8"),
    baselineRegressionRegistry(),
  ]);
  assertRegressionRegistry(regressionRegistry);
  if (baselineRegistry !== null) {
    assertRegressionRegistry(baselineRegistry);
    if (regressionRegistry.assignments.length < baselineRegistry.assignments.length) {
      fail("p1_regression_history_changed", "reviewed assignments were deleted");
    }
    for (const [index, assignment] of baselineRegistry.assignments.entries()) {
      if (JSON.stringify(regressionRegistry.assignments[index]) !== JSON.stringify(assignment)) {
        fail("p1_regression_history_changed", `assignment ${index} changed`);
      }
    }
  }
  if (
    contract.schema_version !== "launchrally.dev/p1-release/v1"
    || contract.phase !== "p1"
    || matrix.schema_version !== "launchrally.dev/p1-acceptance/v1"
    || !["complete", "incomplete", "suspended"].includes(contract.product_status)
    || !["experimental", "stable"].includes(contract.release_status)
    || !["published", "not_published"].includes(contract.publication_status)
    || !["not_validated", "validated"].includes(contract.validation_status)
    || !isMidnightIsoTimestamp(contract.supply_chain_assessment_at)
  ) fail("p1_invalid_identity", "release/p1.json");
  if (
    p0.schema_version !== "launchrally.dev/p0-release/v1"
    || p0.phase !== "p0"
    || p0.release_status !== "stable"
    || contract.p0_stable_ref?.schema_version !== p0.schema_version
    || contract.p0_stable_ref?.release_status !== p0.release_status
  ) fail("p1_p0_independence_violation", "P0 Stable is not an independently bound input");
  if (
    JSON.stringify(contract.mandatory_release_gate_ids)
      !== JSON.stringify(MANDATORY_P1_GATES)
  ) fail("p1_invalid_canonical_gates", "release/p1.json");
  if (
    matrix.product_status !== contract.product_status
    || matrix.release_status !== contract.release_status
  ) fail("p1_status_drift", "release/p1.json and release/p1-acceptance.json");
  const canonical = contract.acceptance_requirement_ids;
  if (!Array.isArray(canonical) || new Set(canonical).size !== canonical.length) {
    fail("p1_invalid_canonical_ids", "release/p1.json");
  }
  const docs = documentedRequirements(markdown);
  const requirements = new Map();
  for (const requirement of matrix.requirements ?? []) {
    if (!/^P1-[A-Z0-9-]+$/u.test(requirement.id ?? "") || requirements.has(requirement.id)) {
      fail("p1_duplicate_requirement", requirement.id ?? "missing");
    }
    if (!["complete", "open"].includes(requirement.status)) {
      fail("p1_invalid_status", `${requirement.id}: ${requirement.status}`);
    }
    if (!/^#[0-9]+$/u.test(requirement.tracking ?? "")) {
      fail("p1_invalid_tracking", `${requirement.id}: ${requirement.tracking}`);
    }
    const documented = docs.get(requirement.id);
    if (!documented) fail("p1_unmapped_entry", requirement.id);
    if (
      documented.requirement !== requirement.requirement
      || documented.tracking !== requirement.tracking
      || documented.status !== requirement.status
    ) fail("p1_stale_entry", requirement.id);
    for (const field of ["contracts", "implementation", "tests", "gates"]) {
      if (!Array.isArray(requirement[field]) || requirement[field].length === 0) {
        fail("p1_unmapped_entry", `${requirement.id}: ${field}`);
      }
    }
    for (const file of [...requirement.contracts, ...requirement.implementation]) {
      await assertFile(file, requirement.id);
    }
    for (const record of requirement.tests) await assertTest(record, requirement.id);
    requirements.set(requirement.id, requirement);
  }
  for (const id of canonical) {
    if (!requirements.has(id)) fail("p1_unmapped_requirement", id);
  }
  for (const id of requirements.keys()) {
    if (!canonical.includes(id)) fail("p1_stale_entry", id);
  }
  for (const id of docs.keys()) {
    if (!requirements.has(id)) fail("p1_unmapped_requirement", id);
  }

  const gates = new Map();
  for (const gate of matrix.release_gates ?? []) {
    if (!/^[a-z][a-z0-9_]*$/u.test(gate.id ?? "") || gates.has(gate.id)) {
      fail("p1_duplicate_gate", gate.id ?? "missing");
    }
    if (gate.mandatory !== true || !["complete", "pending"].includes(gate.status)) {
      fail("p1_invalid_gate", gate.id);
    }
    const command = expandedScript(packageJson.scripts, gate.command);
    if (!command) fail("p1_stale_command", gate.command);
    if (gate.evidence?.type === "test") {
      await assertTest(gate.evidence, gate.id);
      if (!command.includes(gate.evidence.path)) fail("p1_ungated_evidence", gate.id);
    } else if (gate.evidence?.type === "script") {
      await assertFile(gate.evidence.path, gate.id);
      if (!command.includes(gate.evidence.path)) fail("p1_ungated_evidence", gate.id);
    } else fail("p1_invalid_gate", gate.id);
    gates.set(gate.id, gate);
  }
  for (const id of contract.mandatory_release_gate_ids) {
    if (!gates.has(id)) fail("p1_missing_gate", id);
  }
  for (const requirement of requirements.values()) {
    for (const gate of requirement.gates) {
      if (!gates.has(gate)) fail("p1_unmapped_gate", `${requirement.id}: ${gate}`);
    }
  }

  const suspended = new Set();
  const regressionIds = new Set();
  const registryAssignments = new Map(regressionRegistry.assignments.map((assignment) => [
    assignment.regression_id,
    assignment,
  ]));
  const conditions = matrix.quality_floor ?? [];
  if (
    conditions.length !== 14
    || conditions.some(({ id }, index) => id !== `P1-QF-${String(index + 1).padStart(2, "0")}`)
  ) fail("p1_invalid_quality_floor", "exactly 14 ordered stable conditions are required");
  for (const condition of conditions) {
    if (
      !Array.isArray(condition.authority_scopes)
      || condition.authority_scopes.length === 0
      || condition.authority_scopes.some((scope) => !AUTHORITY_SCOPES.has(scope))
      || !Array.isArray(condition.regressions)
    ) fail("p1_invalid_quality_floor", condition.id);
    let active = false;
    for (const regression of condition.regressions) {
      if (regressionIds.has(regression.regression_id)) {
        fail("p1_duplicate_regression", regression.regression_id);
      }
      regressionIds.add(regression.regression_id);
      const assignment = registryAssignments.get(regression.regression_id);
      if (
        assignment?.condition_id !== condition.id
        || JSON.stringify(assignment.authority_scopes)
          !== JSON.stringify(regression.affected_authority_scopes)
      ) fail("p1_unregistered_regression", regression.regression_id);
      if (
        !/^P1-REG-[0-9]{4}$/u.test(regression.regression_id ?? "")
        || !["open", "fixed", "restored"].includes(regression.status)
        || !Array.isArray(regression.affected_authority_scopes)
        || regression.affected_authority_scopes.length === 0
        || regression.affected_authority_scopes.some(
          (scope) => !condition.authority_scopes.includes(scope),
        )
      ) fail("p1_invalid_regression", condition.id);
      if (regression.status === "open") {
        if (regression.reviewed_fix !== null || regression.restoration !== null) {
          fail("p1_invalid_regression", regression.regression_id);
        }
        active = true;
      } else if (regression.status === "fixed") {
        if (!isNonEmptyRecord(regression.reviewed_fix) || regression.restoration !== null) {
          fail("p1_invalid_regression", regression.regression_id);
        }
        active = true;
      } else if (
        !isNonEmptyRecord(regression.reviewed_fix)
        || !isNonEmptyRecord(regression.restoration)
      ) fail("p1_invalid_regression", regression.regression_id);
      if (regression.status !== "restored") {
        for (const scope of regression.affected_authority_scopes) suspended.add(scope);
      }
    }
    if (condition.status !== (active ? "suspended" : "satisfied")) {
      fail("p1_quality_floor_status_drift", condition.id);
    }
  }
  for (const regressionId of registryAssignments.keys()) {
    if (!regressionIds.has(regressionId)) {
      fail("p1_regression_history_changed", `${regressionId} is missing from the Quality Floor`);
    }
  }
  const qualityFloorStatus = suspended.size === 0 ? "satisfied" : "suspended";
  if (contract.quality_floor_status !== qualityFloorStatus) {
    fail(
      "p1_quality_floor_status_drift",
      `release/p1.json declares ${contract.quality_floor_status}; derived ${qualityFloorStatus}`,
    );
  }

  const statuses = { complete: 0, open: 0, total: requirements.size };
  for (const requirement of requirements.values()) statuses[requirement.status] += 1;
  const openRequirements = [...requirements.values()]
    .filter(({ status }) => status !== "complete")
    .map(({ id }) => id);
  const pendingGates = [...gates.values()]
    .filter(({ status }) => status !== "complete")
    .map(({ id }) => id);
  const completionBlockers = [
    openRequirements.length > 0 ? `open requirements: ${openRequirements.join(", ")}` : null,
    pendingGates.length > 0 ? `pending gates: ${pendingGates.join(", ")}` : null,
    qualityFloorStatus !== "satisfied" ? "Quality Floor is suspended" : null,
  ].filter(Boolean);
  if (
    contract.product_status === "complete"
    && contract.release_status !== "stable"
    && completionBlockers.length > 0
  ) {
    fail("p1_product_completion_blocked", completionBlockers.join("; "));
  }
  if (contract.release_status === "stable") {
    const expectedTag = `v${packageJson.version}`;
    const tagGatePassed = contract.stable_promotion?.approved_tag === expectedTag;
    const scalarGatePassed = contract.product_status === "complete"
      && contract.publication_status === "published"
      && contract.validation_status === "validated"
      && qualityFloorStatus === "satisfied"
      && contract.stable_promotion?.status === "approved"
      && tagGatePassed;
    if (!scalarGatePassed || completionBlockers.length > 0) {
      fail(
        "p1_stable_promotion_blocked",
        [
          "P1 has no separate approved Stable promotion",
          !tagGatePassed
            ? `approved tag ${contract.stable_promotion?.approved_tag ?? "missing"}; expected ${expectedTag}`
            : null,
          ...completionBlockers,
        ].filter(Boolean).join("; "),
      );
    }
  }
  return {
    status: "completed",
    schema_version: contract.schema_version,
    product_status: contract.product_status,
    release_status: contract.release_status,
    quality_floor_status: qualityFloorStatus,
    requirements: statuses,
    release_gates: gates.size,
    suspended_authorities: [...suspended].sort(),
    p0_release_status: p0.release_status,
  };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const result = await validateP1();
    process.stdout.write(
      process.argv.includes("--json")
        ? `${JSON.stringify(result)}\n`
        : `Validated ${result.requirements.total} P1 requirements and ${result.release_gates} mandatory gates.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
