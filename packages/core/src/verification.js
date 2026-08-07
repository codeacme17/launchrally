import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  AUDIT_BRIEF_SCHEMA,
  CLI_INTERACTION_CONTRACT,
  PROVIDER_INTENT_DECISION_SCHEMA,
  VERIFICATION_RESULT_SCHEMA,
  VERIFY_INTERACTION_SCHEMA,
  assertSupportedManifestVersion,
  assertSupportedReportVersion,
  assertValidManifest,
  assertValidReportPackage,
} from "@launchrally/contracts";

import { describeWebBaselineCatalog, executeWebBaseline } from "./check-catalog.js";
import { MANIFEST_RELATIVE_PATH, parseManifest } from "./manifest.js";
import { scanRepository } from "./local-safe-scan.js";
import { createProviderAdapterPlan, executeProviderAdapters } from "./provider-adapters.js";
import { matchesProviderDecisionCard } from "./provider-decision-cards.js";
import { createPublicVerificationPlan, collectPublicEvidence } from "./public-verification.js";
import { createReportPackage, createVerificationContext } from "./reporting.js";

const VERIFY_LIMITATIONS = Object.freeze([
  "Verification recollects only normalized, secret-safe repository facts and explicitly authorized live Evidence.",
  "Historical Reports and Evidence remain immutable and are compared by identity and Check result.",
]);

function executionError(error, message) {
  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "execution_error",
    operation: "verify",
    error,
    message,
  };
}

async function storeState(state) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-verify-"));
  const directoryToken = path.basename(directory).slice("launchrally-verify-".length);
  const fileToken = randomBytes(32).toString("base64url");
  await writeFile(
    path.join(directory, `${fileToken}.json`),
    `${JSON.stringify(state)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return `lrverify_${directoryToken}_${fileToken}`;
}

async function loadState(token) {
  if (typeof token !== "string") return null;
  const match = token.match(/^lrverify_([A-Za-z0-9]{6})_([A-Za-z0-9_-]{43})$/u);
  if (!match) return null;
  const statePath = path.join(
    os.tmpdir(),
    `launchrally-verify-${match[1]}`,
    `${match[2]}.json`,
  );
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    return state?.schema_version === VERIFY_INTERACTION_SCHEMA ? { state, statePath } : null;
  } catch {
    return null;
  }
}

async function discardState(statePath) {
  if (statePath) await rm(path.dirname(statePath), { recursive: true, force: true });
}

function manifestAnswers(manifest, report) {
  const intent = report.scope.release_intent;
  return {
    intended_environment: manifestValue(
      manifest.release.intended_environment,
      intent.intended_environment,
    ),
    production_targets: manifestValue(manifest.release.production_targets, intent.production_targets),
    core_journeys: manifestValue(manifest.release.core_journeys, intent.core_journeys),
    provider_roles: manifestValue(manifest.providers.roles, intent.provider_roles),
    support_layers: manifestValue(manifest.support.layers, intent.support_layers),
  };
}

function selectedChecks(report, manifest, mode, requestedIds) {
  const currentProviderChecks = createProviderAdapterPlan(
    manifestAnswers(manifest, report).provider_roles,
  ).requests.map(({ provider }) => `provider.${provider}.metadata`);
  const available = [
    ...describeWebBaselineCatalog().checks.map(({ check_id }) => check_id),
    ...currentProviderChecks,
  ];
  if (mode === "full") return available;
  if (!Array.isArray(requestedIds) || requestedIds.length === 0) return null;
  const unique = [...new Set(requestedIds)];
  return unique.every((checkId) => available.includes(checkId)) ? unique : null;
}

function publicProbeKinds(checkIds) {
  const kinds = new Set();
  if (checkIds.includes("web.public.availability")) {
    kinds.add("dns");
    kinds.add("http");
    kinds.add("health");
  }
  if (checkIds.includes("web.public.transport-security")) kinds.add("tls");
  if (checkIds.includes("web.public.core-journeys")) kinds.add("journey");
  return kinds;
}

function limitedPublicPlan(plan, checkIds, mode) {
  if (mode === "full") return structuredClone(plan);
  const kinds = publicProbeKinds(checkIds);
  return {
    ...structuredClone(plan),
    probes: plan.probes.filter(({ kind }) => kinds.has(kind)).map((probe) => structuredClone(probe)),
  };
}

function permissionsFor(report, manifest, checkIds, mode) {
  const selected = new Set(checkIds);
  const planned = describeWebBaselineCatalog().checks.filter(
    ({ check_id }) => selected.has(check_id),
  );
  const permissionIds = new Set(planned.map(({ permission_id }) => permission_id));
  for (const checkId of checkIds.filter((candidate) => candidate.startsWith("provider."))) {
    permissionIds.add(`provider_read:${checkId.split(".")[1]}`);
  }
  const answers = manifestAnswers(manifest, report);
  const publicPlan = limitedPublicPlan(createPublicVerificationPlan(answers), checkIds, mode);
  const providerPlan = createProviderAdapterPlan(answers.provider_roles);
  const permissions = [{
    permission_id: "local_safe_scan",
    boundary: "local_scan",
    decision: "granted",
    basis: "verify_start",
    scope: { root: "selected_verify_root" },
  }];
  if (permissionIds.has("public_verification")) {
    permissions.push({
      permission_id: "public_verification",
      boundary: "public_network",
      decision: "pending",
      scope: publicPlan,
    });
  }
  for (const request of providerPlan.requests) {
    if (!permissionIds.has(request.permission_id)) continue;
    permissions.push({
      permission_id: request.permission_id,
      boundary: "provider_read",
      decision: "pending",
      scope: structuredClone(request),
    });
  }
  return permissions;
}

async function readManifest(cwd) {
  let handle;
  try {
    const root = await realpath(path.resolve(cwd));
    const manifestPath = path.join(root, MANIFEST_RELATIVE_PATH);
    const stat = await lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid_manifest_file");
    const canonical = await realpath(manifestPath);
    const relative = path.relative(root, canonical);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      throw new Error("invalid_manifest_file");
    }
    handle = await open(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error("invalid_manifest_file");
    }
    const manifest = parseManifest(await handle.readFile({ encoding: "utf8" }));
    assertSupportedManifestVersion(manifest);
    assertValidManifest(manifest);
    return manifest;
  } catch (error) {
    if (error?.code === "unsupported_manifest_version") throw error;
    const invalid = new Error("A supported LaunchRally Manifest is required for Verify.");
    invalid.code = "invalid_manifest";
    throw invalid;
  } finally {
    await handle?.close();
  }
}

function needsPermission(state, token) {
  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "needs_permission",
    operation: "verify",
    verification_scope: structuredClone(state.verification_scope),
    authorization_plan: structuredClone(state.permissions),
    request: {
      type: "permission",
      permissions: state.permissions
        .filter(({ decision }) => decision === "pending")
        .map((permission) => structuredClone(permission)),
    },
    interaction: {
      schema_version: VERIFY_INTERACTION_SCHEMA,
      interaction_id: state.interaction_id,
      revision: state.revision,
      resume_token: token,
    },
    history: structuredClone(state.history),
  };
}

function manifestValue(state, fallback) {
  if (state?.state === "declared") return structuredClone(state.value);
  if (state?.state === "not_applicable") return [];
  return structuredClone(fallback);
}

function confirmedManifestScope(manifest) {
  return [
    manifest.release.intended_environment,
    manifest.release.production_targets,
    manifest.release.core_journeys,
    manifest.support.layers,
    manifest.providers.roles,
  ].every(({ state }) => ["declared", "not_applicable"].includes(state));
}

async function createSnapshot(cwd) {
  const scan = await scanRepository(cwd);
  const packageFact = scan.facts.find(
    (fact) => fact.kind === "package_manifest" && fact.provenance.path === "package.json",
  );
  const lockfileFacts = scan.facts.filter(
    (fact) => fact.kind === "lockfile" && !fact.provenance.path.includes("/"),
  );
  const packageManifestStatus = packageFact?.status ?? "missing";
  const project = {
    root: scan.root,
    name: packageFact?.name ?? path.basename(scan.root),
    type: packageManifestStatus === "valid" ? "web" : "unknown",
    package_manifest: { path: "package.json", status: packageManifestStatus },
    package_manager: lockfileFacts[0]?.package_manager ?? "unknown",
    script_names: packageFact?.script_names ?? [],
    detected_files: [
      ...(packageFact ? ["package.json"] : []),
      ...lockfileFacts.map((fact) => fact.provenance.path),
    ],
    facts: scan.facts,
    safe_scan: {
      policy_version: scan.policy_version,
      exclusions: scan.exclusions,
      errors: scan.errors,
      coverage: scan.coverage,
    },
  };
  Object.defineProperty(project, "content_digests", {
    value: scan.content_digests,
    enumerable: false,
  });
  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "completed",
    kind: "initial_readiness_snapshot",
    project,
    obvious_blockers: {
      valid: [],
      invalid: ["package.json exists but could not be read as a valid package manifest."],
      missing: ["No package.json was found, so a conventional Web repository could not be identified."],
    }[packageManifestStatus],
    limitations: [...VERIFY_LIMITATIONS],
    next: { type: "none", required: false, message: "Verify scope is already confirmed." },
  };
}

function auditBrief(state, snapshot) {
  const sourceIntent = state.source.report.scope.release_intent;
  const manifest = state.manifest;
  const answers = {
    intended_environment: manifestValue(
      manifest.release.intended_environment,
      sourceIntent.intended_environment,
    ),
    production_targets: manifestValue(
      manifest.release.production_targets,
      sourceIntent.production_targets,
    ),
    core_journeys: manifestValue(manifest.release.core_journeys, sourceIntent.core_journeys),
    provider_roles: manifestValue(manifest.providers.roles, sourceIntent.provider_roles),
    support_layers: manifestValue(manifest.support.layers, sourceIntent.support_layers),
  };
  const confirmed = confirmedManifestScope(manifest);
  const selection = (value) => ({ values: structuredClone(value), candidates: [], confirmed });
  const providerAdapters = createProviderAdapterPlan(answers.provider_roles);
  if (state.verification_scope.mode === "targeted") {
    const selected = new Set(state.verification_scope.check_ids);
    providerAdapters.requests = providerAdapters.requests.filter((request) =>
      selected.has(`provider.${request.provider}.metadata`),
    );
  }
  const publicVerification = limitedPublicPlan(
    createPublicVerificationPlan(answers),
    state.verification_scope.check_ids,
    state.verification_scope.mode,
  );
  const selected = new Set(state.verification_scope.check_ids);
  const publicTargets = publicVerification.targets;
  const plannedChecks = [
    ...describeWebBaselineCatalog().checks
      .filter(({ check_id }) => selected.has(check_id))
      .map((check) => ({
        check_id: check.check_id,
        check_version: check.check_version,
        risk_domain: check.risk_domain,
        permission_id: check.permission_id,
        scope: check.permission_id === "public_verification" ? "confirmed_targets" : "repository",
        ...(check.permission_id === "public_verification"
          ? { targets: structuredClone(publicTargets) }
          : {}),
      })),
    ...providerAdapters.requests.map((request) => ({
      check_id: `provider.${request.provider}.metadata`,
      permission_id: request.permission_id,
      provider: request.provider,
      roles: structuredClone(request.roles),
      adapter_version: request.adapter_version,
      target: request.target,
      requested_fields: structuredClone(request.requested_fields),
    })),
  ];
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
      value: answers.intended_environment,
      candidates: [],
      confirmed,
    },
    production_targets: selection(answers.production_targets),
    core_journeys: selection(answers.core_journeys),
    provider_roles: selection(answers.provider_roles),
    support_layers: selection(answers.support_layers),
    public_verification: publicVerification,
    provider_adapters: providerAdapters,
    planned_checks: plannedChecks,
  };
}

function same(left, right) {
  return isDeepStrictEqual(left, right);
}

function confirmedProviderDecisionMatchesSource(manifest, source) {
  const decision = manifest.providers.decision;
  if (
    !decision
    || decision.schema_version !== PROVIDER_INTENT_DECISION_SCHEMA
    || decision.source_report_id !== source.report_id
    || manifest.providers.roles.state !== "declared"
    || !matchesProviderDecisionCard(decision)
  ) return false;
  const expectedRoles = [
    ...source.scope.release_intent.provider_roles.filter(
      ({ role }) => role !== decision.role,
    ),
    { provider: decision.provider, role: decision.role },
  ].sort((left, right) =>
    `${left.role}:${left.provider}`.localeCompare(`${right.role}:${right.provider}`),
  );
  return same(manifest.providers.roles.value, expectedRoles);
}

function manifestDrift(state, snapshot, brief, providerResult) {
  const manifest = state.manifest;
  const source = state.source.report;
  const drift = [];
  const compare = (field, manifestState, observedValue, observedSource) => {
    if (!["declared", "not_applicable"].includes(manifestState?.state)) return;
    const effectiveValue = manifestState.state === "declared" ? manifestState.value : [];
    if (same(effectiveValue, observedValue)) return;
    drift.push({
      field,
      manifest_value: structuredClone(effectiveValue),
      observed_value: structuredClone(observedValue),
      observed_source: observedSource,
    });
  };
  compare("project.name", manifest.project.name, snapshot.project.name, "repository");
  compare("project.type", manifest.project.type, snapshot.project.type, "repository");
  compare(
    "project.package_manager",
    manifest.project.package_manager,
    snapshot.project.package_manager,
    "repository",
  );
  compare(
    "execution.source_report_id",
    manifest.execution.source_report_id,
    source.report_id,
    "source_report",
  );
  compare("execution.assessment", manifest.execution.assessment, source.assessment, "source_report");
  compare(
    "execution.public_verification",
    manifest.execution.public_verification,
    source.scope.public_verification,
    "source_report",
  );
  const historical = source.scope.release_intent;
  compare(
    "release.intended_environment",
    manifest.release.intended_environment,
    historical.intended_environment,
    "source_report",
  );
  compare(
    "release.production_targets",
    manifest.release.production_targets,
    historical.production_targets,
    "source_report",
  );
  compare(
    "release.core_journeys",
    manifest.release.core_journeys,
    historical.core_journeys,
    "source_report",
  );
  compare("support.layers", manifest.support.layers, historical.support_layers, "source_report");
  if (!confirmedProviderDecisionMatchesSource(manifest, source)) {
    compare(
      "providers.roles",
      manifest.providers.roles,
      historical.provider_roles,
      "source_report",
    );
  }
  const declaredProviders = new Set(brief.provider_roles.values.map(({ provider }) => provider));
  for (const evidence of providerResult.evidence) {
    if (!declaredProviders.has(evidence.provider)) {
      drift.push({
        field: "providers.roles",
        manifest_value: structuredClone(brief.provider_roles.values),
        observed_value: evidence.provider,
        observed_source: "provider",
      });
    }
  }
  return drift;
}

function compareReports(sourcePackage, currentPackage) {
  const source = sourcePackage.report;
  const current = currentPackage.report;
  const previous = new Map(source.results.checks.map((check) => [check.check_id, check]));
  const currentEvidence = new Map(
    currentPackage.evidence_index.entries.map((entry) => [entry.target, entry]),
  );
  const invalidatedEvidence = sourcePackage.evidence_index.entries
    .filter((entry) => ["repository_snapshot", "confirmed_scope"].includes(entry.freshness_class))
    .flatMap((entry) => {
      const replacement = currentEvidence.get(entry.target);
      if (
        entry.normalized_artifact?.kind === "file"
        && !Object.hasOwn(entry.normalized_artifact, "content_digest")
      ) {
        return [{
          target: entry.target,
          reason_code: "digest_baseline_unavailable",
          previous_digest: entry.digest,
          current_digest: replacement?.digest ?? null,
        }];
      }
      if (replacement?.digest === entry.digest) return [];
      return [{
        target: entry.target,
        reason_code: replacement ? "content_changed" : "evidence_no_longer_present",
        previous_digest: entry.digest,
        current_digest: replacement?.digest ?? null,
      }];
    });
  const seenTargets = new Set(invalidatedEvidence.map(({ target }) => target));
  for (const invalidation of compareScopeDigests(
    source.verification_context,
    current.verification_context,
  )) {
    if (!seenTargets.has(invalidation.target)) invalidatedEvidence.push(invalidation);
  }
  const currentChecks = new Map(current.results.checks.map((check) => [check.check_id, check]));
  const checkIds = [
    ...source.results.checks.map(({ check_id }) => check_id),
    ...current.results.checks
      .map(({ check_id }) => check_id)
      .filter((checkId) => !previous.has(checkId)),
  ];
  return {
    schema_version: "launchrally.dev/report-comparison/v1",
    source_report_id: source.report_id,
    current_report_id: current.report_id,
    assessment: { before: source.assessment, after: current.assessment },
    invalidated_evidence: invalidatedEvidence,
    checks: checkIds.map((checkId) => ({
      check_id: checkId,
      before: previous.get(checkId)?.status ?? null,
      after: currentChecks.get(checkId)?.status ?? null,
      changed: previous.get(checkId)?.status !== currentChecks.get(checkId)?.status,
    })),
  };
}

function compareScopeDigests(source, current) {
  if (!source || !current) return [];
  const sourceByPath = new Map(
    source.repository_digests.map((entry) => [entry.path, entry.digest]),
  );
  const currentByPath = new Map(
    current.repository_digests.map((entry) => [entry.path, entry.digest]),
  );
  const paths = [
    ...sourceByPath.keys(),
    ...[...currentByPath.keys()].filter((pathName) => !sourceByPath.has(pathName)),
  ];
  const changes = paths.flatMap((pathName) => {
    const previousDigest = sourceByPath.get(pathName) ?? null;
    const currentDigest = currentByPath.get(pathName) ?? null;
    if (currentDigest === previousDigest) return [];
    return [{
      target: `repository:${pathName}`,
      reason_code: previousDigest === null
        ? "scope_digest_added"
        : currentDigest === null
          ? "scope_digest_no_longer_present"
          : "scope_digest_changed",
      previous_digest: previousDigest,
      current_digest: currentDigest,
    }];
  });
  if (
    source.manifest_digest !== current.manifest_digest
    && !changes.some(({ target }) => target === `repository:${MANIFEST_RELATIVE_PATH}`)
  ) {
    changes.push({
      target: `manifest:${path.basename(MANIFEST_RELATIVE_PATH)}`,
      reason_code: source.manifest_digest === null
        ? "scope_digest_added"
        : current.manifest_digest === null
          ? "scope_digest_no_longer_present"
          : "scope_digest_changed",
      previous_digest: source.manifest_digest,
      current_digest: current.manifest_digest,
    });
  }
  if (source.target_digest !== current.target_digest) {
    changes.push({
      target: "release_scope:target_digest",
      reason_code: "scope_digest_changed",
      previous_digest: source.target_digest,
      current_digest: current.target_digest,
    });
  }
  return changes;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function targetedCurrentness(checks, catalog, evidence, evaluatedAt) {
  const declarations = new Map(catalog.checks.map((check) => [check.check_id, check]));
  const evidenceByKey = new Map(evidence.map((item) => [
    item.probe_id ?? `${item.provider}:${item.target}`,
    item,
  ]));
  const reasons = [];
  for (const check of checks) {
    const freshness = declarations.get(check.check_id)?.freshness_behavior;
    if (freshness?.mode !== "live_state" || check.status === "not_applicable") continue;
    for (const reference of check.evidence) {
      const item = reference.kind === "public_observation"
        ? evidenceByKey.get(reference.probe_id)
        : evidence.find((candidate) => candidate.kind === reference.kind);
      if (
        item?.collected_at
        && Date.parse(evaluatedAt) - Date.parse(item.collected_at) > freshness.max_age_seconds * 1000
      ) {
        reasons.push({
          check_id: check.check_id,
          reason_code: "live_evidence_stale",
          collected_at: item.collected_at,
          max_age_seconds: freshness.max_age_seconds,
        });
      }
    }
  }
  return {
    current: reasons.length === 0,
    currentness: {
      status: reasons.length === 0 ? "current" : "non_current",
      evaluated_at: evaluatedAt,
      reasons,
    },
  };
}

function digestBoundEvidence(evidence, repositoryDigests) {
  const normalized = structuredClone(evidence);
  if (normalized.kind === "file") {
    normalized.content_digest = repositoryDigests[normalized.path] ?? null;
  }
  return normalized;
}

function createTargetedResult({
  state,
  baseline,
  publicEvidence,
  providerResult,
  drift,
  repositoryDigests,
  brief,
}, dependencies) {
  const now = dependencies.now ?? (() => new Date());
  const id = dependencies.id ?? randomUUID;
  const createdAt = now().toISOString();
  const selected = new Set(state.verification_scope.check_ids);
  const checks = baseline.checks
    .filter(({ check_id }) => selected.has(check_id))
    .map((check) => ({
      ...structuredClone(check),
      applicability: {
        ...structuredClone(check.applicability),
        evidence: check.applicability.evidence.map((item) =>
          digestBoundEvidence(item, repositoryDigests),
        ),
      },
      evidence: check.evidence.map((item) => digestBoundEvidence(item, repositoryDigests)),
    }));
  const declarations = baseline.catalog.checks
    .filter(({ check_id }) => selected.has(check_id))
    .map((check) => structuredClone(check));
  const localEvidence = checks.flatMap((check) => [
    ...check.applicability.evidence,
    ...check.evidence,
  ]).filter(({ kind }) => [
    "file",
    "local_observation",
    "project_fact",
    "release_intent",
  ].includes(kind));
  const evidence = [...new Map([
    ...localEvidence,
    ...publicEvidence.map((item) => structuredClone(item)),
    ...providerResult.evidence.map((item) => structuredClone(item)),
  ].map((item) => [JSON.stringify(item), item])).values()];
  const freshness = targetedCurrentness(
    checks,
    { checks: declarations },
    evidence,
    createdAt,
  );
  const driftReasons = drift.map(({ field }) => ({
    reason_code: "manifest_drift",
    field,
  }));
  const currentnessReasons = [...freshness.currentness.reasons, ...driftReasons];
  return deepFreeze({
    schema_version: "launchrally.dev/targeted-verification/v1",
    result_id: id(),
    created_at: createdAt,
    check_ids: [...state.verification_scope.check_ids],
    checks,
    catalog: { checks: declarations },
    evidence,
    provider_verification_gaps: structuredClone(providerResult.verification_gaps),
    manifest_drift: structuredClone(drift),
    verification_context: createVerificationContext({
      repository_digests: repositoryDigests,
      audit_brief: brief,
    }),
    current: currentnessReasons.length === 0,
    currentness: {
      ...freshness.currentness,
      status: currentnessReasons.length === 0 ? "current" : "non_current",
      reasons: currentnessReasons,
    },
  });
}

function applyPermissionDecisions(state, decisions) {
  if (decisions === undefined) {
    return state.permissions.map((permission) => structuredClone(permission));
  }
  if (!decisions || typeof decisions !== "object" || Array.isArray(decisions)) return null;
  const permissions = state.permissions.map((permission) => structuredClone(permission));
  const byId = new Map(permissions.map((permission) => [permission.permission_id, permission]));
  for (const [permissionId, decision] of Object.entries(decisions)) {
    const permission = byId.get(permissionId);
    if (
      !permission
      || permission.decision === "granted"
      || !["approved", "denied"].includes(decision)
      || (permission.decision !== "pending" && permission.decision !== decision)
    ) {
      return null;
    }
    if (permission.decision === "pending") permission.decision = decision;
  }
  return permissions;
}

async function resumeVerify(cwd, options, dependencies) {
  const loaded = await (dependencies.load_state ?? loadState)(options.resume_token);
  if (!loaded) {
    return executionError("invalid_resume_token", "The Verify interaction token is invalid or expired.");
  }
  const { state, statePath } = loaded;
  if (state.root !== path.resolve(cwd)) {
    return executionError("resume_scope_mismatch", "The Verify interaction belongs to another repository.");
  }
  let currentManifest;
  try {
    currentManifest = await readManifest(cwd);
  } catch (error) {
    return executionError(error.code ?? "invalid_manifest", error.message);
  }
  if (!same(currentManifest, state.manifest)) {
    await discardState(statePath);
    return executionError(
      "verification_scope_stale",
      "Manifest intent changed after the Verify permission preview; start Verify again.",
    );
  }
  const permissions = applyPermissionDecisions(state, options.permission_decisions);
  if (!permissions) {
    return executionError("invalid_permission_decision", "Verify permissions must match the disclosed fresh-read plan.");
  }
  const nextState = { ...state, revision: state.revision + 1, permissions };
  if (permissions.some(({ decision }) => decision === "pending")) {
    await discardState(statePath);
    const token = await (dependencies.store_state ?? storeState)(nextState);
    return needsPermission(nextState, token);
  }
  await discardState(statePath);
  const snapshot = await createSnapshot(cwd);
  const brief = auditBrief(nextState, snapshot);
  if (state.verification_scope.mode === "full" && !brief.intended_environment.confirmed) {
    return executionError("manifest_scope_unconfirmed", "Full Verify requires confirmed Manifest intent.");
  }
  const publicPermission = permissions.find(
    ({ permission_id }) => permission_id === "public_verification",
  );
  const collectPublic = dependencies.collect_public_evidence ?? collectPublicEvidence;
  const publicEvidence = publicPermission?.decision === "approved"
    ? await collectPublic(brief.public_verification)
    : [];
  const providerResult = await executeProviderAdapters({
    cwd,
    plan: brief.provider_adapters,
    authorization_plan: permissions,
    ...(dependencies.provider_runner ? { runner: dependencies.provider_runner } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  const baseline = executeWebBaseline({
    project: snapshot.project,
    audit_brief: brief,
    authorization_plan: permissions,
    public_evidence: publicEvidence,
    provider_result: providerResult,
  });
  baseline.catalog.versions.active_adapters = providerResult.active_adapter_versions;
  const drift = manifestDrift(nextState, snapshot, brief, providerResult);
  if (state.verification_scope.mode === "targeted") {
    const targetedResult = createTargetedResult({
      state,
      baseline,
      publicEvidence,
      providerResult,
      drift,
      repositoryDigests: snapshot.project.content_digests,
      brief,
    }, dependencies);
    const previous = new Map(
      state.source.report.results.checks.map((check) => [check.check_id, check.status]),
    );
    return deepFreeze({
      contract: CLI_INTERACTION_CONTRACT,
      schema_version: VERIFICATION_RESULT_SCHEMA,
      status: "completed",
      operation: "verify",
      outcome: "targeted_verification_completed",
      verification_scope: structuredClone(state.verification_scope),
      assessment_scope: "targeted_only",
      assessment: null,
      manifest_drift: drift,
      authorization_plan: permissions,
      interaction: {
        schema_version: VERIFY_INTERACTION_SCHEMA,
        interaction_id: state.interaction_id,
        revision: nextState.revision,
      },
      history: {
        ...state.history,
        current_result_id: targetedResult.result_id,
      },
      comparison: {
        schema_version: "launchrally.dev/report-comparison/v1",
        source_report_id: state.source.report.report_id,
        current_result_id: targetedResult.result_id,
        invalidated_evidence: compareScopeDigests(
          state.source.report.verification_context,
          targetedResult.verification_context,
        ),
        checks: targetedResult.checks.map((check) => ({
          check_id: check.check_id,
          before: previous.get(check.check_id) ?? null,
          after: check.status,
          changed: previous.get(check.check_id) !== check.status,
        })),
      },
      targeted_result: targetedResult,
    });
  }
  const reportPackage = createReportPackage({
    cli_version: state.version,
    snapshot,
    audit_brief: brief,
    authorization_plan: permissions,
    interaction: {
      schema_version: VERIFY_INTERACTION_SCHEMA,
      interaction_id: state.interaction_id,
      revision: nextState.revision,
    },
    baseline,
    public_evidence: publicEvidence,
    provider_result: providerResult,
    limitations: VERIFY_LIMITATIONS,
    repository_digests: snapshot.project.content_digests,
    currentness_reasons: drift.map(({ field }) => ({
      reason_code: "manifest_drift",
      field,
    })),
  }, {
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.id ? { id: dependencies.id } : {}),
  });
  return deepFreeze({
    contract: CLI_INTERACTION_CONTRACT,
    schema_version: VERIFICATION_RESULT_SCHEMA,
    status: "completed",
    operation: "verify",
    outcome: "verification_completed",
    verification_scope: structuredClone(state.verification_scope),
    assessment_scope: "whole_release",
    assessment: drift.length > 0 ? null : reportPackage.report.assessment,
    manifest_drift: drift,
    authorization_plan: permissions,
    interaction: {
      schema_version: VERIFY_INTERACTION_SCHEMA,
      interaction_id: state.interaction_id,
      revision: nextState.revision,
    },
    history: {
      ...state.history,
      current_report_id: reportPackage.report.report_id,
      current_evidence_index_id: reportPackage.evidence_index.index_id,
    },
    comparison: compareReports(state.source, reportPackage),
    ...reportPackage,
  });
}

export async function runVerify(cwd, version, options = {}, dependencies = {}) {
  if (options.resume_token) {
    return resumeVerify(cwd, options, dependencies);
  }

  try {
    if (options.report_package?.report) {
      assertSupportedReportVersion(options.report_package.report);
    }
    assertValidReportPackage(options.report_package);
    const manifest = await readManifest(cwd);
    const mode = options.scope ?? "full";
    if (!["full", "targeted"].includes(mode)) {
      return executionError("invalid_verification_scope", "Verify scope must be full or targeted.");
    }
    const checkIds = selectedChecks(
      options.report_package.report,
      manifest,
      mode,
      options.check_ids,
    );
    if (!checkIds) {
      return executionError("invalid_verification_scope", "Targeted Verify requires valid Check IDs from the source Report.");
    }
    const state = {
      schema_version: VERIFY_INTERACTION_SCHEMA,
      interaction_id: randomUUID(),
      revision: 1,
      root: path.resolve(cwd),
      version,
      source: structuredClone(options.report_package),
      manifest,
      verification_scope: {
        mode,
        whole_release: mode === "full",
        check_ids: checkIds,
      },
      permissions: permissionsFor(options.report_package.report, manifest, checkIds, mode),
      history: {
        source_report_id: options.report_package.report.report_id,
        source_evidence_index_id: options.report_package.evidence_index.index_id,
      },
    };
    if (!state.permissions.some(({ decision }) => decision === "pending")) {
      const token = await (dependencies.store_state ?? storeState)(state);
      return resumeVerify(cwd, {
        resume_token: token,
        permission_decisions: {},
      }, dependencies);
    }
    const token = await (dependencies.store_state ?? storeState)(state);
    return needsPermission(state, token);
  } catch (error) {
    const code = error?.code ?? "invalid_report_package";
    return executionError(code, error?.message ?? "Verify could not load its immutable inputs.");
  }
}
