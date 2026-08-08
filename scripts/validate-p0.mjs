import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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
  || contract.product_status !== "incomplete"
  || contract.release_status !== "release_candidate"
  || contract.validation_mode !== "telemetry_free"
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
const forbiddenAnalyticsKeys = new Set([
  "email",
  "evidence_contents",
  "ip_address",
  "report_contents",
  "repository_name",
  "repository_url",
  "user_id",
  "username",
]);

function findForbiddenAnalyticsKey(value) {
  if (Array.isArray(value)) {
    return value.map(findForbiddenAnalyticsKey).find(Boolean);
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenAnalyticsKeys.has(key)) {
      return key;
    }
    const nestedKey = findForbiddenAnalyticsKey(nested);
    if (nestedKey) {
      return nestedKey;
    }
  }
  return null;
}

const forbiddenAnalyticsKey = findForbiddenAnalyticsKey(validationLog);
if (forbiddenAnalyticsKey) {
  throw new Error(
    `p0_user_analytics_forbidden: ${contract.validation_log} contains ${forbiddenAnalyticsKey}`,
  );
}
const allLogEntriesValid = validationLog.entries?.every((entry) => (
  entry.aggregate_adoption_trends
  && Array.isArray(entry.voluntary_feedback_categories)
  && Array.isArray(entry.represented_contexts?.frameworks)
  && Array.isArray(entry.represented_contexts?.deployments)
  && Array.isArray(entry.recurring_p1_requests)
  && Array.isArray(entry.product_decisions)
));
if (
  validationLog.schema_version !== "launchrally.dev/phase-0-validation-log/v1"
  || validationLog.collection_mode !== "telemetry_free"
  || !Array.isArray(validationLog.entries)
  || validationLog.entries.length === 0
  || !allLogEntriesValid
) {
  throw new Error(`p0_release_incomplete: ${contract.validation_log} is incomplete`);
}
const result = {
  status: "completed",
  phase: contract.phase,
  product_status: contract.product_status,
  release_status: contract.release_status,
  validation_mode: contract.validation_mode,
  license: contract.license,
  feedback_channels: contract.feedback_channels,
  quality_floor: contract.quality_floor,
};

process.stdout.write(
  process.argv.includes("--json")
    ? `${JSON.stringify(result)}\n`
    : "P0 pre-release contract is complete.\n",
);
