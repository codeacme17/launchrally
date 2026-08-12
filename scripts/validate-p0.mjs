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
import {
  invalidStablePromotionEvidence,
  stablePromotionBlockers,
} from "./stable-promotion-policy.mjs";

const execFileAsync = promisify(execFile);

function isRepositoryRelativePath(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)
    && path.posix.normalize(value) === value
    && !value.split("/").includes("..");
}

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootOption = process.argv.indexOf("--root");
const root = rootOption === -1
  ? scriptRoot
  : path.resolve(process.argv[rootOption + 1] ?? "");
const contract = JSON.parse(await readFile(
  path.join(root, "release/p0.json"),
  "utf8",
));
const stablePromotion = contract.stable_promotion;
const stablePromotionKeys = Object.keys(stablePromotion ?? {}).sort();
const hasStablePromotionShape = JSON.stringify(stablePromotionKeys) === JSON.stringify([
  "approved_tag",
  "maintainer_e2e_evidence",
  "maintainer_e2e_status",
  "status",
]);
const isExperimentalState = contract.release_status === "experimental"
  && stablePromotion?.status === "not_approved"
  && stablePromotion.maintainer_e2e_status === "pending"
  && Object.keys(stablePromotion.maintainer_e2e_evidence ?? {}).length === 0
  && stablePromotion.approved_tag === null;
const isStableState = contract.release_status === "stable";

if (
  contract.schema_version !== "launchrally.dev/p0-release/v1"
  || contract.phase !== "p0"
  || !["complete", "suspended"].includes(contract.product_status)
  || (!isExperimentalState && !isStableState)
  || contract.validation_mode !== "telemetry_free"
  || !["collecting", "suspended", "validated"].includes(contract.validation_status)
  || typeof contract.p0_validated !== "boolean"
  || !["satisfied", "suspended"].includes(contract.quality_floor_status)
  || !hasStablePromotionShape
  || !["not_approved", "approved"].includes(stablePromotion.status)
  || !["pending", "complete"].includes(stablePromotion.maintainer_e2e_status)
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
if (
  contract.release_status === "stable"
  && stablePromotion.approved_tag !== `v${rootPackage.version}`
) {
  throw new Error(
    `stable_promotion_tag_drift: ${stablePromotion.approved_tag}; expected v${rootPackage.version}`,
  );
}
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

if (!Array.isArray(contract.release_status_documents) || contract.release_status_documents.length === 0) {
  throw new Error("p0_release_status_claim_drift: release_status_documents");
}
for (const document of contract.release_status_documents) {
  const expected = document?.[contract.release_status];
  const keys = Object.keys(document ?? {}).sort();
  if (
    JSON.stringify(keys) !== JSON.stringify(["experimental", "path", "stable"])
    || typeof expected !== "string"
    || expected.length === 0
  ) {
    throw new Error(`p0_release_status_claim_drift: ${document?.path ?? "invalid path"}`);
  }
  const content = await readFile(path.join(root, document.path), "utf8");
  if (!content.includes(expected)) {
    throw new Error(
      `p0_release_status_claim_drift: ${document.path} must include ${expected}`,
    );
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
    const { stdout: baselineContractContent } = await execFileAsync(
      "git",
      ["show", `${baselineRef}:release/p0.json`],
      { cwd: root, encoding: "utf8" },
    );
    const baselineContract = JSON.parse(baselineContractContent);
    if (!isRepositoryRelativePath(baselineContract.validation_log)) {
      throw new Error("invalid baseline Validation Log path");
    }
    ({ stdout: baselineContent } = await execFileAsync(
      "git",
      ["show", `${baselineRef}:${baselineContract.validation_log}`],
      { cwd: root, encoding: "utf8" },
    ));
  } catch {
    throw new Error(`p0_validation_baseline_missing: ${baselineRef}`);
  }
  assertAppendOnlyValidationLog(validationLog, JSON.parse(baselineContent));
}
if (isStableState) {
  const blockers = stablePromotionBlockers({
    contract,
    release: artifacts,
    tag: stablePromotion.approved_tag,
    version: rootPackage.version,
  });
  const postPromotionSuspensionBlockers = new Set([
    "p0_validated",
    "product_status",
    "quality_floor_status",
    "validation_status",
  ]);
  const activeBlockers = contract.product_status === "suspended"
    ? blockers.filter((blocker) => !postPromotionSuspensionBlockers.has(blocker))
    : blockers;
  if (activeBlockers.length > 0) {
    throw new Error(`stable_promotion_blocked: ${activeBlockers.join(", ")}`);
  }
  const invalidEvidence = await invalidStablePromotionEvidence({
    promotion: stablePromotion,
    root,
  });
  if (invalidEvidence.length > 0) {
    throw new Error(`stable_promotion_e2e_evidence_invalid: ${invalidEvidence.join(", ")}`);
  }
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
  stable_promotion: stablePromotion,
  license: contract.license,
  feedback_channels: contract.feedback_channels,
  quality_floor: contract.quality_floor,
};

process.stdout.write(
  process.argv.includes("--json")
    ? `${JSON.stringify(result)}\n`
    : "P0 release and validation contract is complete.\n",
);
