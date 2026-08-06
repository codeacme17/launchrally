import assert from "node:assert/strict";
import test from "node:test";

import {
  describeWebBaselineCatalog,
  executeWebBaseline,
} from "../packages/core/src/check-catalog.js";

const WEB_RISK_DOMAINS = Object.freeze([
  "build_integrity",
  "configuration",
  "deployment",
  "availability",
  "security_and_privacy",
  "data_and_integrations",
  "observability_and_operations",
  "user_experience",
]);

function project(overrides = {}) {
  return {
    type: "web",
    package_manifest: { path: "package.json", status: "valid" },
    script_names: ["build"],
    facts: [
      {
        kind: "package_manifest",
        status: "valid",
        name: "unknown-framework",
        script_names: ["build"],
        provenance: { path: "package.json", collector: "local_safe_scan/v1" },
      },
      {
        kind: "lockfile",
        package_manager: "npm",
        provenance: { path: "package-lock.json", collector: "local_safe_scan/v1" },
      },
    ],
    ...overrides,
  };
}

function auditBrief(overrides = {}) {
  return {
    intended_environment: { value: "production", confirmed: true },
    production_targets: { values: ["https://example.com/"], confirmed: true },
    core_journeys: { values: ["homepage loads"], confirmed: true },
    provider_roles: { values: [], confirmed: true },
    support_layers: { values: [], confirmed: true },
    ...overrides,
  };
}

function execute(projectValue = project(), brief = auditBrief(), publicDecision = "approved") {
  return executeWebBaseline({
    project: projectValue,
    audit_brief: brief,
    authorization_plan: [
      {
        permission_id: "public_verification",
        boundary: "public_network",
        decision: publicDecision,
      },
    ],
  });
}

test("the versioned Web Baseline catalog declares every required policy", () => {
  const catalog = describeWebBaselineCatalog();

  assert.deepEqual(catalog.risk_domains, WEB_RISK_DOMAINS);
  assert.equal(new Set(catalog.risk_domains).size, 8);
  assert.match(catalog.versions.check_catalog, /\/v1$/u);
  assert.match(catalog.versions.baseline, /\/v1$/u);
  assert.deepEqual(catalog.versions.active_profiles, []);
  assert.deepEqual(catalog.versions.active_adapters, []);

  for (const check of catalog.checks) {
    assert.ok(check.applicability.rule);
    assert.ok(check.applicability.required_evidence.length > 0);
    assert.ok(check.required_inputs.length > 0);
    assert.ok(check.evidence_requirement.accepted_kinds.length > 0);
    assert.ok(check.verification_rules.length > 0);
    assert.ok(check.severity_policy.severity);
    assert.ok(check.release_gate_policy.gate);
    assert.ok(check.freshness_behavior.mode);
  }
  assert.deepEqual(
    [...new Set(catalog.checks.map((check) => check.risk_domain))].sort(),
    [...WEB_RISK_DOMAINS].sort(),
  );
});

test("an unknown conventional Web framework reaches the Baseline without unsupported status", () => {
  const result = execute(project({ type: "unknown" }));

  assert.equal(result.checks.length, 9);
  assert.equal(result.domain_coverage.length, 8);
  assert.equal(result.checks.some((check) => check.status === "unsupported"), false);
  assert.equal(
    result.checks.find((check) => check.check_id === "web.baseline.package-manifest").status,
    "passed",
  );
  assert.equal(
    result.checks.find((check) => check.check_id === "web.baseline.lockfile").status,
    "passed",
  );
  assert.equal(
    result.checks.find((check) => check.check_id === "web.baseline.build-command").status,
    "passed",
  );
});

test("unknown facts and missing public observations produce reasoned Verification Gaps", () => {
  const result = execute();
  const runtime = result.checks.find(
    (check) => check.check_id === "web.baseline.runtime-inputs",
  );
  const availability = result.checks.find(
    (check) => check.check_id === "web.public.availability",
  );

  assert.equal(runtime.status, "unverified");
  assert.equal(runtime.reason_code, "missing_required_input");
  assert.equal(availability.status, "unverified");
  assert.equal(availability.reason_code, "partial_public_evidence");
  assert.ok(result.verification_gaps.every((gap) => gap.reason.length > 0));
});

test("Not Applicable requires a reason and applicability evidence", () => {
  const projectWithNonDataInputs = project({
    facts: [
      ...project().facts,
      {
        kind: "environment_variables",
        names: ["API_TOKEN"],
        provenance: { path: ".env.example", collector: "local_safe_scan/v1" },
      },
    ],
  });
  const result = execute(projectWithNonDataInputs);

  for (const checkId of ["web.baseline.data-state", "web.baseline.observability"]) {
    const check = result.checks.find((candidate) => candidate.check_id === checkId);
    assert.equal(check.status, "not_applicable");
    assert.equal(check.applicability.status, "not_applicable");
    assert.ok(check.applicability.reason.length > 0);
    assert.ok(check.applicability.evidence.length > 0);
  }
});

test("conflicts, permission denials, and execution failures never become Passed", () => {
  const conflicting = project({
    facts: [
      ...project().facts,
      {
        kind: "lockfile",
        package_manager: "yarn",
        provenance: { path: "yarn.lock", collector: "local_safe_scan/v1" },
      },
    ],
  });
  const conflictResult = execute(conflicting);
  const lockfile = conflictResult.checks.find(
    (check) => check.check_id === "web.baseline.lockfile",
  );
  assert.equal(lockfile.status, "unverified");
  assert.equal(lockfile.reason_code, "conflicting_evidence");

  const deniedResult = execute(project(), auditBrief(), "denied");
  assert.ok(deniedResult.checks
    .filter((check) => check.check_id.startsWith("web.public."))
    .every((check) => check.status !== "passed"));
  assert.ok(
    deniedResult.verification_gaps
      .filter((gap) => gap.check_id.startsWith("web.public."))
      .every((gap) => gap.reason_code === "permission_denied"),
  );

  const throwingProject = new Proxy(project(), {
    get(target, property, receiver) {
      if (property === "script_names") throw new Error("simulated executor failure");
      return Reflect.get(target, property, receiver);
    },
  });
  const failureResult = execute(throwingProject);
  const build = failureResult.checks.find(
    (check) => check.check_id === "web.baseline.build-command",
  );
  assert.equal(build.status, "unverified");
  assert.equal(build.reason_code, "execution_failure");

  const skippedResult = execute(project({
    safe_scan: { errors: [{ code: "unreadable" }] },
  }));
  assert.ok(skippedResult.checks
    .filter((check) => check.check_id.startsWith("web.baseline."))
    .every((check) => check.status === "unverified"));
  assert.ok(skippedResult.verification_gaps.some(
    (gap) => gap.reason_code === "execution_skipped",
  ));
});
