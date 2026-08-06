export const CLI_INTERACTION_CONTRACT = "launchrally.dev/cli/v0";
export const MANIFEST_SCHEMA = "launchrally.dev/manifest/v1";
export const REPORT_SCHEMA = "launchrally.dev/report/v1";
export const AUDIT_BRIEF_SCHEMA = "launchrally.dev/audit-brief/v1";
export const AUDIT_INTERACTION_SCHEMA = "launchrally.dev/audit-interaction/v1";

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
