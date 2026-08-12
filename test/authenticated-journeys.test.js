import assert from "node:assert/strict";
import test from "node:test";

import {
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

test("authenticated journey results normalize only allowlisted observations", () => {
  const plan = createAuthenticatedJourneyPlan(ANSWERS);
  const normalized = normalizeAuthenticatedJourneyResults(plan, {
    schema_version: "launchrally.dev/authenticated-journey-results/v1",
    adapter_version: "host-agent-authenticated-journey/v1",
    results: [{
      journey_id: "target-1:journey-1:authenticated",
      status: "passed",
      outcome: "completed",
      status_code: 200,
      collected_at: "2026-08-12T06:00:00.000Z",
    }],
  });

  assert.deepEqual(normalized.verification_gaps, []);
  assert.deepEqual(normalized.evidence, [{
    kind: "authenticated_journey_observation",
    journey_id: "target-1:journey-1:authenticated",
    target: "https://example.com/control",
    method: "GET",
    purpose: "staff Control Room loads",
    authentication_class: "staff",
    status: "passed",
    outcome: "completed",
    status_code: 200,
    collected_at: "2026-08-12T06:00:00.000Z",
    provenance: {
      collector: "host-agent-authenticated-journey/v1",
      exact_target: "https://example.com/control",
      collected_at: "2026-08-12T06:00:00.000Z",
    },
  }]);
});

test("authenticated journey results preserve typed gaps without auth material", () => {
  const plan = createAuthenticatedJourneyPlan(ANSWERS);
  const normalized = normalizeAuthenticatedJourneyResults(plan, {
    schema_version: "launchrally.dev/authenticated-journey-results/v1",
    adapter_version: "host-agent-authenticated-journey/v1",
    results: [{
      journey_id: "target-1:journey-1:authenticated",
      status: "unverified",
      outcome: "missing_authentication",
      status_code: null,
      collected_at: "2026-08-12T06:00:00.000Z",
    }],
  });

  assert.equal(normalized.evidence[0].outcome, "missing_authentication");
  assert.deepEqual(normalized.verification_gaps, [{
    journey_id: "target-1:journey-1:authenticated",
    outcome: "missing_authentication",
  }]);
});

test("authenticated journey results reject undeclared fields and inconsistent outcomes", () => {
  const plan = createAuthenticatedJourneyPlan(ANSWERS);
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
});

test("every disclosed authenticated journey outcome has a normalized contract path", () => {
  const plan = createAuthenticatedJourneyPlan(ANSWERS);
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
    const normalized = normalizeAuthenticatedJourneyResults(plan, {
      schema_version: "launchrally.dev/authenticated-journey-results/v1",
      adapter_version: "host-agent-authenticated-journey/v1",
      results: [{
        journey_id: "target-1:journey-1:authenticated",
        status,
        outcome,
        status_code: statusCode,
        collected_at: "2026-08-12T06:00:00.000Z",
      }],
    });
    assert.equal(normalized.evidence[0].outcome, outcome);
    assert.equal(normalized.evidence[0].status, status);
  }
});

test("authenticated observations must be collected after the permission-bound request", () => {
  const plan = {
    ...createAuthenticatedJourneyPlan(ANSWERS),
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
