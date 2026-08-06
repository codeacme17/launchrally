import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const reportSchema = require("../schemas/report/v1.schema.json");
const reportViewSchema = require("../schemas/report-view/v1.schema.json");
const evidenceIndexSchema = require("../schemas/evidence-index/v1.schema.json");
const launchPlanSchema = require("../schemas/launch-plan/v1.schema.json");

export const CLI_INTERACTION_CONTRACT = "launchrally.dev/cli/v0";
export const MANIFEST_SCHEMA = "launchrally.dev/manifest/v1";
export const REPORT_SCHEMA = "launchrally.dev/report/v1";
export const MANIFEST_CONTRACT_MAJOR = 1;
export const REPORT_CONTRACT_MAJOR = 1;
export const REPORT_VIEW_SCHEMA = "launchrally.dev/report-view/v1";
export const EVIDENCE_INDEX_SCHEMA = "launchrally.dev/evidence-index/v1";
export const AUDIT_BRIEF_SCHEMA = "launchrally.dev/audit-brief/v1";
export const AUDIT_INTERACTION_SCHEMA = "launchrally.dev/audit-interaction/v1";
export const INIT_INTERACTION_SCHEMA = "launchrally.dev/init-interaction/v1";
export const LAUNCH_PLAN_SCHEMA = "launchrally.dev/launch-plan/v1";

function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value === "object" ? "object" : typeof value;
}

function schemaNodeAt(root, reference) {
  if (!reference.startsWith("#/")) return null;
  return reference.slice(2).split("/").reduce(
    (node, segment) => node?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")],
    root,
  );
}

function validatesSchema(value, schema, root = schema) {
  if (schema.$ref) {
    const referenced = schemaNodeAt(root, schema.$ref);
    return referenced ? validatesSchema(value, referenced, root) : false;
  }
  const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type].filter(Boolean);
  const actualType = jsonType(value);
  if (allowedTypes.length > 0 && !allowedTypes.some((type) =>
    type === actualType || (type === "number" && actualType === "integer"))) return false;
  if (Object.hasOwn(schema, "const") && !Object.is(value, schema.const)) return false;
  if (schema.enum && !schema.enum.some((candidate) => Object.is(value, candidate))) return false;
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) return false;
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) return false;
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) return false;
    if (schema.format === "uri") {
      try {
        new URL(value);
      } catch {
        return false;
      }
    }
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.uniqueItems) {
      const serialized = value.map((item) => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length) return false;
    }
    if (schema.items && value.some((item) => !validatesSchema(item, schema.items, root))) {
      return false;
    }
  }
  if (actualType === "object") {
    if (schema.required?.some((key) => !Object.hasOwn(value, key))) return false;
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key) && !validatesSchema(value[key], child, root)) return false;
    }
    if (schema.additionalProperties === false) {
      const approved = new Set(Object.keys(schema.properties ?? {}));
      if (Object.keys(value).some((key) => !approved.has(key))) return false;
    }
  }
  return true;
}

export function assertValidReportPackage(source) {
  const valid = source?.status === "completed"
    && source?.operation === "audit"
    && validatesSchema(source.report, reportSchema)
    && validatesSchema(source.report_view, reportViewSchema)
    && validatesSchema(source.evidence_index, evidenceIndexSchema)
    && source.report_view.report_id === source.report.report_id
    && source.report_view.report_schema_version === source.report.schema_version
    && source.evidence_index.report_id === source.report.report_id
    && source.report.execution.evidence_index.index_id === source.evidence_index.index_id;
  if (!valid) {
    const error = new Error("The saved Audit JSON is incomplete or invalid.");
    error.code = "invalid_report_package";
    throw error;
  }
  return true;
}

export function assertValidLaunchPlan(plan) {
  if (!validatesSchema(plan, launchPlanSchema)) {
    const error = new Error("The Launch Plan is incomplete or invalid.");
    error.code = "invalid_launch_plan";
    throw error;
  }
  return true;
}

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
