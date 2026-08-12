import {
  AUTHENTICATED_JOURNEY_ADAPTER_VERSION,
  AUTHENTICATED_JOURNEY_PLAN_SCHEMA,
  AUTHENTICATED_JOURNEY_RESULTS_SCHEMA,
  PROTECTED_JOURNEY_SCHEMA,
} from "@launchrally/contracts";

export { AUTHENTICATED_JOURNEY_RESULTS_SCHEMA };
export const AUTHENTICATED_JOURNEY_OUTCOMES = Object.freeze([
  "completed",
  "missing_authentication",
  "insufficient_capability",
  "expired_authentication",
  "runner_unavailable",
  "unexpected_denial",
  "redirect",
  "timeout",
  "execution_failure",
]);
const UNVERIFIED_OUTCOMES = new Set([
  "missing_authentication",
  "insufficient_capability",
  "expired_authentication",
  "runner_unavailable",
]);
const FAILED_OUTCOMES = new Set([
  "unexpected_denial",
  "redirect",
  "timeout",
  "execution_failure",
]);

function exactKeys(value, expected) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function invalidResults() {
  const error = new Error(
    "Authenticated journey results must contain only the disclosed normalized fields.",
  );
  error.code = "invalid_authenticated_journey_results";
  return error;
}

function isIsoDate(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function resultMatchesOutcome(result, planJourney) {
  if (result.outcome === "completed") {
    return result.status === "passed"
      && planJourney.expected_status_codes.includes(result.status_code);
  }
  if (UNVERIFIED_OUTCOMES.has(result.outcome)) {
    return result.status === "unverified" && result.status_code === null;
  }
  if (result.outcome === "unexpected_denial") {
    return result.status === "failed"
      && Number.isInteger(result.status_code)
      && result.status_code >= 400
      && result.status_code <= 499;
  }
  if (result.outcome === "redirect") {
    return result.status === "failed"
      && Number.isInteger(result.status_code)
      && result.status_code >= 300
      && result.status_code <= 399;
  }
  return FAILED_OUTCOMES.has(result.outcome)
    && result.status === "failed"
    && result.status_code === null;
}

export function isProtectedJourney(journey) {
  return journey?.schema_version === PROTECTED_JOURNEY_SCHEMA;
}

export function createAuthenticatedJourneyPlan(answers) {
  const targets = answers?.production_targets ?? [];
  const journeys = answers?.core_journeys ?? [];
  const protectedJourneys = [];

  targets.forEach((target, targetIndex) => {
    const origin = new URL(target).origin;
    journeys.forEach((journey, journeyIndex) => {
      if (!isProtectedJourney(journey)) return;
      protectedJourneys.push({
        journey_id: `target-${targetIndex + 1}:journey-${journeyIndex + 1}:authenticated`,
        target: new URL(journey.path, origin).toString(),
        method: journey.method,
        purpose: journey.purpose,
        authentication_class: journey.access.authentication_class,
        expected_status_codes: structuredClone(journey.access.authenticated_status_codes),
      });
    });
  });

  return {
    schema_version: AUTHENTICATED_JOURNEY_PLAN_SCHEMA,
    adapter_version: AUTHENTICATED_JOURNEY_ADAPTER_VERSION,
    operation: "read_only",
    requested_fields: ["journey_id", "status", "outcome", "status_code", "collected_at"],
    journeys: protectedJourneys,
  };
}

export function createAuthenticatedJourneyResultRequest(plan) {
  return {
    type: "authenticated_journey_results",
    result_schema: AUTHENTICATED_JOURNEY_RESULTS_SCHEMA,
    plan: structuredClone(plan),
    allowed_outcomes: [...AUTHENTICATED_JOURNEY_OUTCOMES],
  };
}

export function normalizeAuthenticatedJourneyResults(plan, supplied, dependencies = {}) {
  if (
    !exactKeys(supplied, ["schema_version", "adapter_version", "results"])
    || supplied.schema_version !== AUTHENTICATED_JOURNEY_RESULTS_SCHEMA
    || supplied.adapter_version !== plan.adapter_version
    || !Array.isArray(supplied.results)
    || supplied.results.length !== plan.journeys.length
  ) {
    throw invalidResults();
  }
  const resultsById = new Map();
  const now = dependencies.now ?? (() => new Date());
  const latestAllowed = now().valueOf() + 5 * 60 * 1000;
  const earliestAllowed = plan.collection_not_before
    ? new Date(plan.collection_not_before).valueOf()
    : Number.NEGATIVE_INFINITY;
  for (const result of supplied.results) {
    if (
      !exactKeys(result, [
        "journey_id",
        "status",
        "outcome",
        "status_code",
        "collected_at",
      ])
      || resultsById.has(result.journey_id)
      || !isIsoDate(result.collected_at)
      || new Date(result.collected_at).valueOf() < earliestAllowed
      || new Date(result.collected_at).valueOf() > latestAllowed
    ) {
      throw invalidResults();
    }
    resultsById.set(result.journey_id, result);
  }

  const evidence = plan.journeys.map((journey) => {
    const result = resultsById.get(journey.journey_id);
    if (!result || !resultMatchesOutcome(result, journey)) throw invalidResults();
    return {
      kind: "authenticated_journey_observation",
      journey_id: journey.journey_id,
      target: journey.target,
      method: journey.method,
      purpose: journey.purpose,
      authentication_class: journey.authentication_class,
      status: result.status,
      outcome: result.outcome,
      status_code: result.status_code,
      collected_at: result.collected_at,
      provenance: {
        collector: plan.adapter_version,
        exact_target: journey.target,
        collected_at: result.collected_at,
      },
    };
  });

  return {
    evidence,
    verification_gaps: evidence
      .filter(({ outcome }) => outcome !== "completed")
      .map(({ journey_id, outcome }) => ({ journey_id, outcome })),
  };
}
