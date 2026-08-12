import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cliInteractionSchema = require("../schemas/cli/v2.schema.json");
const executionAuthoritySchema = require("../schemas/execution-authority/v1.schema.json");
const executionAuthorityDescriptorSchema = require(
  "../schemas/execution-authority/v1-descriptor.schema.json",
);
const toolchainLifecycleSchema = require("../schemas/toolchain-lifecycle/v1.schema.json");
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
const providerToolRecoverySchema = require(
  "../schemas/provider-tool-recovery/v1.schema.json",
);
const phase1Schema = require("../schemas/phase-1/v1.schema.json");

export const CLI_INTERACTION_CONTRACT = "launchrally.dev/cli/v2";
export const EXECUTION_AUTHORITY_CONTRACT = "launchrally.dev/execution-authority/v1";
export const TOOLCHAIN_LIFECYCLE_CONTRACT = "launchrally.dev/toolchain-lifecycle/v1";
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
export const PROVIDER_TOOL_RECOVERY_SCHEMA =
  "launchrally.dev/provider-tool-recovery/v1";
export const PROTECTED_JOURNEY_SCHEMA = "launchrally.dev/protected-journey/v1";
export const AUTHENTICATED_JOURNEY_PLAN_SCHEMA =
  "launchrally.dev/authenticated-journey-plan/v1";
export const AUTHENTICATED_JOURNEY_RESULTS_SCHEMA =
  "launchrally.dev/authenticated-journey-results/v1";
export const AUTHENTICATED_JOURNEY_ADAPTER_VERSION =
  "host-agent-authenticated-journey/v1";
export const PRODUCT_INTENT_PROFILE_SCHEMA =
  "launchrally.dev/product-intent-profile/v1";
export const CAPABILITY_CATALOG_SCHEMA = "launchrally.dev/capability-catalog/v1";
export const CAPABILITY_GRAPH_SCHEMA = "launchrally.dev/capability-graph/v1";
export const INTEGRATION_CONTRACT_SCHEMA = "launchrally.dev/integration-contract/v1";
export const ARCHITECTURE_BLUEPRINT_SCHEMA =
  "launchrally.dev/architecture-blueprint/v1";
export const ARCHITECTURE_RECORD_SCHEMA = "launchrally.dev/architecture-record/v1";
export const ARCHITECTURE_PACKAGE_SCHEMA = "launchrally.dev/architecture-package/v1";
export const TASK_GRAPH_SCHEMA = "launchrally.dev/task-graph/v1";
export const EXECUTOR_DESCRIPTOR_SCHEMA = "launchrally.dev/executor-descriptor/v1";
export const HANDOFF_PACKAGE_SCHEMA = "launchrally.dev/handoff-package/v1";
export const EXECUTION_RECEIPT_SCHEMA = "launchrally.dev/execution-receipt/v1";
export const ACTIVE_VERIFICATION_REQUEST_SCHEMA =
  "launchrally.dev/active-verification-request/v1";
export const ACTIVE_VERIFICATION_RESULT_SCHEMA =
  "launchrally.dev/active-verification-result/v1";
export const ARCHITECTURE_STATUS_SCHEMA = "launchrally.dev/architecture-status/v1";
export const ARCHITECT_INTERACTION_SCHEMA =
  "launchrally.dev/architect-interaction/v1";
export const HANDOFF_INTERACTION_SCHEMA = "launchrally.dev/handoff-interaction/v1";
export const PHASE_1_SCHEMA_VERSIONS = Object.freeze([
  PRODUCT_INTENT_PROFILE_SCHEMA,
  CAPABILITY_CATALOG_SCHEMA,
  CAPABILITY_GRAPH_SCHEMA,
  INTEGRATION_CONTRACT_SCHEMA,
  ARCHITECTURE_BLUEPRINT_SCHEMA,
  ARCHITECTURE_RECORD_SCHEMA,
  ARCHITECTURE_PACKAGE_SCHEMA,
  TASK_GRAPH_SCHEMA,
  EXECUTOR_DESCRIPTOR_SCHEMA,
  HANDOFF_PACKAGE_SCHEMA,
  EXECUTION_RECEIPT_SCHEMA,
  ACTIVE_VERIFICATION_REQUEST_SCHEMA,
  ACTIVE_VERIFICATION_RESULT_SCHEMA,
  ARCHITECTURE_STATUS_SCHEMA,
  ARCHITECT_INTERACTION_SCHEMA,
  HANDOFF_INTERACTION_SCHEMA,
]);

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

const PROHIBITED_PERSISTED_FIELDS = new Set([
  "raw_source",
  "provider_output",
  "raw_provider_output",
  "raw_stdout",
  "raw_stderr",
  "response_body",
  "secret",
  "secret_value",
  "credential",
  "credential_value",
  "business_payload",
  "real_user_data",
]);

function hasPersistedSensitivePayload(value) {
  if (Array.isArray(value)) return value.some(hasPersistedSensitivePayload);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    (PROHIBITED_PERSISTED_FIELDS.has(key) && child !== false && child !== null)
    || hasPersistedSensitivePayload(child));
}

function referenceUses(reference, schemaVersions) {
  return schemaVersions.includes(reference?.schema_version);
}

function assertPhase1Schema(value, definition, message, errorCode, predicates = []) {
  const valid = validatesSchema(value, phase1Schema.$defs[definition], phase1Schema)
    && !hasPersistedSensitivePayload(value)
    && predicates.every((predicate) => predicate(value));
  if (!valid) {
    const error = new Error(message);
    error.code = errorCode;
    throw error;
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
  const recoveries = source?.report?.results?.provider_tool_recoveries;
  const validRecoveries = recoveries === undefined
    || Array.isArray(recoveries)
      && source.report.results.provider_tool_recoveries.every((recovery) => {
        try {
          return assertValidProviderToolRecovery(recovery);
        } catch {
          return false;
        }
      });
  const valid = source?.status === "completed"
    && ["audit", "verify"].includes(source?.operation)
    && (source?.operation !== "verify" || source?.verification_scope?.whole_release === true)
    && reportSchema
    && reportViewSchema
    && validatesSchema(source.report, reportSchema)
    && validatesSchema(source.report_view, reportViewSchema)
    && validatesSchema(source.evidence_index, evidenceIndexSchema)
    && validRecoveries
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

export function assertValidToolchainLifecycle(interaction) {
  const schema = structuredClone(toolchainLifecycleSchema);
  schema.properties.authority = {};
  const validAuthority = !interaction?.authority
    || (() => {
      try {
        assertValidExecutionAuthority(interaction.authority);
        return true;
      } catch {
        return false;
      }
    })();
  if (!validatesSchema(interaction, schema) || !validAuthority) {
    const error = new Error("The Project Toolchain lifecycle interaction is invalid.");
    error.code = "invalid_toolchain_lifecycle";
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
  const recoveries = result?.targeted_result?.provider_tool_recoveries;
  const targetedRecoveries = result?.verification_scope?.whole_release !== false
    || recoveries === undefined
    || Array.isArray(recoveries)
      && result.targeted_result.provider_tool_recoveries.every((recovery) => {
        try {
          return assertValidProviderToolRecovery(recovery);
        } catch {
          return false;
        }
      });
  const valid = validatesSchema(result, verificationResultSchema)
    && commonHistory
    && targetedRecoveries
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

export function assertValidProviderToolRecovery(recovery) {
  if (!validatesSchema(recovery, providerToolRecoverySchema)) {
    const error = new Error("The Provider Tool Recovery is incomplete or invalid.");
    error.code = "invalid_provider_tool_recovery";
    throw error;
  }
  return true;
}

export function assertValidProductIntentProfile(profile) {
  return assertPhase1Schema(
    profile,
    "productIntentProfile",
    "The Product Intent Profile is incomplete or invalid.",
    "invalid_product_intent_profile",
  );
}

export function assertValidCapabilityCatalog(catalog) {
  return assertPhase1Schema(
    catalog,
    "capabilityCatalog",
    "The Capability Catalog is incomplete or invalid.",
    "invalid_capability_catalog",
  );
}

export function assertValidCapabilityGraph(graph) {
  const confirmedCandidates = graph?.derived_obligations?.some((obligation) =>
    obligation.state === "confirmed"
      && obligation.confirmation !== "explicit_user_confirmation");
  const validEnvironments = graph?.nodes?.every((node) => node.environment === graph.environment);
  if (
    !validatesSchema(graph, phase1Schema.$defs.capabilityGraph, phase1Schema)
    || confirmedCandidates
    || !validEnvironments
    || !referenceUses(graph?.product_intent, [PRODUCT_INTENT_PROFILE_SCHEMA])
    || !referenceUses(graph?.catalog, [CAPABILITY_CATALOG_SCHEMA])
    || hasPersistedSensitivePayload(graph)
  ) {
    const error = new Error("The Capability Graph is incomplete or invalid.");
    error.code = "invalid_capability_graph";
    throw error;
  }
  return true;
}

export function assertValidIntegrationContract(contract) {
  return assertPhase1Schema(
    contract,
    "integrationContract",
    "The Integration Contract is incomplete or invalid.",
    "invalid_integration_contract",
  );
}

export function assertValidArchitectureBlueprint(blueprint) {
  const validReferences = referenceUses(blueprint?.source_report, [
    "launchrally.dev/report/v1",
    REPORT_SCHEMA,
  ])
    && referenceUses(blueprint?.product_intent, [PRODUCT_INTENT_PROFILE_SCHEMA])
    && referenceUses(blueprint?.capability_graph, [CAPABILITY_GRAPH_SCHEMA]);
  if (
    !validatesSchema(blueprint, phase1Schema.$defs.architectureBlueprint, phase1Schema)
    || !validReferences
    || hasPersistedSensitivePayload(blueprint)
  ) {
    const error = new Error("The Architecture Blueprint is incomplete or invalid.");
    error.code = "invalid_architecture_blueprint";
    throw error;
  }
  return true;
}

export function assertValidArchitectureRecord(record) {
  const validBindings = referenceUses(record?.blueprint, [ARCHITECTURE_BLUEPRINT_SCHEMA])
    && referenceUses(record?.bindings?.source_report, [
      "launchrally.dev/report/v1",
      REPORT_SCHEMA,
    ])
    && referenceUses(record?.bindings?.product_intent, [PRODUCT_INTENT_PROFILE_SCHEMA])
    && referenceUses(record?.bindings?.capability_catalog, [CAPABILITY_CATALOG_SCHEMA])
    && record?.bindings?.integration_contracts?.every((reference) =>
      referenceUses(reference, [INTEGRATION_CONTRACT_SCHEMA]));
  if (
    !validatesSchema(record, phase1Schema.$defs.architectureRecord, phase1Schema)
    || !validBindings
    || hasPersistedSensitivePayload(record)
  ) {
    const error = new Error("The Architecture Record is incomplete or invalid.");
    error.code = "invalid_architecture_record";
    throw error;
  }
  return true;
}

export function assertValidArchitecturePackage(architecturePackage) {
  const { currentness } = architecturePackage ?? {};
  const currentStateIsConsistent = currentness?.state !== "current"
    || (
      currentness.invalidated_record_ids?.length === 0
      && currentness.reasons?.length === 0
    );
  if (
    !validatesSchema(
      architecturePackage,
      phase1Schema.$defs.architecturePackage,
      phase1Schema,
    )
    || !currentStateIsConsistent
    || !referenceUses(
      architecturePackage?.records?.product_intent,
      [PRODUCT_INTENT_PROFILE_SCHEMA],
    )
    || !referenceUses(
      architecturePackage?.records?.capability_graph,
      [CAPABILITY_GRAPH_SCHEMA],
    )
    || !referenceUses(
      architecturePackage?.records?.architecture_record,
      [ARCHITECTURE_RECORD_SCHEMA],
    )
    || (
      architecturePackage?.records?.task_graph !== null
      && !referenceUses(architecturePackage?.records?.task_graph, [TASK_GRAPH_SCHEMA])
    )
    || hasPersistedSensitivePayload(architecturePackage)
  ) {
    const error = new Error("The Architecture Package is incomplete or invalid.");
    error.code = "invalid_architecture_package";
    throw error;
  }
  return true;
}

function taskGraphIsAcyclic(tasks) {
  const taskIds = new Set(tasks.map(({ task_id: taskId }) => taskId));
  if (taskIds.size !== tasks.length) return false;
  if (tasks.some(({ prerequisites }) => prerequisites.some((taskId) => !taskIds.has(taskId)))) {
    return false;
  }
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  const visiting = new Set();
  const visited = new Set();
  function visit(taskId) {
    if (visiting.has(taskId)) return false;
    if (visited.has(taskId)) return true;
    visiting.add(taskId);
    if (!taskById.get(taskId).prerequisites.every(visit)) return false;
    visiting.delete(taskId);
    visited.add(taskId);
    return true;
  }
  return tasks.every(({ task_id: taskId }) => visit(taskId));
}

const PREREQUISITE_COMPLETE_STATES = new Set([
  "reported_succeeded",
  "verification_pending",
  "verified",
]);

function effectsAreDisjoint(value) {
  const allowed = new Set(value?.allowed_effects ?? []);
  return (value?.prohibited_effects ?? []).every((effect) => !allowed.has(effect));
}

export function assertValidTaskGraph(graph) {
  const tasks = graph?.tasks ?? [];
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  const valid = validatesSchema(graph, phase1Schema.$defs.taskGraph, phase1Schema)
    && tasks.every((task) => task.environment === graph.environment && effectsAreDisjoint(task))
    && taskGraphIsAcyclic(tasks)
    && graph.ready_frontier.every((taskId) => {
      const task = taskById.get(taskId);
      return task?.status === "not_started"
        && task.prerequisites.every((prerequisiteId) =>
          PREREQUISITE_COMPLETE_STATES.has(taskById.get(prerequisiteId)?.status));
    })
    && referenceUses(graph?.architecture_record, [ARCHITECTURE_RECORD_SCHEMA])
    && !hasPersistedSensitivePayload(graph);
  if (!valid) {
    const error = new Error("The Task Graph is incomplete or invalid.");
    error.code = "invalid_task_graph";
    throw error;
  }
  return true;
}

export function assertValidExecutorDescriptor(descriptor) {
  if (
    !validatesSchema(descriptor, phase1Schema.$defs.executorDescriptor, phase1Schema)
    || !effectsAreDisjoint(descriptor)
    || hasPersistedSensitivePayload(descriptor)
  ) {
    const error = new Error("The Executor Descriptor is incomplete or invalid.");
    error.code = "invalid_executor_descriptor";
    throw error;
  }
  return true;
}

export function assertValidHandoffPackage(handoffPackage) {
  const approval = handoffPackage?.approval;
  const validApproval = approval?.state !== "approved"
    || (
      approval.confirmation === "explicit_user_confirmation"
      && typeof approval.confirmed_at === "string"
    );
  if (
    !validatesSchema(handoffPackage, phase1Schema.$defs.handoffPackage, phase1Schema)
    || !effectsAreDisjoint(handoffPackage?.authority_batch)
    || !validApproval
    || !referenceUses(handoffPackage?.task_graph, [TASK_GRAPH_SCHEMA])
    || !referenceUses(handoffPackage?.executor, [EXECUTOR_DESCRIPTOR_SCHEMA])
    || hasPersistedSensitivePayload(handoffPackage)
  ) {
    const error = new Error("The Handoff Package is incomplete or invalid.");
    error.code = "invalid_handoff_package";
    throw error;
  }
  return true;
}

export function assertValidExecutionReceipt(receipt) {
  if (
    !validatesSchema(receipt, phase1Schema.$defs.executionReceipt, phase1Schema)
    || !referenceUses(receipt?.handoff, [HANDOFF_PACKAGE_SCHEMA])
    || !referenceUses(receipt?.executor, [EXECUTOR_DESCRIPTOR_SCHEMA])
    || hasPersistedSensitivePayload(receipt)
  ) {
    const error = new Error("The execution receipt is incomplete or invalid.");
    error.code = "invalid_execution_receipt";
    throw error;
  }
  return true;
}

export function assertValidActiveVerificationRequest(request) {
  const approved = request?.approval?.state !== "approved"
    || request.approval.confirmation === "explicit_user_confirmation";
  const productionAllowed = request?.environment !== "production"
    || (
      request?.production_safety?.classification === "production_safe"
      && request?.approval?.separate_production_approval === true
    );
  if (
    !validatesSchema(request, phase1Schema.$defs.activeVerificationRequest, phase1Schema)
    || !effectsAreDisjoint(request?.effects)
    || request?.timeout_ms < request?.observation_window_ms
    || !approved
    || !productionAllowed
    || hasPersistedSensitivePayload(request)
  ) {
    const error = new Error("The active-verification request is incomplete or invalid.");
    error.code = "invalid_active_verification_request";
    throw error;
  }
  return true;
}

export function assertValidActiveVerificationResult(result) {
  if (
    !validatesSchema(result, phase1Schema.$defs.activeVerificationResult, phase1Schema)
    || !referenceUses(result?.request, [ACTIVE_VERIFICATION_REQUEST_SCHEMA])
    || hasPersistedSensitivePayload(result)
  ) {
    const error = new Error("The active-verification result is incomplete or invalid.");
    error.code = "invalid_active_verification_result";
    throw error;
  }
  return true;
}

export function assertValidArchitectureStatus(status) {
  if (
    !validatesSchema(status, phase1Schema.$defs.architectureStatus, phase1Schema)
    || !referenceUses(status?.architecture_record, [ARCHITECTURE_RECORD_SCHEMA])
    || hasPersistedSensitivePayload(status)
  ) {
    const error = new Error("The Architecture Status is incomplete or invalid.");
    error.code = "invalid_architecture_status";
    throw error;
  }
  return true;
}

function assertValidPhase1Interaction(interaction, operation, schemaVersion, errorCode) {
  const operationStates = {
    architect: new Set([
      "intent_discovery",
      "blueprint_review",
      "decision_confirmation",
      "completed",
    ]),
    handoff: new Set([
      "executor_discovery",
      "authority_preview",
      "receipt_review",
      "verification_pending",
      "completed",
    ]),
  };
  const statusStates = {
    needs_input: new Set(["intent_discovery", "executor_discovery"]),
    needs_confirmation: new Set([
      "blueprint_review",
      "decision_confirmation",
      "authority_preview",
    ]),
    partial_completion: new Set(["decision_confirmation", "receipt_review"]),
    completed: new Set(["completed"]),
  };
  const requiresResume = new Set([
    "needs_input",
    "needs_confirmation",
    "partial_completion",
    "stale_input",
    "resumable",
  ]);
  const terminal = new Set(["denied", "cancelled", "completed"]);
  const valid = validatesSchema(interaction, phase1Schema.$defs.phase1Interaction, phase1Schema)
    && interaction?.operation === operation
    && interaction?.schema_version === schemaVersion
    && operationStates[operation].has(interaction?.state)
    && (!statusStates[interaction?.status] || statusStates[interaction.status].has(interaction.state))
    && (!requiresResume.has(interaction?.status) || typeof interaction?.resume_token === "string")
    && (!terminal.has(interaction?.status) || interaction?.resume_token === null)
    && !hasPersistedSensitivePayload(interaction);
  if (!valid) {
    const error = new Error(`The ${operation} interaction is incomplete or invalid.`);
    error.code = errorCode;
    throw error;
  }
  return true;
}

export function assertValidArchitectInteraction(interaction) {
  return assertValidPhase1Interaction(
    interaction,
    "architect",
    ARCHITECT_INTERACTION_SCHEMA,
    "invalid_architect_interaction",
  );
}

export function assertValidHandoffInteraction(interaction) {
  return assertValidPhase1Interaction(
    interaction,
    "handoff",
    HANDOFF_INTERACTION_SCHEMA,
    "invalid_handoff_interaction",
  );
}

function collectPhase1References(value, references = []) {
  if (Array.isArray(value)) {
    for (const child of value) collectPhase1References(child, references);
    return references;
  }
  if (!value || typeof value !== "object") return references;
  if (
    typeof value.id === "string"
    && typeof value.schema_version === "string"
    && typeof value.digest === "string"
    && Object.keys(value).length === 3
  ) {
    references.push(value);
    return references;
  }
  for (const child of Object.values(value)) collectPhase1References(child, references);
  return references;
}

export function assertValidPhase1References(record, referenceIndex) {
  const indexedReference = (id) => referenceIndex instanceof Map
    ? referenceIndex.get(id)
    : referenceIndex?.[id];
  const valid = referenceIndex
    && collectPhase1References(record).every((reference) => {
      const expected = indexedReference(reference.id);
      return expected?.id === reference.id
        && expected?.schema_version === reference.schema_version
        && expected?.digest === reference.digest;
    });
  if (!valid) {
    const error = new Error("A Phase 1 cross-record reference is missing or invalid.");
    error.code = "invalid_phase_1_reference";
    throw error;
  }
  return true;
}

const PHASE_1_VALIDATORS = Object.freeze({
  [PRODUCT_INTENT_PROFILE_SCHEMA]: assertValidProductIntentProfile,
  [CAPABILITY_CATALOG_SCHEMA]: assertValidCapabilityCatalog,
  [CAPABILITY_GRAPH_SCHEMA]: assertValidCapabilityGraph,
  [INTEGRATION_CONTRACT_SCHEMA]: assertValidIntegrationContract,
  [ARCHITECTURE_BLUEPRINT_SCHEMA]: assertValidArchitectureBlueprint,
  [ARCHITECTURE_RECORD_SCHEMA]: assertValidArchitectureRecord,
  [ARCHITECTURE_PACKAGE_SCHEMA]: assertValidArchitecturePackage,
  [TASK_GRAPH_SCHEMA]: assertValidTaskGraph,
  [EXECUTOR_DESCRIPTOR_SCHEMA]: assertValidExecutorDescriptor,
  [HANDOFF_PACKAGE_SCHEMA]: assertValidHandoffPackage,
  [EXECUTION_RECEIPT_SCHEMA]: assertValidExecutionReceipt,
  [ACTIVE_VERIFICATION_REQUEST_SCHEMA]: assertValidActiveVerificationRequest,
  [ACTIVE_VERIFICATION_RESULT_SCHEMA]: assertValidActiveVerificationResult,
  [ARCHITECTURE_STATUS_SCHEMA]: assertValidArchitectureStatus,
  [ARCHITECT_INTERACTION_SCHEMA]: assertValidArchitectInteraction,
  [HANDOFF_INTERACTION_SCHEMA]: assertValidHandoffInteraction,
});

export function assertSupportedPhase1Version(value) {
  const schemaVersion = typeof value === "string" ? value : value?.schema_version;
  if (!PHASE_1_SCHEMA_VERSIONS.includes(schemaVersion)) {
    const error = new Error("Unsupported Phase 1 contract version.");
    error.code = "unsupported_phase_1_version";
    throw error;
  }
  return 1;
}

export function assertValidPhase1Record(record) {
  assertSupportedPhase1Version(record);
  return PHASE_1_VALIDATORS[record.schema_version](record);
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
