import assert from "node:assert/strict";
import test from "node:test";

import {
  createAuthenticatedJourneyAttestation,
  createAuthenticatedJourneyPlan,
  normalizeAuthenticatedJourneyResults,
} from "../packages/core/src/authenticated-journeys.js";
import { isSafeEvidenceArtifact } from "../packages/core/src/evidence-artifact.js";
import { parsePublicJourneyInput } from "../packages/core/src/public-journey.js";

const ANSWERS = {
  production_targets: ["https://example.com"],
  core_journeys: [{
    schema_version: "launchrally.dev/protected-journey/v1",
    method: "GET",
    path: "/control",
    purpose: "staff Control Room loads",
    access: {
      authentication_class: "staff",
      anonymous_status_codes: [404],
      authenticated_status_codes: [200],
    },
  }],
};

function permissionBoundPlan() {
  return {
    ...createAuthenticatedJourneyPlan(ANSWERS),
    collection_not_before: "2026-08-12T05:59:00.000Z",
    collection_not_after: "2026-08-12T06:14:00.000Z",
  };
}

function attested(plan, results) {
  const supplied = {
    schema_version: "launchrally.dev/authenticated-journey-results/v1",
    adapter_version: "host-agent-authenticated-journey/v1",
    results,
  };
  supplied.attestation = createAuthenticatedJourneyAttestation(plan, supplied, {
    attestation_id: "attestation_host_observation_01",
    issued_at: "2026-08-12T06:00:00.000Z",
  });
  return supplied;
}

const VERIFY_ATTESTATION = { verify_host_attestation: () => true };

test("caller-attested journey results cannot bypass the host runner", () => {
  const plan = permissionBoundPlan();
  const normalized = normalizeAuthenticatedJourneyResults(plan, attested(plan, [{
      journey_id: "target-1:journey-1:authenticated",
      status: "passed",
      outcome: "completed",
      status_code: 200,
      collected_at: "2026-08-12T06:00:00.000Z",
    }]), VERIFY_ATTESTATION);

  assert.deepEqual(normalized.evidence, []);
  assert.equal(normalized.verification_gaps[0].outcome, "unsupported_adapter");
});

test("authenticated journey results preserve typed gaps without auth material", () => {
  const plan = permissionBoundPlan();
  const normalized = normalizeAuthenticatedJourneyResults(plan, attested(plan, [{
      journey_id: "target-1:journey-1:authenticated",
      status: "unverified",
      outcome: "missing_authentication",
      status_code: null,
      collected_at: "2026-08-12T06:00:00.000Z",
    }]), VERIFY_ATTESTATION);

  assert.deepEqual(normalized.evidence, []);
  assert.equal(normalized.verification_gaps[0].outcome, "unsupported_adapter");
});

test("authenticated journey results reject undeclared fields and inconsistent outcomes", () => {
  const plan = permissionBoundPlan();
  const valid = {
    schema_version: "launchrally.dev/authenticated-journey-results/v1",
    adapter_version: "host-agent-authenticated-journey/v1",
    results: [{
      journey_id: "target-1:journey-1:authenticated",
      status: "passed",
      outcome: "completed",
      status_code: 200,
      collected_at: "2026-08-12T06:00:00.000Z",
    }],
  };

  assert.throws(
    () => normalizeAuthenticatedJourneyResults(plan, {
      ...valid,
      results: [{ ...valid.results[0], cookie: "session=secret" }],
    }),
    { code: "invalid_authenticated_journey_results" },
  );
  assert.throws(
    () => normalizeAuthenticatedJourneyResults(plan, {
      ...valid,
      results: [{ ...valid.results[0], status_code: 401 }],
    }),
    { code: "invalid_authenticated_journey_results" },
  );
  assert.throws(
    () => normalizeAuthenticatedJourneyResults(plan, {
      ...valid,
      results: [{
        ...valid.results[0],
        collected_at: "2026-08-12T06:10:01.000Z",
      }],
    }, {
      now: () => new Date("2026-08-12T06:05:00.000Z"),
    }),
    { code: "invalid_authenticated_journey_results" },
  );
});

test("protected journeys may omit an anonymous boundary assertion", () => {
  const parsed = parsePublicJourneyInput({
    schema_version: "launchrally.dev/protected-journey/v1",
    method: "GET",
    path: "/account",
    purpose: "account loads",
    access: {
      authentication_class: "user",
      authenticated_status_codes: [200],
    },
  });

  assert.deepEqual(parsed.value.access, {
    authentication_class: "user",
    authenticated_status_codes: [200],
  });
  assert.equal(parsed.value.purpose, "authenticated Core Journey");
});

test("protected journeys accept application-specific static path segments", () => {
  for (const journeyPath of [
    "/control/moderation",
    "/me/moderation",
    "/me/notifications",
    "/me/notifications/settings",
    "/release-notes",
    "/notification_settings",
    "/oauth2/callback",
    "/account-12345",
    "/patients/john-smith",
    "/users/alice",
  ]) {
    const parsed = parsePublicJourneyInput({
      schema_version: "launchrally.dev/protected-journey/v1",
      method: "GET",
      path: journeyPath,
      purpose: `${journeyPath} loads`,
      access: {
        authentication_class: "user",
        authenticated_status_codes: [200],
      },
    });

    assert.equal(parsed.value?.path, journeyPath);
    assert.equal(parsed.value?.purpose, "authenticated Core Journey");
  }
});

test("protected journey declarations reject only defensible identifier shapes", () => {
  for (const candidate of [
    { path: "/users/alice@example.com", purpose: "account loads" },
    { path: "/orders/12345678", purpose: "order loads" },
    { path: "/orders/550e8400-e29b-41d4-a716-446655440000", purpose: "order loads" },
    { path: "/sessions/0123456789abcdef0123456789abcdef", purpose: "session loads" },
    { path: "/", purpose: "account loads" },
    { path: "/account/", purpose: "account loads" },
  ]) {
    const parsed = parsePublicJourneyInput({
      schema_version: "launchrally.dev/protected-journey/v1",
      method: "GET",
      ...candidate,
      access: {
        authentication_class: "user",
        authenticated_status_codes: [200],
      },
    });
    assert.equal(parsed.error, "invalid_protected_journey");
  }
  const normalized = parsePublicJourneyInput({
    schema_version: "launchrally.dev/protected-journey/v1",
    method: "GET",
    path: "/control",
    purpose: "John Smith patient profile loads",
    access: {
      authentication_class: "user",
      authenticated_status_codes: [200],
    },
  });
  assert.equal(normalized.value.purpose, "authenticated Core Journey");
});

test("protected journeys report the exact rejected safety constraint", () => {
  for (const [method, journeyPath, reasonCode, guidance] of [
    ["POST", "/control/moderation", "non_get_method", /supports only GET/u],
    ["GET", "/", "root_path", /non-root path/u],
    ["GET", "//example.com/control", "protocol_relative_path", /protocol-relative paths/u],
    ["GET", "/control/../moderation", "dot_or_traversal_segment", /dot and traversal segments/u],
    ["GET", "/control//moderation", "empty_or_trailing_segment", /empty or trailing segments/u],
    ["GET", "/control/", "empty_or_trailing_segment", /empty or trailing segments/u],
    ["GET", "/control\\moderation", "backslash_path", /backslashes/u],
    ["GET", "/control/moderation?view=queue", "query_or_fragment", /queries or fragments/u],
    ["GET", "/control/moderation#queue", "query_or_fragment", /queries or fragments/u],
    ["GET", "/control/%6doderation", "percent_encoded_path", /percent-encoded paths/u],
    ["GET", "https://user:password@example.com/control", "credentialed_target", /credentials/u],
    ["GET", "https://other.example/control", "absolute_or_out_of_origin_target", /absolute or out-of-origin targets/u],
    ["GET", "/users/:id", "dynamic_segment", /dynamic placeholders/u],
    ["GET", "/users/[id]", "dynamic_segment", /dynamic placeholders/u],
    ["GET", "/users/{id}", "dynamic_segment", /dynamic placeholders/u],
    ["GET", "/users/*", "dynamic_segment", /dynamic placeholders/u],
    ["GET", "/orders/12345678", "opaque_segment_shape", /opaque identifier shapes/u],
    ["GET", "/ReleaseNotes", "invalid_static_segment", /lowercase ASCII static segments/u],
  ]) {
    const parsed = parsePublicJourneyInput({
      schema_version: "launchrally.dev/protected-journey/v1",
      method,
      path: journeyPath,
      purpose: "account loads",
      access: {
        authentication_class: "user",
        authenticated_status_codes: [200],
      },
    });

    assert.equal(parsed.error, "invalid_protected_journey", `${method} ${journeyPath}`);
    assert.equal(parsed.reason_code, reasonCode, `${method} ${journeyPath}`);
    assert.match(parsed.guidance, guidance, `${method} ${journeyPath}`);
  }
});

test("authenticated plans preserve only exact validated protected targets", () => {
  const protectedJourney = {
    schema_version: "launchrally.dev/protected-journey/v1",
    method: "GET",
    path: "/me/notifications/settings",
    purpose: "notification settings load",
    access: {
      authentication_class: "user",
      authenticated_status_codes: [200],
    },
  };
  const plan = createAuthenticatedJourneyPlan({
    production_targets: ["https://example.com"],
    core_journeys: [protectedJourney],
  });

  assert.equal(plan.journeys[0].target, "https://example.com/me/notifications/settings");
  for (const journeyPath of [
    "//other.example/control",
    "/control/../moderation",
    "/control\\moderation",
    "/control/moderation?view=queue",
    "/control/moderation#queue",
    "/control/%6doderation",
    "/users/:id",
  ]) {
    const unsafePlan = createAuthenticatedJourneyPlan({
      production_targets: ["https://example.com"],
      core_journeys: [{ ...protectedJourney, path: journeyPath }],
    });
    assert.deepEqual(unsafePlan.journeys, [], journeyPath);
  }
});

test("every caller-supplied authenticated outcome remains unsupported without the host runner", () => {
  const plan = permissionBoundPlan();
  const cases = [
    ["completed", "passed", 200],
    ["missing_authentication", "unverified", null],
    ["insufficient_capability", "unverified", null],
    ["expired_authentication", "unverified", null],
    ["runner_unavailable", "unverified", null],
    ["unexpected_denial", "failed", 403],
    ["redirect", "failed", 302],
    ["timeout", "failed", null],
    ["execution_failure", "failed", null],
  ];

  for (const [outcome, status, statusCode] of cases) {
    const normalized = normalizeAuthenticatedJourneyResults(plan, attested(plan, [{
        journey_id: "target-1:journey-1:authenticated",
        status,
        outcome,
        status_code: statusCode,
        collected_at: "2026-08-12T06:00:00.000Z",
      }]), VERIFY_ATTESTATION);
    assert.deepEqual(normalized.evidence, []);
    assert.equal(normalized.verification_gaps[0].outcome, "unsupported_adapter");
  }
});

test("an Agent or user result assertion cannot substitute for host-adapter collection", () => {
  const plan = permissionBoundPlan();
  const supplied = {
    schema_version: "launchrally.dev/authenticated-journey-results/v1",
    adapter_version: "host-agent-authenticated-journey/v1",
    results: [{
      journey_id: "target-1:journey-1:authenticated",
      status: "failed",
      outcome: "unexpected_denial",
      status_code: 403,
      collected_at: "2026-08-12T06:00:00.000Z",
    }],
  };

  const asserted = normalizeAuthenticatedJourneyResults(plan, supplied);
  assert.deepEqual(asserted.evidence, []);
  assert.equal(asserted.verification_gaps[0].outcome, "unsupported_adapter");

  const forged = attested(plan, supplied.results);
  const rejected = normalizeAuthenticatedJourneyResults(plan, forged, {
    verify_host_attestation: () => false,
  });
  assert.deepEqual(rejected.evidence, []);
  assert.equal(rejected.verification_gaps[0].outcome, "unsupported_adapter");

  const tampered = structuredClone(forged);
  tampered.results[0].collected_at = "2026-08-12T06:00:01.000Z";
  const digestRejected = normalizeAuthenticatedJourneyResults(plan, tampered,
    VERIFY_ATTESTATION);
  assert.deepEqual(digestRejected.evidence, []);
  assert.equal(digestRejected.verification_gaps[0].outcome, "unsupported_adapter");

  const verifierError = normalizeAuthenticatedJourneyResults(plan, forged, {
    verify_host_attestation: () => {
      throw new Error("host adapter unavailable");
    },
  });
  assert.deepEqual(verifierError.evidence, []);
  assert.equal(verifierError.verification_gaps[0].outcome, "unsupported_adapter");
});

test("authenticated observations must be collected after the permission-bound request", () => {
  const plan = {
    ...permissionBoundPlan(),
    collection_not_before: "2026-08-12T06:00:01.000Z",
  };

  assert.throws(() => normalizeAuthenticatedJourneyResults(plan, {
    schema_version: "launchrally.dev/authenticated-journey-results/v1",
    adapter_version: "host-agent-authenticated-journey/v1",
    results: [{
      journey_id: "target-1:journey-1:authenticated",
      status: "passed",
      outcome: "completed",
      status_code: 200,
      collected_at: "2026-08-12T06:00:00.000Z",
    }],
  }), { code: "invalid_authenticated_journey_results" });
});

test("authenticated observations require a fresh declared permission window", () => {
  const supplied = {
    schema_version: "launchrally.dev/authenticated-journey-results/v1",
    adapter_version: "host-agent-authenticated-journey/v1",
    results: [{
      journey_id: "target-1:journey-1:authenticated",
      status: "passed",
      outcome: "completed",
      status_code: 200,
      collected_at: "2026-08-12T06:15:00.000Z",
    }],
  };

  assert.throws(
    () => normalizeAuthenticatedJourneyResults(createAuthenticatedJourneyPlan(ANSWERS), supplied),
    { code: "invalid_authenticated_journey_results" },
  );
  assert.throws(
    () => normalizeAuthenticatedJourneyResults(permissionBoundPlan(), supplied),
    { code: "invalid_authenticated_journey_results" },
  );
});

test("legacy authenticated Journey artifacts reject authority backslashes", () => {
  const target = "https://example.com\\evil/control";
  assert.equal(isSafeEvidenceArtifact({
    kind: "authenticated_journey_observation",
    journey_id: "target-1:journey-1:authenticated",
    target,
    method: "GET",
    purpose: "authenticated Core Journey",
    authentication_class: "user",
    status: "unverified",
    outcome: "runner_unavailable",
    status_code: null,
    collected_at: "2026-08-12T06:00:00.000Z",
    provenance: {
      collector: "host-agent-authenticated-journey/v1",
      exact_target: target,
      collected_at: "2026-08-12T06:00:00.000Z",
    },
  }), false);
});
