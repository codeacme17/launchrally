import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootOption = process.argv.indexOf("--root");
const root = rootOption === -1
  ? scriptRoot
  : path.resolve(process.argv[rootOption + 1] ?? "");
const requiredReleaseGates = [
  "artifact_clean_install",
  "currentness",
  "false_confidence",
  "migrations",
  "native_plugins",
  "p0_release_contract",
  "permission_boundaries",
  "persistence_recovery",
  "secret_safety",
  "stable_promotion",
  "traceability",
];
const postPublicationRequirementIds = new Set([
  "P0-RELEASE-01",
  "P0-RELEASE-02",
  "P0-VALIDATE-01",
  "P0-VALIDATE-02",
]);

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

async function readJson(relativePath) {
  try {
    return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
  } catch (error) {
    fail("acceptance_invalid_json", `${relativePath}: ${error.message}`);
  }
}

async function assertFile(relativePath, owner) {
  if (
    typeof relativePath !== "string"
    || relativePath.length === 0
    || path.isAbsolute(relativePath)
    || relativePath.split(/[\\/]/u).includes("..")
  ) {
    fail("acceptance_invalid_path", `${owner}: ${relativePath}`);
  }
  try {
    if (!(await stat(path.join(root, relativePath))).isFile()) throw new Error("not a file");
  } catch {
    fail("acceptance_stale_path", `${owner}: ${relativePath}`);
  }
}

function exactKeys(value, expected, owner) {
  const actual = Object.keys(value ?? {}).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    fail("acceptance_invalid_shape", `${owner}: ${actual.join(",")}`);
  }
}

function expandedScript(scripts, name, visiting = new Set()) {
  const command = scripts?.[name];
  if (typeof command !== "string" || visiting.has(name)) return command ?? "";
  const nextVisiting = new Set(visiting).add(name);
  const nested = [...command.matchAll(/\bnpm run ([a-z0-9:_-]+)/giu)]
    .map(([, nestedName]) => expandedScript(scripts, nestedName, nextVisiting));
  return [command, ...nested].join("\n");
}

function parseDocumentedRequirements(markdown) {
  const entries = new Map();
  for (const line of markdown.split("\n")) {
    const match = line.match(
      /^\| (P0-[A-Z0-9-]+) \| (.+) \| (.+) \| (#\d+) \| (Complete|Open) \|$/u,
    );
    if (!match) continue;
    const [, id, requirement, , tracking, status] = match;
    if (entries.has(id)) fail("acceptance_duplicate_requirement", id);
    entries.set(id, { requirement, tracking, status: status.toLowerCase() });
  }
  return entries;
}

async function assertTest(test, owner) {
  exactKeys(test, ["name", "path"], owner);
  await assertFile(test.path, owner);
  const content = await readFile(path.join(root, test.path), "utf8");
  const doubleQuoted = `test(${JSON.stringify(test.name)}`;
  const singleQuoted = `test('${test.name.replaceAll("'", "\\'")}'`;
  if (!content.includes(doubleQuoted) && !content.includes(singleQuoted)) {
    fail("acceptance_stale_test", `${owner}: ${test.path}: ${test.name}`);
  }
}

async function validate() {
  const matrix = await readJson("release/p0-acceptance.json");
  exactKeys(
    matrix,
    ["product_status", "release_gates", "release_status", "requirements", "schema_version"],
    "matrix",
  );
  if (
    matrix.schema_version !== "launchrally.dev/p0-acceptance/v1"
    || !new Set(["complete", "incomplete", "suspended"]).has(matrix.product_status)
    || !new Set(["experimental", "not_published", "release_candidate", "stable"])
      .has(matrix.release_status)
    || !Array.isArray(matrix.requirements)
    || !Array.isArray(matrix.release_gates)
  ) {
    fail("acceptance_invalid_identity", "release/p0-acceptance.json");
  }

  const markdown = await readFile(path.join(root, "docs/maintainers/p0-acceptance.md"), "utf8");
  const documented = parseDocumentedRequirements(markdown);
  const requirements = new Map();
  for (const requirement of matrix.requirements) {
    exactKeys(
      requirement,
      ["contracts", "id", "implementation", "requirement", "status", "tests", "tracking"],
      requirement.id ?? "requirement",
    );
    if (!/^P0-[A-Z0-9-]+$/u.test(requirement.id ?? "") || requirements.has(requirement.id)) {
      fail("acceptance_duplicate_requirement", requirement.id ?? "missing id");
    }
    if (!["complete", "open"].includes(requirement.status)) {
      fail("acceptance_invalid_status", `${requirement.id}: ${requirement.status}`);
    }
    const source = documented.get(requirement.id);
    if (!source) fail("acceptance_unmapped_entry", requirement.id);
    if (
      source.requirement !== requirement.requirement
      || source.tracking !== requirement.tracking
      || source.status !== requirement.status
    ) {
      fail("acceptance_stale_entry", requirement.id);
    }
    for (const field of ["contracts", "implementation", "tests"]) {
      if (!Array.isArray(requirement[field]) || requirement[field].length === 0) {
        fail("acceptance_unmapped_entry", `${requirement.id}: ${field}`);
      }
    }
    for (const contract of requirement.contracts) {
      await assertFile(contract, `${requirement.id}.contracts`);
    }
    for (const implementation of requirement.implementation) {
      await assertFile(implementation, `${requirement.id}.implementation`);
    }
    for (const test of requirement.tests) await assertTest(test, `${requirement.id}.tests`);
    requirements.set(requirement.id, requirement);
  }
  for (const id of documented.keys()) {
    if (!requirements.has(id)) fail("acceptance_unmapped_requirement", id);
  }
  const p0 = await readJson("release/p0.json");
  if (
    matrix.product_status !== p0.product_status
    || matrix.release_status !== p0.release_status
  ) {
    fail("acceptance_status_drift", "release/p0-acceptance.json and release/p0.json");
  }
  if (!Array.isArray(p0.acceptance_requirement_ids)) {
    fail("acceptance_invalid_canonical_ids", "release/p0.json");
  }
  const canonicalIds = new Set(p0.acceptance_requirement_ids);
  if (canonicalIds.size !== p0.acceptance_requirement_ids.length) {
    fail("acceptance_invalid_canonical_ids", "duplicate requirement ID");
  }
  for (const id of canonicalIds) {
    if (!requirements.has(id)) fail("acceptance_unmapped_requirement", id);
  }
  for (const id of requirements.keys()) {
    if (!canonicalIds.has(id)) fail("acceptance_stale_entry", id);
  }

  const packageJson = await readJson("package.json");
  const gateIds = new Set();
  for (const gate of matrix.release_gates) {
    exactKeys(gate, ["command", "evidence", "id", "requirement_ids"], gate.id ?? "gate");
    if (!/^[a-z][a-z0-9_]*$/u.test(gate.id ?? "") || gateIds.has(gate.id)) {
      fail("acceptance_duplicate_gate", gate.id ?? "missing id");
    }
    if (!packageJson.scripts?.[gate.command]) {
      fail("acceptance_stale_command", `${gate.id}: npm run ${gate.command}`);
    }
    if (!Array.isArray(gate.requirement_ids) || gate.requirement_ids.length === 0) {
      fail("acceptance_unmapped_gate", gate.id);
    }
    for (const id of gate.requirement_ids) {
      if (!requirements.has(id)) fail("acceptance_unmapped_gate", `${gate.id}: ${id}`);
    }
    const gateCommand = expandedScript(packageJson.scripts, gate.command);
    if (gate.evidence?.type === "test") {
      await assertTest(
        { path: gate.evidence.path, name: gate.evidence.name },
        `${gate.id}.evidence`,
      );
      if (!gateCommand.includes(gate.evidence.path)) {
        fail("acceptance_ungated_evidence", `${gate.id}: ${gate.evidence.path}`);
      }
    } else if (gate.evidence?.type === "script") {
      exactKeys(gate.evidence, ["path", "type"], `${gate.id}.evidence`);
      await assertFile(gate.evidence.path, `${gate.id}.evidence`);
      if (!gateCommand.includes(gate.evidence.path)) {
        fail("acceptance_ungated_evidence", `${gate.id}: ${gate.evidence.path}`);
      }
    } else {
      fail("acceptance_invalid_evidence", gate.id);
    }
    gateIds.add(gate.id);
  }
  for (const gateId of requiredReleaseGates) {
    if (!gateIds.has(gateId)) fail("acceptance_missing_gate", gateId);
  }

  const statuses = { complete: 0, open: 0, total: requirements.size };
  for (const requirement of requirements.values()) statuses[requirement.status] += 1;
  if (process.argv.includes("--require-release-ready")) {
    const blockers = [...requirements.values()]
      .filter(({ status }) => status !== "complete")
      .map(({ id }) => id);
    if (matrix.product_status !== "complete") {
      blockers.unshift(`product_status=${matrix.product_status}`);
    }
    if (!new Set(["release_candidate", "experimental"]).has(matrix.release_status)) {
      blockers.unshift(`release_status=${matrix.release_status}`);
    }
    if (blockers.length > 0) fail("acceptance_release_blocked", blockers.join(", "));
  }
  if (process.argv.includes("--require-stable-ready")) {
    const blockers = [...requirements.values()]
      .filter(({ status }) => status !== "complete")
      .map(({ id }) => id);
    if (matrix.product_status !== "complete") blockers.unshift("product_status");
    if (matrix.release_status !== "stable") blockers.unshift("release_status");
    if (p0.validation_status !== "validated") blockers.unshift("validation_status");
    if (p0.p0_validated !== true) blockers.unshift("p0_validated");
    if (p0.quality_floor_status !== "satisfied") blockers.unshift("quality_floor_status");
    if (p0.stable_promotion?.status !== "approved") {
      blockers.unshift("stable_promotion.status");
    }
    if (p0.stable_promotion?.maintainer_e2e_status !== "complete") {
      blockers.unshift("stable_promotion.maintainer_e2e_status");
    }
    if (p0.stable_promotion?.approved_tag !== `v${packageJson.version}`) {
      blockers.unshift("stable_promotion.approved_tag");
    }
    if (blockers.length > 0) fail("acceptance_stable_blocked", blockers.join(", "));
  }
  if (process.argv.includes("--require-publish-ready")) {
    const blockers = [...requirements.values()]
      .filter(({ id, status }) => status !== "complete" && !postPublicationRequirementIds.has(id))
      .map(({ id }) => id);
    if (matrix.release_status !== "release_candidate") {
      blockers.unshift(`release_status=${matrix.release_status}`);
    }
    if (matrix.product_status !== "incomplete") {
      blockers.unshift(`product_status=${matrix.product_status}`);
    }
    if (blockers.length > 0) fail("acceptance_publish_blocked", blockers.join(", "));
  }
  return {
    status: "completed",
    schema_version: matrix.schema_version,
    product_status: matrix.product_status,
    release_status: matrix.release_status,
    requirements: statuses,
    release_gates: gateIds.size,
  };
}

try {
  const result = await validate();
  process.stdout.write(
    process.argv.includes("--json")
      ? `${JSON.stringify(result)}\n`
      : `Validated ${result.requirements.total} P0 requirements and ${result.release_gates} release gates.\n`,
  );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
