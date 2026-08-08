import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertAppendOnlyValidationLog,
  assertCompleteValidationEntries,
  assertNoHardValidationQuota,
  assertNonIdentifyingValidationLog,
  assertPermittedValidationSources,
  assertReviewedAggregateTaxonomy,
  assertValidationAuthorityState,
} from "./validation-log-contract.mjs";

const execFileAsync = promisify(execFile);

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootOption = process.argv.indexOf("--root");
const root = rootOption === -1
  ? scriptRoot
  : path.resolve(process.argv[rootOption + 1] ?? "");
const contract = JSON.parse(await readFile(
  path.join(root, "release/p0.json"),
  "utf8",
));

if (
  contract.schema_version !== "launchrally.dev/p0-release/v1"
  || contract.phase !== "p0"
  || !["complete", "suspended"].includes(contract.product_status)
  || contract.release_status !== "experimental"
  || contract.validation_mode !== "telemetry_free"
  || !["collecting", "suspended", "validated"].includes(contract.validation_status)
  || typeof contract.p0_validated !== "boolean"
  || !["satisfied", "suspended"].includes(contract.quality_floor_status)
  || contract.p1_discovery !== "allowed"
  || !["allowed", "blocked"].includes(contract.p1_authority)
  || contract.license !== "Apache-2.0"
  || !Array.isArray(contract.acceptance_requirement_ids)
  || contract.acceptance_requirement_ids.length === 0
) {
  throw new Error("p0_release_incomplete: release/p0.json has an invalid P0 identity");
}

const rootLicense = await readFile(path.join(root, "LICENSE"), "utf8");
const rootPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (rootPackage.license !== contract.license) {
  throw new Error(
    `p0_license_drift: ${rootPackage.name} declares ${rootPackage.license}; expected ${contract.license}`,
  );
}
const artifacts = JSON.parse(await readFile(
  path.join(root, "release/artifacts.json"),
  "utf8",
));
for (const artifact of artifacts.packages) {
  const packageJson = JSON.parse(await readFile(
    path.join(root, artifact.path, "package.json"),
    "utf8",
  ));
  if (packageJson.license !== contract.license) {
    throw new Error(
      `p0_license_drift: ${packageJson.name} declares ${packageJson.license}; expected ${contract.license}`,
    );
  }
  const artifactLicense = await readFile(path.join(root, artifact.path, "LICENSE"), "utf8");
  if (artifactLicense !== rootLicense || !artifact.files.includes("LICENSE")) {
    throw new Error(`p0_license_drift: ${artifact.name} does not bundle the canonical LICENSE`);
  }
}

for (const document of contract.required_documents ?? []) {
  const content = await readFile(path.join(root, document.path), "utf8");
  for (const phrase of document.includes ?? []) {
    if (!content.toLocaleLowerCase("en-US").includes(phrase.toLocaleLowerCase("en-US"))) {
      throw new Error(`p0_release_incomplete: ${document.path} must include ${phrase}`);
    }
  }
}

const validationLog = JSON.parse(await readFile(
  path.join(root, contract.validation_log),
  "utf8",
));
if (
  validationLog.schema_version !== "launchrally.dev/phase-0-validation-log/v1"
  || validationLog.collection_mode !== "telemetry_free"
  || !Array.isArray(validationLog.entries)
  || validationLog.entries.length === 0
) {
  throw new Error(`p0_release_incomplete: ${contract.validation_log} is incomplete`);
}
assertNonIdentifyingValidationLog(validationLog);
assertNoHardValidationQuota(validationLog);
assertCompleteValidationEntries(validationLog);
assertPermittedValidationSources(validationLog);
const validationState = assertValidationAuthorityState(validationLog);
assertReviewedAggregateTaxonomy(validationLog);
for (const field of [
  "product_status",
  "validation_status",
  "p0_validated",
  "quality_floor_status",
  "p1_discovery",
  "p1_authority",
]) {
  if (contract[field] !== validationState[field]) {
    throw new Error(`p0_validation_state_drift: ${field}`);
  }
}
const completionDocuments = await Promise.all([
  "CONTRIBUTING.md",
  "README.md",
  "docs/maintainers/p0-acceptance.md",
  "docs/maintainers/phase-0-validation.md",
].map(async (relativePath) => ({
  content: await readFile(path.join(root, relativePath), "utf8"),
  relativePath,
})));
for (const { content, relativePath } of completionDocuments) {
  const claimsComplete = /\bP0 is Product Complete\b/iu.test(content);
  const claimsSuspended = /\bP0 Product Complete claim is suspended\b/iu.test(content);
  if (
    (contract.product_status === "complete" && !claimsComplete)
    || (contract.product_status === "suspended" && (claimsComplete || !claimsSuspended))
  ) {
    throw new Error(`p0_completion_claim_drift: ${relativePath}`);
  }
}
const baselineLogOption = process.argv.indexOf("--baseline-log");
if (baselineLogOption !== -1) {
  const baselineLogPath = process.argv[baselineLogOption + 1];
  const resolvedBaseline = baselineLogPath && !path.isAbsolute(baselineLogPath)
    ? path.resolve(root, baselineLogPath)
    : null;
  if (
    !resolvedBaseline
    || !resolvedBaseline.startsWith(`${root}${path.sep}`)
  ) {
    throw new Error("p0_validation_baseline_missing: --baseline-log");
  }
  const baselineLog = JSON.parse(await readFile(resolvedBaseline, "utf8"));
  assertAppendOnlyValidationLog(validationLog, baselineLog);
}
const baselineRefOption = process.argv.indexOf("--baseline-ref");
if (baselineRefOption !== -1) {
  const baselineRef = process.argv[baselineRefOption + 1];
  if (
    !baselineRef
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(baselineRef)
    || baselineRef.includes("..")
  ) {
    throw new Error("p0_validation_baseline_missing: --baseline-ref");
  }
  let baselineContent;
  try {
    ({ stdout: baselineContent } = await execFileAsync(
      "git",
      ["show", `${baselineRef}:${contract.validation_log}`],
      { cwd: root, encoding: "utf8" },
    ));
  } catch {
    throw new Error(`p0_validation_baseline_missing: ${baselineRef}`);
  }
  assertAppendOnlyValidationLog(validationLog, JSON.parse(baselineContent));
}
const result = {
  status: "completed",
  phase: contract.phase,
  product_status: contract.product_status,
  release_status: contract.release_status,
  validation_mode: contract.validation_mode,
  validation_status: contract.validation_status,
  p0_validated: contract.p0_validated,
  p1_discovery: contract.p1_discovery,
  p1_authority: contract.p1_authority,
  quality_floor_status: contract.quality_floor_status,
  license: contract.license,
  feedback_channels: contract.feedback_channels,
  quality_floor: contract.quality_floor,
};

process.stdout.write(
  process.argv.includes("--json")
    ? `${JSON.stringify(result)}\n`
    : "P0 release and validation contract is complete.\n",
);
