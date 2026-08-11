import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cliInteractionSchema = require("../schemas/cli/v2.schema.json");
const executionAuthoritySchema = require("../schemas/execution-authority/v1.schema.json");
const executionAuthorityDescriptorSchema = require(
  "../schemas/execution-authority/v1-descriptor.schema.json",
);
const reportSchemaV1 = require("../schemas/report/v1.schema.json");
const reportSchemaV2 = require("../schemas/report/v2.schema.json");
const reportViewSchemaV1 = require("../schemas/report-view/v1.schema.json");
const reportViewSchemaV2 = require("../schemas/report-view/v2.schema.json");
const evidenceIndexSchema = require("../schemas/evidence-index/v1.schema.json");
const launchPlanSchema = require("../schemas/launch-plan/v2.schema.json");
const legacyManifestSchema = require("../schemas/manifest/v1.schema.json");
const manifestSchema = require("../schemas/manifest/v2.schema.json");
const verificationResultSchema = require("../schemas/verification-result/v2.schema.json");
const providerDecisionCardSchema = require(
  "../schemas/provider-decision-card/v1.schema.json",
);
const providerGuidanceSchema = require("../schemas/provider-guidance/v2.schema.json");

export const CLI_INTERACTION_CONTRACT = "launchrally.dev/cli/v2";
export const EXECUTION_AUTHORITY_CONTRACT = "launchrally.dev/execution-authority/v1";
export const MANIFEST_SCHEMA = "launchrally.dev/manifest/v2";
export const REPORT_SCHEMA = "launchrally.dev/report/v2";
export const MANIFEST_CONTRACT_MAJOR = 2;
export const REPORT_CONTRACT_MAJOR = 2;
export const REPORT_VIEW_SCHEMA = "launchrally.dev/report-view/v2";
export const EVIDENCE_INDEX_SCHEMA = "launchrally.dev/evidence-index/v1";
export const AUDIT_BRIEF_SCHEMA = "launchrally.dev/audit-brief/v1";
export const AUDIT_INTERACTION_SCHEMA = "launchrally.dev/audit-interaction/v1";
export const INIT_INTERACTION_SCHEMA = "launchrally.dev/init-interaction/v2";
export const VERIFY_INTERACTION_SCHEMA = "launchrally.dev/verify-interaction/v2";
export const LAUNCH_PLAN_SCHEMA = "launchrally.dev/launch-plan/v2";
export const VERIFICATION_RESULT_SCHEMA = "launchrally.dev/verification-result/v2";
export const PROVIDER_GUIDANCE_INTERACTION_SCHEMA =
  "launchrally.dev/provider-guidance-interaction/v1";
export const PROVIDER_GUIDANCE_SCHEMA = "launchrally.dev/provider-guidance/v2";
export const PROVIDER_DECISION_CARD_SCHEMA =
  "launchrally.dev/provider-decision-card/v1";
export const PROVIDER_INTENT_DECISION_SCHEMA =
  "launchrally.dev/provider-intent-decision/v1";

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
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => validatesSchema(value, candidate, root));
    if (matches.length !== 1) return false;
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
  const reportSchemas = {
    "launchrally.dev/report/v1": reportSchemaV1,
    "launchrally.dev/report/v2": reportSchemaV2,
  };
  const reportViewSchemas = {
    "launchrally.dev/report-view/v1": reportViewSchemaV1,
    "launchrally.dev/report-view/v2": reportViewSchemaV2,
  };
  const reportSchema = reportSchemas[source?.report?.schema_version];
  const reportViewSchema = reportViewSchemas[source?.report_view?.schema_version];
  const valid = source?.status === "completed"
    && ["audit", "verify"].includes(source?.operation)
    && (source?.operation !== "verify" || source?.verification_scope?.whole_release === true)
    && reportSchema
    && reportViewSchema
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

export function assertValidManifest(manifest) {
  if (!validatesSchema(manifest, manifestSchema)) {
    const error = new Error("The LaunchRally Manifest is incomplete or invalid.");
    error.code = "invalid_manifest";
    throw error;
  }
  return true;
}

export function assertValidCliInteraction(interaction) {
  if (!validatesSchema(interaction, cliInteractionSchema)) {
    const error = new Error("The CLI interaction is incomplete or invalid.");
    error.code = "invalid_cli_interaction";
    throw error;
  }
  return true;
}

export function assertValidExecutionAuthority(authority) {
  const validLauncherVersion = authority?.source !== "launcher"
    || authority?.engine?.version === authority?.launcher_version;
  const validMigrationContract = authority?.state !== "needs_toolchain_migration"
    || (
      typeof authority?.engine?.contract === "string"
      && authority.engine.contract !== EXECUTION_AUTHORITY_CONTRACT
    );
  if (
    !validatesSchema(authority, executionAuthoritySchema)
    || !validLauncherVersion
    || !validMigrationContract
  ) {
    const error = new Error("The Execution Authority result is incomplete or invalid.");
    error.code = "invalid_execution_authority";
    throw error;
  }
  return true;
}

export function assertValidExecutionAuthorityDescriptor(descriptor) {
  if (!validatesSchema(descriptor, executionAuthorityDescriptorSchema)) {
    const error = new Error("The Execution Authority descriptor is incomplete or invalid.");
    error.code = "invalid_execution_authority_descriptor";
    throw error;
  }
  return true;
}

export function assertValidLegacyManifest(manifest) {
  if (!validatesSchema(manifest, legacyManifestSchema)) {
    const error = new Error("The legacy LaunchRally Manifest is incomplete or invalid.");
    error.code = "invalid_manifest";
    throw error;
  }
  return true;
}

export function assertValidVerificationResult(result) {
  const commonHistory = result?.history?.source_report_id === result?.comparison?.source_report_id;
  const fullHistory = result?.verification_scope?.whole_release
    && result?.history?.current_report_id === result?.report?.report_id
    && result?.history?.current_evidence_index_id === result?.evidence_index?.index_id
    && result?.comparison?.current_report_id === result?.report?.report_id
    && (
      result?.interaction?.schema_version === "launchrally.dev/verify-interaction/v1"
      || result?.interaction?.current_report?.report_id === result?.report?.report_id
    )
    && result?.assessment === result?.report?.assessment;
  const targetedHistory = result?.verification_scope?.whole_release === false
    && result?.history?.current_result_id === result?.targeted_result?.result_id
    && result?.comparison?.current_result_id === result?.targeted_result?.result_id
    && JSON.stringify(result?.verification_scope?.check_ids)
      === JSON.stringify(result?.targeted_result?.check_ids)
    && JSON.stringify(result?.manifest_drift)
      === JSON.stringify(result?.targeted_result?.manifest_drift);
  const valid = validatesSchema(result, verificationResultSchema)
    && commonHistory
    && (result.verification_scope.whole_release
      ? (() => {
        try {
          return fullHistory && assertValidReportPackage(result);
        } catch {
          return false;
        }
      })()
      : targetedHistory && result.assessment === null && !Object.hasOwn(result, "report"));
  if (!valid) {
    const error = new Error("The Verification Result is incomplete or invalid.");
    error.code = "invalid_verification_result";
    throw error;
  }
  return true;
}

export function assertValidProviderDecisionCard(card) {
  if (!validatesSchema(card, providerDecisionCardSchema)) {
    const error = new Error("The Provider Decision Card is incomplete or invalid.");
    error.code = "invalid_provider_decision_card";
    throw error;
  }
  return true;
}

export function assertValidProviderGuidance(guidance) {
  const validCards = !Array.isArray(guidance?.shortlist)
    || guidance.shortlist.every(({ card }) => validatesSchema(card, providerDecisionCardSchema));
  if (!validatesSchema(guidance, providerGuidanceSchema) || !validCards) {
    const error = new Error("The Provider Guidance result is incomplete or invalid.");
    error.code = "invalid_provider_guidance";
    throw error;
  }
  return true;
}

function assertSupportedMajor(value, contract, supportedMajors, errorCode) {
  const schemaVersion = typeof value === "string" ? value : value?.schema_version;
  const match = typeof schemaVersion === "string"
    ? schemaVersion.match(new RegExp(`^launchrally\\.dev/${contract}/v(\\d+)$`, "u"))
    : null;
  const actual = match ? Number(match[1]) : null;
  if (!match || !supportedMajors.includes(actual)) {
    const error = new Error(`Unsupported ${contract} contract major version.`);
    error.code = errorCode;
    throw error;
  }
  return actual;
}

export function assertSupportedManifestVersion(value) {
  return assertSupportedMajor(
    value,
    "manifest",
    [MANIFEST_CONTRACT_MAJOR],
    "unsupported_manifest_version",
  );
}

export function assertSupportedReportVersion(value) {
  return assertSupportedMajor(
    value,
    "report",
    [1, REPORT_CONTRACT_MAJOR],
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
