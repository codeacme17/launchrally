import { createHash, randomUUID } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { open } from "node:fs/promises";
import https from "node:https";
import path from "node:path";

import {
  AUTHENTICATED_JOURNEY_ADAPTER_VERSION,
  AUTHENTICATED_JOURNEY_ATTESTATION_SCHEMA,
  AUTHENTICATED_JOURNEY_EVIDENCE_SCHEMA,
  AUTHENTICATED_JOURNEY_PLAN_SCHEMA,
  AUTHENTICATED_JOURNEY_RESULTS_SCHEMA,
  PROTECTED_JOURNEY_SCHEMA,
} from "@launchrally/contracts";

import { parsePublicJourneyInput } from "./public-journey.js";

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
const COLLECTION_WINDOW_MS = 15 * 60 * 1000;
const REQUESTED_FIELDS = Object.freeze([
  "journey_id",
  "status",
  "outcome",
  "status_code",
  "collected_at",
]);
const TRUSTED_HOST_RUNS = new WeakSet();

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

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(
    (key) => [key, canonicalValue(value[key])],
  ));
}

function digest(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex")}`;
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
      const parsed = parsePublicJourneyInput(journey, { allowDescription: false });
      if (parsed.error) return;
      const protectedJourney = parsed.value;
      const exactTarget = new URL(protectedJourney.path, origin);
      if (
        exactTarget.origin !== origin
        || exactTarget.pathname !== protectedJourney.path
        || exactTarget.search
        || exactTarget.hash
      ) return;
      protectedJourneys.push({
        journey_id: `target-${targetIndex + 1}:journey-${journeyIndex + 1}:authenticated`,
        target: exactTarget.toString(),
        method: protectedJourney.method,
        purpose: protectedJourney.purpose,
        authentication_class: protectedJourney.access.authentication_class,
        expected_status_codes: structuredClone(
          protectedJourney.access.authenticated_status_codes,
        ),
      });
    });
  });

  return {
    schema_version: AUTHENTICATED_JOURNEY_PLAN_SCHEMA,
    adapter_version: AUTHENTICATED_JOURNEY_ADAPTER_VERSION,
    operation: "read_only",
    requested_fields: [...REQUESTED_FIELDS],
    journeys: protectedJourneys,
  };
}

export function bindAuthenticatedJourneyPermission(plan, grantedAt = new Date()) {
  const start = grantedAt.valueOf();
  if (!Number.isFinite(start)) throw invalidResults();
  return {
    ...structuredClone(plan),
    collection_not_before: new Date(start).toISOString(),
    collection_not_after: new Date(start + COLLECTION_WINDOW_MS).toISOString(),
  };
}

export function createAuthenticatedJourneyResultRequest(plan) {
  return {
    type: "authenticated_journey_results",
    result_schema: AUTHENTICATED_JOURNEY_RESULTS_SCHEMA,
    plan: structuredClone(plan),
    allowed_outcomes: [...AUTHENTICATED_JOURNEY_OUTCOMES],
    attestation: {
      schema_version: AUTHENTICATED_JOURNEY_ATTESTATION_SCHEMA,
      required_for_evidence: true,
      verification: "external_host_adapter",
    },
  };
}

export function createAuthenticatedJourneyAttestation(plan, supplied, {
  attestation_id,
  issued_at,
} = {}) {
  const normalizedResults = {
    schema_version: supplied?.schema_version,
    adapter_version: supplied?.adapter_version,
    results: structuredClone(supplied?.results),
  };
  return {
    schema_version: AUTHENTICATED_JOURNEY_ATTESTATION_SCHEMA,
    adapter_version: AUTHENTICATED_JOURNEY_ADAPTER_VERSION,
    attestation_id,
    request_digest: digest(plan),
    result_digest: digest(normalizedResults),
    issued_at,
  };
}

function invalidHostBridge(message) {
  const error = new Error(message);
  error.code = "invalid_authenticated_journey_host_bridge";
  return error;
}

async function readRestrictedHostFile(reference, { maxSize, requirePrivate }) {
  if (!reference) return null;
  if (process.platform === "win32" || fileConstants.O_NOFOLLOW === undefined) {
    throw invalidHostBridge(
      "Restricted authentication-file references are unavailable on this platform.",
    );
  }
  if (!path.isAbsolute(reference)) throw invalidHostBridge(
    "Host authentication references must be absolute paths.",
  );
  let handle;
  try {
    handle = await open(
      reference,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
    );
    const metadata = await handle.stat();
    if (
      !metadata.isFile()
      || metadata.size < 1
      || metadata.size > maxSize
      || (requirePrivate ? (metadata.mode & 0o077) !== 0 : (metadata.mode & 0o022) !== 0)
      || metadata.uid !== process.getuid()
    ) {
      throw invalidHostBridge("The host authentication reference is not a restricted file.");
    }
    const value = await handle.readFile("utf8");
    if (requirePrivate && (value.trim() !== value || /[\r\n\0]/u.test(value))) {
      throw invalidHostBridge("The host authentication reference contains an invalid value.");
    }
    return value;
  } finally {
    await handle?.close();
  }
}

function readHostSecretReference(reference) {
  return readRestrictedHostFile(reference, { maxSize: 8192, requirePrivate: true });
}

async function hostRequest(journey) {
  const target = new URL(journey.target);
  const configuredOrigin = process.env.LAUNCHRALLY_AUTHENTICATED_ORIGIN;
  const authorizationReference = process.env.LAUNCHRALLY_HOST_AUTHORIZATION_FILE;
  const cookieReference = process.env.LAUNCHRALLY_HOST_COOKIE_FILE;
  if (!authorizationReference && !cookieReference) {
    return Promise.resolve({ outcome: "missing_authentication", statusCode: null });
  }
  if (target.protocol !== "https:" || !configuredOrigin || target.origin !== configuredOrigin) {
    return Promise.resolve({ outcome: "insufficient_capability", statusCode: null });
  }
  let authorization;
  let cookie;
  let certificateAuthority;
  try {
    [authorization, cookie, certificateAuthority] = await Promise.all([
      readHostSecretReference(authorizationReference),
      readHostSecretReference(cookieReference),
      readRestrictedHostFile(process.env.LAUNCHRALLY_HOST_CA_FILE, {
        maxSize: 65536,
        requirePrivate: false,
      }),
    ]);
  } catch {
    return { outcome: "runner_unavailable", statusCode: null };
  }

  return new Promise((resolve) => {
    const request = https.request(target, {
      method: "GET",
      rejectUnauthorized: true,
      ...(certificateAuthority ? { ca: certificateAuthority } : {}),
      headers: {
        accept: "*/*",
        "user-agent": `LaunchRally/${AUTHENTICATED_JOURNEY_ADAPTER_VERSION}`,
        ...(authorization ? { authorization } : {}),
        ...(cookie ? { cookie } : {}),
      },
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      response.destroy();
      if (journey.expected_status_codes.includes(statusCode)) {
        resolve({ outcome: "completed", statusCode });
      } else if (statusCode >= 300 && statusCode <= 399) {
        resolve({ outcome: "redirect", statusCode });
      } else if (statusCode === 401) {
        resolve({ outcome: "expired_authentication", statusCode: null });
      } else if (statusCode >= 400 && statusCode <= 499) {
        resolve({ outcome: "unexpected_denial", statusCode });
      } else {
        resolve({ outcome: "execution_failure", statusCode: null });
      }
    });
    request.setTimeout(5000, () => {
      request.destroy();
      resolve({ outcome: "timeout", statusCode: null });
    });
    request.on("error", () => resolve({ outcome: "execution_failure", statusCode: null }));
    request.end();
  });
}

async function collectHostResults(plan) {
  const results = [];
  for (const journey of plan.journeys) {
    const now = new Date();
    const observation = now < new Date(plan.collection_not_before)
      || now > new Date(plan.collection_not_after)
      ? { outcome: "runner_unavailable", statusCode: null }
      : await hostRequest(journey);
    const status = observation.outcome === "completed"
      ? "passed"
      : UNVERIFIED_OUTCOMES.has(observation.outcome)
        ? "unverified"
        : "failed";
    results.push({
      journey_id: journey.journey_id,
      status,
      outcome: observation.outcome,
      status_code: observation.statusCode,
      collected_at: new Date().toISOString(),
    });
  }
  return results;
}

export async function resumeAuthenticatedJourneyFromHost({
  host,
  version,
  cwd,
  operation,
  resume_token: resumeToken,
  request,
}) {
  if (
    !["codex", "claude"].includes(host)
    || typeof version !== "string"
    || !/^\d+\.\d+\.\d+$/u.test(version)
  ) {
    throw invalidHostBridge("The authenticated Journey host bridge is incomplete.");
  }
  if (
    typeof cwd !== "string"
    || !["audit", "verify"].includes(operation)
    || typeof resumeToken !== "string"
    || request?.type !== "authenticated_journey_results"
    || request?.result_schema !== AUTHENTICATED_JOURNEY_RESULTS_SCHEMA
    || request?.attestation?.schema_version !== AUTHENTICATED_JOURNEY_ATTESTATION_SCHEMA
    || request?.attestation?.required_for_evidence !== true
    || request?.attestation?.verification !== "external_host_adapter"
  ) {
    throw invalidHostBridge("The authenticated Journey host bridge request is invalid.");
  }

  const hostDependencies = {
    collect_authenticated_journey_results: async (boundPlan) => {
      if (digest(boundPlan) !== digest(request.plan)) {
        throw invalidHostBridge(
          "The authenticated Journey host request does not match the resumed permission.",
        );
      }
      const supplied = {
        schema_version: AUTHENTICATED_JOURNEY_RESULTS_SCHEMA,
        adapter_version: AUTHENTICATED_JOURNEY_ADAPTER_VERSION,
        results: await collectHostResults(boundPlan),
      };
      const issuedAt = supplied.results.reduce(
        (latest, result) => result.collected_at > latest ? result.collected_at : latest,
        boundPlan.collection_not_before,
      );
      supplied.attestation = createAuthenticatedJourneyAttestation(boundPlan, supplied, {
        attestation_id: `${host}_observation_${randomUUID().replaceAll("-", "")}`,
        issued_at: issuedAt,
      });
      hostDependencies.expected_attestation = JSON.stringify(supplied.attestation);
      return supplied;
    },
    verify_host_attestation: (attestation) =>
      JSON.stringify(attestation) === hostDependencies.expected_attestation,
  };
  TRUSTED_HOST_RUNS.add(hostDependencies);

  // Resolve the fixed Core entry point here so no Agent-visible callback can
  // capture the host-owned attestation verifier or substitute reported results.
  const core = await import("./index.js");
  const run = operation === "audit" ? core.runAudit : core.runVerify;
  return run(cwd, version, {
    resume_token: resumeToken,
  }, hostDependencies);
}

export async function collectTrustedAuthenticatedJourneyResults(dependencies, plan) {
  if (
    !TRUSTED_HOST_RUNS.has(dependencies)
    || typeof dependencies.collect_authenticated_journey_results !== "function"
  ) return undefined;
  return dependencies.collect_authenticated_journey_results(structuredClone(plan));
}

function hostAttestationIsVerified(dependencies, attestation, plan, results) {
  if (
    !TRUSTED_HOST_RUNS.has(dependencies)
    || typeof dependencies.verify_host_attestation !== "function"
  ) return false;
  try {
    return dependencies.verify_host_attestation(
      structuredClone(attestation),
      { plan: structuredClone(plan), results: structuredClone(results) },
    ) === true;
  } catch {
    return false;
  }
}

function unverifiedAdapterResult(plan, supplied) {
  return {
    evidence: [],
    verification_gaps: plan.journeys.map(({ journey_id: journeyId }) => {
      const result = supplied.results.find(({ journey_id: suppliedId }) =>
        suppliedId === journeyId);
      return {
        journey_id: journeyId,
        outcome: "unsupported_adapter",
        collected_at: result.collected_at,
      };
    }),
  };
}

export function normalizeAuthenticatedJourneyResults(plan, supplied, dependencies = {}) {
  const windowStart = Date.parse(plan?.collection_not_before);
  const windowEnd = Date.parse(plan?.collection_not_after);
  if (
    plan?.schema_version !== AUTHENTICATED_JOURNEY_PLAN_SCHEMA
    || plan?.adapter_version !== AUTHENTICATED_JOURNEY_ADAPTER_VERSION
    || plan?.operation !== "read_only"
    || !Array.isArray(plan?.requested_fields)
    || JSON.stringify(plan.requested_fields) !== JSON.stringify(REQUESTED_FIELDS)
    || !Array.isArray(plan?.journeys)
    || !Number.isFinite(windowStart)
    || !Number.isFinite(windowEnd)
    || windowEnd <= windowStart
    || windowEnd - windowStart > COLLECTION_WINDOW_MS
    || !supplied
    || typeof supplied !== "object"
    || Array.isArray(supplied)
    || !Object.keys(supplied).every((key) => [
      "schema_version",
      "adapter_version",
      "results",
      "attestation",
    ].includes(key))
    || ![3, 4].includes(Object.keys(supplied).length)
    || supplied.schema_version !== AUTHENTICATED_JOURNEY_RESULTS_SCHEMA
    || typeof supplied.adapter_version !== "string"
    || !Array.isArray(supplied.results)
    || supplied.results.length !== plan.journeys.length
  ) {
    throw invalidResults();
  }
  const resultsById = new Map();
  const now = dependencies.now ?? (() => new Date());
  const latestAllowed = Math.min(windowEnd, now().valueOf() + 5 * 60 * 1000);
  const earliestAllowed = windowStart;
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

  const observations = plan.journeys.map((journey) => {
    const result = resultsById.get(journey.journey_id);
    if (!result || !resultMatchesOutcome(result, journey)) throw invalidResults();
    return {
      schema_version: AUTHENTICATED_JOURNEY_EVIDENCE_SCHEMA,
      kind: "authenticated_journey_machine_evidence",
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
        permission_id: "authenticated_journey_verification",
        collection_not_before: plan.collection_not_before,
        collection_not_after: plan.collection_not_after,
      },
    };
  });

  const expectedAttestation = createAuthenticatedJourneyAttestation(plan, supplied, {
    attestation_id: supplied.attestation?.attestation_id,
    issued_at: supplied.attestation?.issued_at,
  });
  const issuedAt = Date.parse(supplied.attestation?.issued_at);
  const latestObservation = Math.max(
    ...supplied.results.map(({ collected_at: collectedAt }) => Date.parse(collectedAt)),
  );
  const attestationValid = supplied.adapter_version === plan.adapter_version
    && exactKeys(supplied.attestation, [
      "schema_version",
      "adapter_version",
      "attestation_id",
      "request_digest",
      "result_digest",
      "issued_at",
    ])
    && supplied.attestation.schema_version === AUTHENTICATED_JOURNEY_ATTESTATION_SCHEMA
    && supplied.attestation.adapter_version === plan.adapter_version
    && typeof supplied.attestation.attestation_id === "string"
    && /^[a-z][a-z0-9_]{2,127}$/u.test(supplied.attestation.attestation_id)
    && isIsoDate(supplied.attestation.issued_at)
    && issuedAt >= latestObservation
    && issuedAt >= windowStart
    && issuedAt <= latestAllowed
    && supplied.attestation.request_digest === expectedAttestation.request_digest
    && supplied.attestation.result_digest === expectedAttestation.result_digest
    && hostAttestationIsVerified(
      dependencies,
      supplied.attestation,
      plan,
      supplied.results,
    );
  if (!attestationValid) return unverifiedAdapterResult(plan, supplied);

  return {
    evidence: observations.filter(({ status }) => status !== "unverified").map((observation) => ({
      ...observation,
      provenance: {
        ...observation.provenance,
        attestation_id: supplied.attestation.attestation_id,
        request_digest: supplied.attestation.request_digest,
        result_digest: supplied.attestation.result_digest,
        verification: "host_adapter_verified",
      },
    })),
    verification_gaps: observations
      .filter(({ status }) => status === "unverified")
      .map(({ journey_id, outcome, collected_at }) => ({
        journey_id,
        outcome,
        collected_at,
      })),
  };
}
