export const CLI_INTERACTION_CONTRACT = "launchrally.dev/cli/v0";
export const MANIFEST_SCHEMA = "launchrally.dev/manifest/v1";
export const REPORT_SCHEMA = "launchrally.dev/report/v1";
export const MANIFEST_CONTRACT_MAJOR = 1;
export const REPORT_CONTRACT_MAJOR = 1;
export const REPORT_VIEW_SCHEMA = "launchrally.dev/report-view/v1";
export const EVIDENCE_INDEX_SCHEMA = "launchrally.dev/evidence-index/v1";
export const AUDIT_BRIEF_SCHEMA = "launchrally.dev/audit-brief/v1";
export const AUDIT_INTERACTION_SCHEMA = "launchrally.dev/audit-interaction/v1";

function assertSupportedMajor(value, contract, supported, errorCode) {
  const schemaVersion = typeof value === "string" ? value : value?.schema_version;
  const match = typeof schemaVersion === "string"
    ? schemaVersion.match(new RegExp(`^launchrally\\.dev/${contract}/v(\\d+)$`, "u"))
    : null;
  if (!match || Number(match[1]) !== supported) {
    const error = new Error(`Unsupported ${contract} contract major version.`);
    error.code = errorCode;
    throw error;
  }
  return supported;
}

export function assertSupportedManifestVersion(value) {
  return assertSupportedMajor(
    value,
    "manifest",
    MANIFEST_CONTRACT_MAJOR,
    "unsupported_manifest_version",
  );
}

export function assertSupportedReportVersion(value) {
  return assertSupportedMajor(
    value,
    "report",
    REPORT_CONTRACT_MAJOR,
    "unsupported_report_version",
  );
}

export const ASSESSMENTS = Object.freeze([
  "launch_ready",
  "ready_with_warnings",
  "no_go",
  "inconclusive",
]);

export const VERIFICATION_STATUSES = Object.freeze([
  "passed",
  "failed",
  "unverified",
  "not_applicable",
]);
