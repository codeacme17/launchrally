import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import {
  AUDIT_BRIEF_SCHEMA,
  AUDIT_INTERACTION_SCHEMA,
  CLI_INTERACTION_CONTRACT,
} from "@launchrally/contracts";

import { describeWebBaselineCatalog } from "./check-catalog.js";
import {
  createAuthenticatedJourneyPlan,
  createAuthenticatedJourneyResultRequest,
  normalizeAuthenticatedJourneyResults,
} from "./authenticated-journeys.js";
import { createProviderAdapterPlan } from "./provider-adapters.js";
import { parsePublicJourneyInput } from "./public-journey.js";
import { parsePublicTargetInput } from "./public-target.js";
import { createPublicVerificationPlan } from "./public-verification.js";
import {
  normalizeSupportLayer,
  SUPPORT_LAYER_CATEGORIES,
} from "./support-layers.js";

const PROVIDER_SIGNALS = Object.freeze([
  { prefix: "CLERK_", provider: "clerk", role: "authentication" },
  { prefix: "CLOUDFLARE_", provider: "cloudflare", role: "deployment" },
  { prefix: "NEON_", provider: "neon", role: "data" },
  { prefix: "NETLIFY_", provider: "netlify", role: "deployment" },
  { prefix: "POSTHOG_", provider: "posthog", role: "analytics" },
  { prefix: "RESEND_", provider: "resend", role: "email" },
  { prefix: "SENTRY_", provider: "sentry", role: "observability" },
  { prefix: "STRIPE_", provider: "stripe", role: "payments" },
  { prefix: "SUPABASE_", provider: "supabase", role: "data" },
  { prefix: "VERCEL_", provider: "vercel", role: "deployment" },
]);

function environmentVariableNames(project) {
  return project.facts
    .filter((fact) => fact.kind === "environment_variables")
    .flatMap((fact) => fact.names);
}

function providerCandidates(project) {
  const variableNames = environmentVariableNames(project);
  const candidates = new Map();
  for (const signal of PROVIDER_SIGNALS) {
    if (variableNames.some((name) => name.startsWith(signal.prefix))) {
      candidates.set(`${signal.provider}:${signal.role}`, {
        provider: signal.provider,
        role: signal.role,
      });
    }
  }
  return [...candidates.values()].sort((left, right) =>
    `${left.provider}:${left.role}`.localeCompare(`${right.provider}:${right.role}`),
  );
}

function supportCandidates(project) {
  const variableNames = environmentVariableNames(project);
  return [
    ...(variableNames.some((name) => name.startsWith("POSTHOG_")) ? ["analytics"] : []),
    ...(variableNames.some((name) => name.startsWith("SENTRY_")) ? ["observability"] : []),
  ];
}

function routeFromFile(filePath) {
  const normalized = String(filePath).replaceAll("\\", "/");
  const sourceExtension = "(?:[cm]?[jt]sx?|svelte)";
  let segments;

  const appRoute = normalized.match(
    new RegExp(`(?:^|/)app/(.*?/)?page\\.${sourceExtension}$`, "u"),
  );
  if (appRoute) segments = (appRoute[1] ?? "").split("/").filter(Boolean);

  const pagesRoute = normalized.match(
    new RegExp(`(?:^|/)pages/(.+)\\.${sourceExtension}$`, "u"),
  );
  if (!segments && pagesRoute && !pagesRoute[1].startsWith("api/")) {
    segments = pagesRoute[1].split("/");
  }

  const svelteRoute = normalized.match(
    new RegExp(`(?:^|/)src/routes/(.*?/)?\\+page\\.${sourceExtension}$`, "u"),
  );
  if (!segments && svelteRoute) segments = (svelteRoute[1] ?? "").split("/").filter(Boolean);

  const remixRoute = normalized.match(
    new RegExp(`(?:^|/)app/routes/(.+)\\.${sourceExtension}$`, "u"),
  );
  if (!segments && remixRoute) segments = remixRoute[1].split(".");

  if (!segments && /(?:^|\/)index\.html$/u.test(normalized)) segments = [];
  if (!segments) return null;

  const publicSegments = segments
    .filter((segment) => !/^\(.+\)$/u.test(segment) && !segment.startsWith("@"));
  if (publicSegments.some((segment, index) =>
    segment.startsWith("(")
      || segment.startsWith("[")
      || segment.includes("$")
      || (segment.startsWith("_")
        && !(segment === "_index" && index === publicSegments.length - 1)),
  )) return null;
  if (["index", "_index"].includes(publicSegments.at(-1))) publicSegments.pop();
  return `/${publicSegments.join("/")}`;
}

function routePurpose(route) {
  if (route === "/") return "homepage loads";
  const name = route.split("/").filter(Boolean).at(-1).replaceAll(/[-_]/gu, " ");
  return `${name} page loads`;
}

function journeyCandidates(project) {
  const files = [
    ...project.facts.map((fact) => fact.provenance?.path),
    ...(project.detected_files ?? []),
  ].filter(Boolean);
  const routes = [...new Set(files.map(routeFromFile).filter(Boolean))]
    .sort((left, right) => left === "/" ? -1 : right === "/" ? 1 : left.localeCompare(right))
    .slice(0, 12);
  return routes.map((route) => `GET ${route} — ${routePurpose(route)}`);
}

function encodeResumeState(state) {
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  const digest = createHash("sha256").update(payload).digest("base64url");
  return `${payload}.${digest}`;
}

function decodeResumeState(token) {
  if (typeof token !== "string") return null;
  const [payload, suppliedDigest, extra] = token.split(".");
  if (!payload || !suppliedDigest || extra !== undefined) return null;
  const expectedDigest = createHash("sha256").update(payload).digest();
  let actualDigest;
  try {
    actualDigest = Buffer.from(suppliedDigest, "base64url");
  } catch {
    return null;
  }
  if (
    actualDigest.length !== expectedDigest.length
    || !timingSafeEqual(actualDigest, expectedDigest)
  ) {
    return null;
  }
  try {
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return state?.schema_version === AUDIT_INTERACTION_SCHEMA ? state : null;
  } catch {
    return null;
  }
}

function normalizeAnswers(answers) {
  const errors = [];
  const intendedEnvironment = typeof answers?.intended_environment === "string"
    ? answers.intended_environment.trim()
    : "";
  if (!intendedEnvironment) {
    errors.push({ field_id: "intended_environment", code: "required" });
  }

  const productionTargets = [];
  if (!Array.isArray(answers?.production_targets) || answers.production_targets.length === 0) {
    errors.push({ field_id: "production_targets", code: "required" });
  } else {
    for (const target of answers.production_targets) {
      const parsed = parsePublicTargetInput(target);
      if (parsed.error) {
        errors.push({ field_id: "production_targets", code: parsed.error });
        break;
      }
      productionTargets.push(parsed.value);
    }
  }

  const coreJourneys = [];
  if (!Array.isArray(answers?.core_journeys)) {
    errors.push({ field_id: "core_journeys", code: "required" });
  } else {
    for (const suppliedJourney of answers.core_journeys) {
      const parsed = parsePublicJourneyInput(suppliedJourney);
      if (parsed.error) {
        errors.push({ field_id: "core_journeys", code: parsed.error });
        break;
      }
      if (typeof parsed.value === "string") {
        coreJourneys.push(parsed.value);
        continue;
      }
      let staysOnConfirmedOrigins = true;
      try {
        staysOnConfirmedOrigins = productionTargets.every((target) => {
          const origin = new URL(target).origin;
          return new URL(parsed.value.path, origin).origin === origin;
        });
      } catch {
        staysOnConfirmedOrigins = false;
      }
      if (!staysOnConfirmedOrigins) {
        errors.push({ field_id: "core_journeys", code: "invalid_public_journey" });
        break;
      }
      coreJourneys.push(parsed.value);
    }
  }
  const providerRoles = [];
  if (!Array.isArray(answers?.provider_roles)) {
    errors.push({ field_id: "provider_roles", code: "required" });
  } else {
    for (const entry of answers.provider_roles) {
      const provider = typeof entry?.provider === "string" ? entry.provider.trim().toLowerCase() : "";
      const role = typeof entry?.role === "string" ? entry.role.trim().toLowerCase() : "";
      if (!provider || !role) {
        errors.push({ field_id: "provider_roles", code: "invalid_provider_role" });
        break;
      }
      providerRoles.push({ provider, role });
    }
  }

  const supportLayers = [];
  const hasSupportLayers = Array.isArray(answers?.support_layers);
  if (hasSupportLayers) {
    for (const layer of answers.support_layers) {
      const normalized = normalizeSupportLayer(layer);
      if (!normalized) {
        errors.push({
          field_id: "support_layers",
          code: "unsupported_support_layer",
          supported_categories: SUPPORT_LAYER_CATEGORIES,
          guidance: "Choose a supported category or revise the support-layer selection.",
        });
        break;
      }
      supportLayers.push(normalized);
    }
  }
  if (!hasSupportLayers) {
    errors.push({ field_id: "support_layers", code: "required" });
  }

  return {
    errors,
    answers: {
      intended_environment: intendedEnvironment,
      production_targets: [...new Set(productionTargets)].sort(),
      core_journeys: [...new Map(coreJourneys.map((journey) => [
        typeof journey === "string" ? `description:${journey}` : JSON.stringify(journey),
        journey,
      ])).values()].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
      provider_roles: [...new Map(providerRoles.map((entry) => [
        `${entry.provider}:${entry.role}`,
        entry,
      ])).values()].sort((left, right) =>
        `${left.provider}:${left.role}`.localeCompare(`${right.provider}:${right.role}`),
      ),
      support_layers: [...new Set(supportLayers)].sort(),
    },
  };
}

function plannedChecks(answers) {
  const checks = describeWebBaselineCatalog().checks.map((check) => ({
    check_id: check.check_id,
    check_version: check.check_version,
    risk_domain: check.risk_domain,
    permission_id: check.permission_id,
    scope: check.permission_id === "public_verification" ? "confirmed_targets" : "repository",
  }));
  if (answers) {
    for (const check of checks.filter(
      (candidate) => candidate.permission_id === "public_verification",
    )) {
      check.targets = answers.production_targets;
    }
    checks.push(...createProviderAdapterPlan(answers.provider_roles).requests.map((request) => ({
      check_id: `provider.${request.provider}.metadata`,
      permission_id: request.permission_id,
      provider: request.provider,
      roles: request.roles,
      adapter_version: request.adapter_version,
      target: request.target,
      requested_fields: request.requested_fields,
    })));
  }
  return checks;
}

function createAuditBrief(snapshot, answers = null, confirmed = false) {
  return {
    schema_version: AUDIT_BRIEF_SCHEMA,
    project: {
      name: snapshot.project.name,
      type: snapshot.project.type,
      package_manager: snapshot.project.package_manager,
      source: "discovered",
      confirmed: true,
    },
    intended_environment: {
      value: answers?.intended_environment ?? null,
      candidates: [],
      confirmed,
    },
    production_targets: {
      values: answers?.production_targets ?? [],
      candidates: [],
      confirmed,
    },
    core_journeys: {
      values: answers?.core_journeys ?? [],
      candidates: journeyCandidates(snapshot.project),
      confirmed,
    },
    provider_roles: {
      values: answers?.provider_roles ?? [],
      candidates: providerCandidates(snapshot.project),
      confirmed,
    },
    support_layers: {
      values: answers?.support_layers ?? [],
      candidates: supportCandidates(snapshot.project),
      confirmed,
    },
    public_verification: createPublicVerificationPlan(answers),
    authenticated_journeys: createAuthenticatedJourneyPlan(answers),
    provider_adapters: createProviderAdapterPlan(answers?.provider_roles),
    planned_checks: plannedChecks(answers),
  };
}

function inputFields(auditBrief) {
  return [
    {
      field_id: "intended_environment",
      value_type: "string",
      prompt: "Which environment is this Audit preparing for?",
      candidates: [],
      current_value: auditBrief.intended_environment.value,
    },
    {
      field_id: "production_targets",
      value_type: "url_array",
      prompt: "Which confirmed public target URLs are in scope?",
      candidates: [],
      current_value: auditBrief.production_targets.values,
    },
    {
      field_id: "core_journeys",
      value_type: "journey_array",
      prompt: "Which GET paths and user journeys must work for this release?",
      candidates: auditBrief.core_journeys.candidates,
      current_value: auditBrief.core_journeys.values,
    },
    {
      field_id: "provider_roles",
      value_type: "provider_role_array",
      prompt: "Which Providers and roles belong to this release?",
      candidates: auditBrief.provider_roles.candidates,
      current_value: auditBrief.provider_roles.values,
    },
    {
      field_id: "support_layers",
      value_type: "string_array",
      prompt: "Which support layers should the Audit include?",
      candidates: auditBrief.support_layers.candidates,
      current_value: auditBrief.support_layers.values,
    },
  ];
}

function interactionMetadata(state) {
  return {
    schema_version: AUDIT_INTERACTION_SCHEMA,
    interaction_id: state.interaction_id,
    revision: state.revision,
    resume_token: encodeResumeState(state),
  };
}

function createNeedsInput(snapshot, state, validationErrors = []) {
  const auditBrief = createAuditBrief(snapshot, state.answers);

  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "needs_input",
    operation: "audit",
    snapshot,
    audit_brief: auditBrief,
    interaction: interactionMetadata(state),
    request: {
      type: "input",
      fields: inputFields(auditBrief),
      validation_errors: validationErrors,
    },
  };
}

function authorizationPlan(answers) {
  const publicPlan = createPublicVerificationPlan(answers);
  const authenticatedPlan = createAuthenticatedJourneyPlan(answers);
  const providerPlan = createProviderAdapterPlan(answers.provider_roles);
  return [
    {
      permission_id: "local_safe_scan",
      boundary: "local_scan",
      decision: "granted",
      basis: "audit_start",
      scope: { root: "selected_audit_root" },
    },
    {
      permission_id: "public_verification",
      boundary: "public_network",
      decision: "pending",
      scope: { targets: publicPlan.targets, probes: publicPlan.probes },
    },
    ...(authenticatedPlan.journeys.length > 0 ? [{
      permission_id: "authenticated_journey_verification",
      boundary: "authenticated_network_read",
      decision: "pending",
      scope: authenticatedPlan,
    }] : []),
    ...providerPlan.requests.map(
      (request) => ({
        permission_id: request.permission_id,
        boundary: "provider_read",
        decision: "pending",
        scope: {
          provider: request.provider,
          adapter_version: request.adapter_version,
          operation: request.operation,
          target: request.target,
          requested_fields: request.requested_fields,
          command: request.command,
          commands: request.commands,
        },
      }),
    ),
  ];
}

function createNeedsConfirmation(snapshot, state) {
  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "needs_confirmation",
    operation: "audit",
    snapshot,
    audit_brief: createAuditBrief(snapshot, state.answers),
    authorization_plan: authorizationPlan(state.answers),
    interaction: interactionMetadata(state),
    request: {
      type: "confirmation",
      confirmation_id: "audit_scope",
      prompt: "Confirm this Audit Brief and complete Check plan before permissions are requested.",
      choices: ["confirm", "revise", "cancel"],
    },
  };
}

function createNeedsPermission(snapshot, state) {
  const pendingPermissions = state.permissions.filter(
    (permission) => permission.decision === "pending",
  );
  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "needs_permission",
    operation: "audit",
    snapshot,
    audit_brief: createAuditBrief(snapshot, state.answers, true),
    authorization_plan: state.permissions,
    interaction: interactionMetadata(state),
    request: {
      type: "permission",
      permissions: pendingPermissions,
    },
  };
}

function createNeedsAuthenticatedJourneyResults(snapshot, state, validationErrors = []) {
  const plan = state.permissions.find(
    ({ permission_id }) => permission_id === "authenticated_journey_verification",
  ).scope;
  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "needs_input",
    operation: "audit",
    snapshot,
    audit_brief: createAuditBrief(snapshot, state.answers, true),
    authorization_plan: state.permissions,
    interaction: interactionMetadata(state),
    request: {
      ...createAuthenticatedJourneyResultRequest(plan),
      validation_errors: validationErrors,
    },
  };
}

function permissionError(error, message) {
  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "execution_error",
    operation: "audit",
    error,
    message,
  };
}

export function createInitialAuditInteraction(snapshot) {
  const state = {
    schema_version: AUDIT_INTERACTION_SCHEMA,
    interaction_id: randomUUID(),
    revision: 1,
    root: snapshot.project.root,
    phase: "input",
  };
  return createNeedsInput(snapshot, state);
}

export function advanceAuditInteraction(snapshot, options) {
  const state = decodeResumeState(options.resume_token);
  if (!state) {
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "execution_error",
      operation: "audit",
      error: "invalid_resume_token",
      message: "The Audit interaction token is invalid or corrupted.",
    };
  }
  if (state.root !== snapshot.project.root) {
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "execution_error",
      operation: "audit",
      error: "resume_scope_mismatch",
      message: "The Audit interaction belongs to a different repository root.",
    };
  }

  if (state.phase === "input") {
    if (!options.answers) return createNeedsInput(snapshot, state);
    const normalized = normalizeAnswers(options.answers);
    if (normalized.errors.length > 0) {
      return createNeedsInput(snapshot, state, normalized.errors);
    }
    const nextState = {
      ...state,
      phase: "confirmation",
      revision: state.revision + 1,
      answers: normalized.answers,
    };
    return createNeedsConfirmation(snapshot, nextState);
  }

  if (state.phase === "confirmation") {
    if (!options.confirmation) return createNeedsConfirmation(snapshot, state);
    if (options.confirmation === "revise") {
      return createNeedsInput(snapshot, {
        ...state,
        phase: "input",
        revision: state.revision + 1,
      });
    }
    if (options.confirmation === "cancel") {
      return {
        contract: CLI_INTERACTION_CONTRACT,
        status: "completed",
        operation: "audit",
        outcome: "scope_not_confirmed",
        snapshot,
        audit_brief: createAuditBrief(snapshot, state.answers),
        authorization_plan: authorizationPlan(state.answers),
        report: null,
      };
    }
    if (options.confirmation !== "confirm") {
      return {
        contract: CLI_INTERACTION_CONTRACT,
        status: "execution_error",
        operation: "audit",
        error: "invalid_confirmation",
        message: "The Audit confirmation decision is invalid.",
      };
    }
    const nextState = {
      ...state,
      phase: "permission",
      revision: state.revision + 1,
      confirmed: true,
      permissions: authorizationPlan(state.answers),
    };
    return createNeedsPermission(snapshot, nextState);
  }

  if (state.phase === "permission") {
    const decisions = options.permission_decisions;
    if (decisions !== undefined && (!decisions || typeof decisions !== "object" || Array.isArray(decisions))) {
      return permissionError(
        "invalid_permission_decision",
        "Permission decisions must be an object keyed by permission ID.",
      );
    }

    const permissions = state.permissions.map((permission) => ({ ...permission }));
    const byId = new Map(permissions.map((permission) => [permission.permission_id, permission]));
    for (const [permissionId, decision] of Object.entries(decisions ?? {})) {
      const permission = byId.get(permissionId);
      if (!permission || permission.decision === "granted" || !["approved", "denied"].includes(decision)) {
        return permissionError(
          "invalid_permission_decision",
          "A permission decision does not match the disclosed authorization plan.",
        );
      }
      if (permission.decision !== "pending" && permission.decision !== decision) {
        return permissionError(
          "permission_decision_conflict",
          "A decided permission cannot be changed while resuming an Audit.",
        );
      }
      permission.decision = decision;
      if (
        permission.permission_id === "authenticated_journey_verification"
        && decision === "approved"
        && !permission.scope.collection_not_before
      ) {
        permission.scope.collection_not_before = new Date().toISOString();
      }
    }

    const nextState = {
      ...state,
      revision: state.revision + 1,
      permissions,
    };
    if (permissions.some((permission) => permission.decision === "pending")) {
      return createNeedsPermission(snapshot, nextState);
    }
    if (permissions.some(
      ({ permission_id, decision }) =>
        permission_id === "authenticated_journey_verification" && decision === "approved",
    )) {
      return createNeedsAuthenticatedJourneyResults(snapshot, {
        ...nextState,
        phase: "authenticated_results",
      });
    }
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "completed",
      operation: "audit",
      outcome: "audit_completed",
      snapshot,
      audit_brief: createAuditBrief(snapshot, state.answers, true),
      authorization_plan: permissions,
      interaction: {
        schema_version: AUDIT_INTERACTION_SCHEMA,
        interaction_id: state.interaction_id,
        revision: nextState.revision,
      },
    };
  }

  if (state.phase === "authenticated_results") {
    if (!options.journey_results) {
      return createNeedsAuthenticatedJourneyResults(snapshot, state);
    }
    const plan = state.permissions.find(
      ({ permission_id }) => permission_id === "authenticated_journey_verification",
    ).scope;
    let authenticatedResult;
    try {
      authenticatedResult = normalizeAuthenticatedJourneyResults(plan, options.journey_results);
    } catch (error) {
      return createNeedsAuthenticatedJourneyResults(snapshot, state, [{
        field_id: "journey_results",
        code: error.code ?? "invalid_authenticated_journey_results",
      }]);
    }
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "completed",
      operation: "audit",
      outcome: "audit_completed",
      snapshot,
      audit_brief: createAuditBrief(snapshot, state.answers, true),
      authorization_plan: state.permissions,
      authenticated_result: authenticatedResult,
      interaction: {
        schema_version: AUDIT_INTERACTION_SCHEMA,
        interaction_id: state.interaction_id,
        revision: state.revision + 1,
      },
    };
  }

  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "execution_error",
    operation: "audit",
    error: "invalid_interaction_state",
    message: "The Audit interaction state is not valid for this operation.",
  };
}
