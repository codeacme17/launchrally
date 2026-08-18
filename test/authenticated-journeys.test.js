import assert from "node:assert/strict";
import test from "node:test";

import {
  createAuthenticatedJourneyAttestation,
  createAuthenticatedJourneyPlan,
  normalizeAuthenticatedJourneyResults,
} from "../packages/core/src/authenticated-journeys.js";
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

test("protected journey declarations reject personal identifiers before persistence", () => {
  for (const candidate of [
    { path: "/users/alice@example.com", purpose: "account loads" },
    { path: "/account-12345", purpose: "account loads" },
    { path: "/orders/12345678", purpose: "order loads" },
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

test("protected journeys reject unsafe and parameterized targets", () => {
  for (const [method, journeyPath] of [
    ["POST", "/control/moderation"],
    ["GET", "/"],
    ["GET", "//example.com/control"],
    ["GET", "/control/../moderation"],
    ["GET", "/control\\moderation"],
    ["GET", "/control/moderation?view=queue"],
    ["GET", "/control/moderation#queue"],
    ["GET", "/control/%6doderation"],
    ["GET", "https://user:password@example.com/control"],
    ["GET", "https://other.example/control"],
    ["GET", "/users/:id"],
    ["GET", "/users/[id]"],
    ["GET", "/users/{id}"],
    ["GET", "/users/*"],
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
