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
    root: "/tmp/launchrally-check-catalog",
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
    safe_scan: {
      policy_version: "local_safe_scan/v1",
      exclusions: {},
      errors: [],
      coverage: { root_lockfiles: { complete: true, uncovered: [] } },
    },
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

function execute(
  projectValue = project(),
  brief = auditBrief(),
  publicDecision = "approved",
  providerResult = { evidence: [], verification_gaps: [] },
) {
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
    provider_result: providerResult,
  });
}

test("the versioned Web Baseline catalog declares every required policy", () => {
  const catalog = describeWebBaselineCatalog();

  assert.deepEqual(catalog.risk_domains, WEB_RISK_DOMAINS);
  assert.equal(new Set(catalog.risk_domains).size, 8);
  assert.match(catalog.versions.check_catalog, /\/v2$/u);
  assert.match(catalog.versions.baseline, /\/v1$/u);
  assert.deepEqual(catalog.versions.active_profiles, []);
  assert.deepEqual(catalog.versions.active_adapters, []);

  for (const check of catalog.checks) {
    assert.ok(check.applicability.rule);
    assert.ok(check.applicability.required_evidence.length > 0);
    assert.ok(check.required_inputs.length > 0);
    assert.ok(check.pass_evidence_requirement.accepted_kinds.length > 0);
    assert.ok(check.failure_evidence_requirement.accepted_kinds.length > 0);
    assert.ok(check.verification_rules.length > 0);
    assert.ok(check.severity_policy.severity);
    assert.ok(check.release_gate_policy.gate);
    assert.ok(check.freshness_behavior.mode);
    assert.equal(
      typeof check.remediation_order_policy.dependency_unblocking,
      "boolean",
    );
    assert.ok(["direct", "indirect", "none"].includes(
      check.remediation_order_policy.core_journey_impact,
    ));
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

test("a complete negative lockfile finding carries provenance-bearing local observation Evidence", () => {
  const value = project({
    facts: project().facts.filter((fact) => fact.kind !== "lockfile"),
  });
  const result = execute(value);
  const lockfile = result.checks.find(
    (check) => check.check_id === "web.baseline.lockfile",
  );

  assert.equal(lockfile.status, "failed");
  assert.equal(lockfile.evidence.length, 1);
  assert.deepEqual(lockfile.evidence[0], {
    kind: "local_observation",
    target: "repository:root-lockfiles",
    outcome: "No supported root dependency lockfile was present in the complete Local Safe Scan.",
    collection: {
      root: "/tmp/launchrally-check-catalog",
      complete: true,
      exclusions: {},
    },
    provenance: {
      collector: "local_safe_scan/v1",
      exact_target: "repository:root-lockfiles",
    },
  });
});

test("an uncovered root lockfile candidate stays Unverified instead of becoming a negative finding", () => {
  const value = project({
    facts: project().facts.filter((fact) => fact.kind !== "lockfile"),
    safe_scan: {
      policy_version: "local_safe_scan/v1",
      exclusions: { ignored: 1 },
      errors: [],
      coverage: {
        root_lockfiles: {
          complete: false,
          uncovered: [{ path: "package-lock.json", reason: "ignored" }],
        },
      },
    },
  });
  const lockfile = execute(value).checks.find(
    (check) => check.check_id === "web.baseline.lockfile",
  );

  assert.equal(lockfile.status, "unverified");
  assert.equal(lockfile.reason_code, "uncovered_scope");
  assert.deepEqual(lockfile.evidence, []);
});

test("current Provider Machine Evidence resolves the catalog-declared Provider Check", () => {
  const brief = auditBrief({
    provider_roles: {
      values: [{ provider: "vercel", role: "deployment" }],
      confirmed: true,
    },
  });
  const machineEvidence = {
    kind: "machine_evidence",
    provider: "vercel",
    adapter_version: "vercel-read/v1",
    target: "authenticated_scope_projects",
    requested_fields: ["projects.id"],
    facts: { projects: [{ id: "project-id" }] },
    collected_at: "2026-08-06T12:00:00.000Z",
    provenance: {
      collector: "provider-adapter-contract/v1",
      provider: "vercel",
      adapter_version: "vercel-read/v1",
      exact_target: "authenticated_scope_projects",
      executable: "vercel",
      arguments: ["project", "ls", "--json"],
      collected_at: "2026-08-06T12:00:00.000Z",
    },
  };
  const passedResult = execute(project(), brief, "denied", {
    evidence: [machineEvidence],
    verification_gaps: [],
  });
  const passed = passedResult.checks.find(
    (check) => check.check_id === "provider.vercel.metadata",
  );
  const declared = passedResult.catalog.checks.find(
    (check) => check.check_id === "provider.vercel.metadata",
  );

  assert.equal(passed.status, "passed");
  assert.deepEqual(passed.evidence, [machineEvidence]);
  assert.equal(declared.severity_policy.severity, "major");
  assert.equal(declared.release_gate_policy.gate, "policy");
  assert.deepEqual(declared.pass_evidence_requirement.accepted_kinds, ["machine_evidence"]);
  assert.deepEqual(declared.failure_evidence_requirement.accepted_kinds, ["machine_evidence"]);

  const gapResult = execute(project(), brief, "denied", {
    evidence: [],
    verification_gaps: [{
      check_id: "provider.vercel.metadata",
      risk_domain: "deployment",
      priority: "p0",
      status: "unverified",
      reason_code: "missing_provider_tool",
      reason: "The approved Provider tool is missing.",
    }],
  });
  const unverified = gapResult.checks.find(
    (check) => check.check_id === "provider.vercel.metadata",
  );
  assert.equal(unverified.status, "unverified");
  assert.equal(unverified.reason_code, "missing_provider_tool");
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
