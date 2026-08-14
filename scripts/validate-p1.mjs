import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootOption = process.argv.indexOf("--root");
const root = rootOption === -1
  ? scriptRoot
  : path.resolve(process.argv[rootOption + 1] ?? "");
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

export async function validateP1() {
  const [contract, matrix, p0, packageJson, markdown] = await Promise.all([
    json("release/p1.json"),
    json("release/p1-acceptance.json"),
    json("release/p0.json"),
    json("package.json"),
    readFile(path.join(root, "docs/maintainers/p1-acceptance.md"), "utf8"),
  ]);
  if (
    contract.schema_version !== "launchrally.dev/p1-release/v1"
    || contract.phase !== "p1"
    || matrix.schema_version !== "launchrally.dev/p1-acceptance/v1"
    || !["complete", "incomplete", "suspended"].includes(contract.product_status)
    || !["experimental", "stable"].includes(contract.release_status)
    || !["published", "not_published"].includes(contract.publication_status)
    || !["not_validated", "validated"].includes(contract.validation_status)
  ) fail("p1_invalid_identity", "release/p1.json");
  if (
    p0.schema_version !== "launchrally.dev/p0-release/v1"
    || p0.phase !== "p0"
    || p0.release_status !== "stable"
    || contract.p0_stable_ref?.schema_version !== p0.schema_version
    || contract.p0_stable_ref?.release_status !== p0.release_status
  ) fail("p1_p0_independence_violation", "P0 Stable is not an independently bound input");
  if (
    matrix.product_status !== contract.product_status
    || matrix.release_status !== contract.release_status
  ) fail("p1_status_drift", "release/p1.json and release/p1-acceptance.json");
  if (
    contract.release_status === "stable"
    && (
      contract.product_status !== "complete"
      || contract.publication_status !== "published"
      || contract.validation_status !== "validated"
      || contract.quality_floor_status !== "satisfied"
      || contract.stable_promotion?.status !== "approved"
      || typeof contract.stable_promotion.approved_tag !== "string"
    )
  ) fail("p1_stable_promotion_blocked", "P1 has no separate approved Stable promotion");

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
  for (const id of contract.mandatory_release_gate_ids ?? []) {
    if (!gates.has(id)) fail("p1_missing_gate", id);
  }
  for (const requirement of requirements.values()) {
    for (const gate of requirement.gates) {
      if (!gates.has(gate)) fail("p1_unmapped_gate", `${requirement.id}: ${gate}`);
    }
  }

  const suspended = new Set();
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
        if (typeof regression.reviewed_fix !== "string" || regression.restoration !== null) {
          fail("p1_invalid_regression", regression.regression_id);
        }
        active = true;
      } else if (
        typeof regression.reviewed_fix !== "string"
        || typeof regression.restoration !== "string"
      ) fail("p1_invalid_regression", regression.regression_id);
      if (regression.status !== "restored") {
        for (const scope of regression.affected_authority_scopes) suspended.add(scope);
      }
    }
    if (condition.status !== (active ? "suspended" : "satisfied")) {
      fail("p1_quality_floor_status_drift", condition.id);
    }
  }
  const qualityFloorStatus = suspended.size === 0 ? "satisfied" : "suspended";
  if (
    suspended.size === 0
    && contract.quality_floor_status !== "satisfied"
  ) fail("p1_quality_floor_status_drift", "release/p1.json");

  const statuses = { complete: 0, open: 0, total: requirements.size };
  for (const requirement of requirements.values()) statuses[requirement.status] += 1;
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
