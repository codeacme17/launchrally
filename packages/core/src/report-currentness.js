import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { describeWebBaselineCatalog } from "./check-catalog.js";
import { classifyContentFile, isEnvironmentFile } from "./fact-extractors.js";
import { isIgnored, parseIgnoreFile } from "./gitignore.js";
import {
  LOCAL_SAFE_SCAN_POLICY,
  SUPPORTED_LOCKFILES,
  isToolingMetadataDirectory,
} from "./local-safe-scan.js";
import {
  LEGACY_MANIFEST_RELATIVE_PATH,
  MANIFEST_RELATIVE_PATH,
  parseManifest,
} from "./manifest.js";
import {
  PROVIDER_ADAPTER_CONTRACT,
  createProviderAdapterPlan,
} from "./provider-adapters.js";
import {
  normalizeSupportLayers,
  supportLayerIsSelected,
} from "./support-layers.js";

const MAX_SUPPORTED_FILE_BYTES = 256 * 1024;
const DEPENDENCY_DIRECTORIES = new Set(["node_modules", "vendor"]);
const BUILD_DIRECTORIES = new Set([
  ".cache", ".next", ".nuxt", ".output", ".svelte-kit", ".turbo",
  "build", "coverage", "dist", "out", "target",
]);
const ALWAYS_IGNORED_DIRECTORIES = new Set([".git", ".hg", ".svn"]);
const LOCKFILES = new Set(SUPPORTED_LOCKFILES.map(([name]) => name));

function digest(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      canonicalValue(value[key]),
    ]));
  }
  return value;
}

function artifactDigest(value) {
  return digest(JSON.stringify(canonicalValue(value)));
}

function readDigest(filePath) {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return digest(readFileSync(filePath));
  } catch {
    return null;
  }
}

function exactSavedReportRelativePath(root, reportPackage, reportPath) {
  if (typeof reportPath !== "string") return null;
  try {
    const canonicalRoot = realpathSync(path.resolve(root));
    const selectedReport = path.resolve(reportPath);
    const stat = lstatSync(selectedReport);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const canonicalReport = realpathSync(selectedReport);
    const relativePath = path.relative(canonicalRoot, canonicalReport);
    if (
      relativePath === ""
      || relativePath === ".."
      || relativePath.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativePath)
    ) return null;
    const saved = JSON.parse(readFileSync(canonicalReport, "utf8"));
    if (!isDeepStrictEqual(saved, reportPackage)) return null;
    return relativePath.split(path.sep).join("/");
  } catch {
    return null;
  }
}

function repositoryDigests(root, ignoredPath = null) {
  const selected = path.resolve(root);
  const canonicalRoot = realpathSync(selected);
  const values = new Map();

  function walk(directory, relativeDirectory, inheritedRules) {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    let rules = inheritedRules;
    const ignoreEntry = entries.find((entry) => entry.name === ".gitignore" && entry.isFile());
    if (ignoreEntry) {
      const ignoreRelative = relativeDirectory
        ? `${relativeDirectory}/.gitignore`
        : ".gitignore";
      const content = readFileSync(path.join(directory, ".gitignore"));
      if (content.byteLength <= MAX_SUPPORTED_FILE_BYTES) {
        rules = [...inheritedRules, ...parseIgnoreFile(content.toString("utf8"), relativeDirectory)];
        values.set(ignoreRelative, digest(content));
      }
    }
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (relativePath === ignoredPath) continue;
      if (entry.name === ".gitignore" || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (
          isToolingMetadataDirectory(relativePath)
          || DEPENDENCY_DIRECTORIES.has(entry.name)
          || BUILD_DIRECTORIES.has(entry.name)
          || ALWAYS_IGNORED_DIRECTORIES.has(entry.name)
          || isIgnored(relativePath, rules)
        ) continue;
        if (readdirSync(absolutePath).includes(".git")) continue;
        if (!realpathSync(absolutePath).startsWith(`${canonicalRoot}${path.sep}`)) continue;
        walk(absolutePath, relativePath, rules);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isEnvironmentFile(entry.name) && isIgnored(relativePath, rules)) continue;
      const stat = lstatSync(absolutePath);
      if (stat.size > MAX_SUPPORTED_FILE_BYTES) continue;
      if (!LOCKFILES.has(entry.name) && !classifyContentFile(entry.name)) continue;
      values.set(relativePath, digest(readFileSync(absolutePath)));
    }
  }

  walk(canonicalRoot, "", []);
  return values;
}

function sameValues(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function sameSupportLayers(left, right) {
  const normalizedLeft = normalizeSupportLayers(left);
  const normalizedRight = normalizeSupportLayers(right);
  return normalizedLeft !== null
    && normalizedRight !== null
    && sameValues(normalizedLeft, normalizedRight);
}

function manifestValue(state) {
  if (state?.state === "declared") return state.value;
  if (state?.state === "not_applicable") return [];
  return undefined;
}

function manifestMatchesReport(manifest, report) {
  const intent = report.scope.release_intent;
  return manifest.execution?.source_report_id?.value === report.report_id
    && manifestValue(manifest.project?.name) === report.scope.project.name
    && manifestValue(manifest.project?.type) === report.scope.project.type
    && manifestValue(manifest.project?.package_manager) === report.scope.project.package_manager
    && manifestValue(manifest.execution?.assessment) === report.assessment
    && isDeepStrictEqual(
      manifestValue(manifest.execution?.public_verification),
      report.scope.public_verification,
    )
    && manifestValue(manifest.release?.intended_environment) === intent.intended_environment
    && sameValues(manifestValue(manifest.release?.production_targets) ?? [], intent.production_targets)
    && sameValues(manifestValue(manifest.release?.core_journeys) ?? [], intent.core_journeys)
    && sameSupportLayers(manifestValue(manifest.support?.layers) ?? [], intent.support_layers)
    && sameValues(manifestValue(manifest.providers?.roles) ?? [], intent.provider_roles);
}

function currentManifestDigest(root, report, allowLegacyManifest) {
  const manifestPath = path.join(root, MANIFEST_RELATIVE_PATH);
  const currentDigest = readDigest(manifestPath);
  const expectedDigest = report.verification_context?.manifest_digest ?? null;
  if (currentDigest === null && allowLegacyManifest) {
    const legacyPath = path.join(root, LEGACY_MANIFEST_RELATIVE_PATH);
    const legacyDigest = readDigest(legacyPath);
    try {
      const legacy = JSON.parse(readFileSync(legacyPath, "utf8"));
      if (manifestMatchesReport(legacy, report)) return expectedDigest;
    } catch {
      // The caller validates legacy Manifest syntax separately.
    }
    if (legacyDigest !== null) return legacyDigest;
  }
  if (currentDigest === null || expectedDigest !== null) {
    return currentDigest;
  }
  try {
    const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
    if (manifest.schema_version === "launchrally.dev/manifest/v1") {
      return manifestMatchesReport(manifest, report) ? null : currentDigest;
    }
    return manifestMatchesReport(manifest, report) ? null : currentDigest;
  } catch {
    return currentDigest;
  }
}

const EVIDENCE_REFERENCE_FIELDS = [
  "digest",
  "source",
  "target",
  "collected_at",
  "freshness_class",
  "redaction_state",
];

function referenceMatchesCurrentEntry(reference, entry) {
  return Boolean(entry)
    && entry.current === true
    && entry.currentness?.status === "current"
    && EVIDENCE_REFERENCE_FIELDS.every((field) => reference[field] === entry[field]);
}

function notApplicableEvidenceIsCurrent(check, report, evidenceByDigest) {
  if (check.status !== "not_applicable") return true;
  if (check.applicability?.status !== "not_applicable" || check.applicability.evidence.length === 0) {
    return false;
  }
  if (check.applicability.evidence.some((reference) => {
    const entry = evidenceByDigest.get(reference.digest);
    return !referenceMatchesCurrentEntry(reference, entry);
  })) {
    return false;
  }
  const entries = check.applicability.evidence.map((reference) =>
    evidenceByDigest.get(reference.digest),
  );
  const intent = report.scope.release_intent;
  if (check.check_id === "web.baseline.data-state") {
    return !intent.provider_roles.some(({ role }) => ["data", "database", "storage"].includes(role))
      && entries.some(({ normalized_artifact: artifact }) =>
        artifact.kind === "release_intent"
        && artifact.field === "provider_roles"
        && artifact.value === "confirmed:no-data-role")
      && entries.some(({ normalized_artifact: artifact }) => artifact.kind === "file");
  }
  if (check.check_id === "web.baseline.observability") {
    return normalizeSupportLayers(intent.support_layers) !== null
      && !supportLayerIsSelected(intent.support_layers, "observability")
      && !intent.provider_roles.some(({ role }) => role === "observability")
      && entries.some(({ normalized_artifact: artifact }) =>
        artifact.kind === "release_intent"
        && artifact.field === "support_layers"
        && artifact.value === "confirmed:no-monitoring")
      && entries.some(({ normalized_artifact: artifact }) =>
        artifact.kind === "release_intent"
        && artifact.field === "provider_roles"
        && artifact.value === "confirmed:no-observability-role");
  }
  return true;
}

const MACHINE_EVIDENCE_KINDS = new Set([
  "file",
  "local_observation",
  "project_fact",
  "public_observation",
  "authenticated_journey_machine_evidence",
  "machine_evidence",
]);

function qualifyingEvidence(check, declaration, evidenceByDigest) {
  const requirement = check.status === "passed"
    ? declaration?.pass_evidence_requirement ?? declaration?.evidence_requirement
    : check.status === "failed"
      ? declaration?.failure_evidence_requirement ?? declaration?.evidence_requirement
      : null;
  if (!requirement) return { requirement: null, entries: [] };
  return {
    requirement,
    entries: check.evidence
      .map((reference) => ({ reference, entry: evidenceByDigest.get(reference.digest) }))
      .filter(({ reference, entry }) =>
        referenceMatchesCurrentEntry(reference, entry)
        && requirement.accepted_kinds.includes(entry.evidence_kind)
        && (!requirement.provenance_required || Boolean(entry.source)),
      )
      .map(({ entry }) => entry),
  };
}

function releaseGate(declaration, scopeConfirmed) {
  const severity = declaration?.severity_policy?.severity;
  if (severity === "critical") return true;
  if (severity === "moderate") return false;
  const gate = declaration?.release_gate_policy?.gate;
  return scopeConfirmed && (gate === "always" || gate === "policy");
}

export function evaluateReportCurrentness(reportPackage, options = {}) {
  const report = reportPackage.report;
  const index = reportPackage.evidence_index;
  const evaluatedAt = (options.now?.() ?? new Date()).toISOString();
  const reasons = structuredClone(report.policy.currentness.reasons);
  const add = (reason) => reasons.push(reason);
  const currentCatalog = describeWebBaselineCatalog();
  const verificationContext = report.verification_context;

  if (report.policy.current !== true || report.policy.currentness.status !== "current") {
    if (reasons.length === 0) add({ reason_code: "stored_report_non_current" });
  }

  if (
    report.provenance.check_catalog_version !== currentCatalog.versions.check_catalog
    || report.catalog.versions.check_catalog !== currentCatalog.versions.check_catalog
  ) add({ reason_code: "catalog_version_changed" });
  if (
    report.provenance.baseline_version !== currentCatalog.versions.baseline
    || report.catalog.versions.baseline !== currentCatalog.versions.baseline
  ) add({ reason_code: "baseline_version_changed" });
  if (!sameValues(
    report.provenance.active_profile_versions,
    currentCatalog.versions.active_profiles,
  )) add({ reason_code: "profile_versions_changed" });
  if (report.provenance.scan_policy_version !== LOCAL_SAFE_SCAN_POLICY) {
    add({ reason_code: "scan_policy_version_changed" });
  }
  if (report.scope.provider_verification.contract_version !== PROVIDER_ADAPTER_CONTRACT) {
    add({ reason_code: "provider_adapter_contract_changed" });
  }
  const supportedAdapters = new Set(createProviderAdapterPlan(
    report.scope.release_intent.provider_roles,
  ).requests.map(({ adapter_version: version }) => version).filter(Boolean));
  const recordedAdapters = report.provenance.active_adapter_versions;
  if (
    !sameValues(recordedAdapters, report.catalog.versions.active_adapters)
    || recordedAdapters.some((version) => !supportedAdapters.has(version))
  ) add({ reason_code: "adapter_versions_changed" });

  const root = path.resolve(options.cwd ?? report.scope.project_root);
  if (!verificationContext) {
    add({ reason_code: "verification_context_missing" });
  } else {
    const expectedManifest = verificationContext.manifest_digest ?? null;
    const currentManifest = currentManifestDigest(
      root,
      report,
      options.allow_legacy_manifest === true,
    );
    if (currentManifest !== expectedManifest) {
      add({
        reason_code: "manifest_digest_changed",
        previous_digest: expectedManifest,
        current_digest: currentManifest,
      });
    }
  }

  if (verificationContext) {
    try {
      const savedReportPath = exactSavedReportRelativePath(
        root,
        reportPackage,
        options.saved_report_path,
      );
      const currentDigests = repositoryDigests(
        root,
        savedReportPath,
      );
      const recordedDigests = new Map(
        verificationContext.repository_digests.map(
          ({ path: file, digest: value }) => [file, value],
        ),
      );
      const paths = new Set([...recordedDigests.keys(), ...currentDigests.keys()]);
      for (const file of [...paths].sort()) {
        if ([MANIFEST_RELATIVE_PATH, LEGACY_MANIFEST_RELATIVE_PATH].includes(file)) continue;
        if (recordedDigests.get(file) !== currentDigests.get(file)) {
          add({
            reason_code: "repository_digest_changed",
            path: file,
            previous_digest: recordedDigests.get(file) ?? null,
            current_digest: currentDigests.get(file) ?? null,
          });
        }
      }
    } catch {
      add({ reason_code: "repository_digest_unavailable" });
    }
  }

  const evidenceByDigest = new Map(index.entries.map((entry) => [entry.digest, entry]));
  for (const entry of index.entries) {
    if (artifactDigest(entry.normalized_artifact) !== entry.digest) {
      add({ reason_code: "evidence_digest_mismatch", evidence_digest: entry.digest });
    }
  }
  const storedDeclarations = new Map(
    report.catalog.checks.map((item) => [item.check_id, item]),
  );
  const currentDeclarations = new Map(
    currentCatalog.checks.map((item) => [item.check_id, item]),
  );
  const evaluatedTime = Date.parse(evaluatedAt);
  for (const check of report.results.checks) {
    const declaration = currentDeclarations.get(check.check_id)
      ?? storedDeclarations.get(check.check_id);
    const freshness = declaration?.freshness_behavior;
    const expectedGating = releaseGate(declaration, report.scope.release_intent.confirmed);
    if (check.gating !== expectedGating) {
      add({ check_id: check.check_id, reason_code: "gating_policy_mismatch" });
    }
    if (["passed", "failed"].includes(check.status)) {
      const qualifying = qualifyingEvidence(check, declaration, evidenceByDigest);
      if (
        !qualifying.requirement
        || qualifying.entries.length < qualifying.requirement.minimum_items
      ) {
        add({ check_id: check.check_id, reason_code: "insufficient_evidence" });
      } else if (
        check.status === "failed"
        && expectedGating
        && !qualifying.entries.some((entry) => MACHINE_EVIDENCE_KINDS.has(entry.evidence_kind))
      ) {
        add({ check_id: check.check_id, reason_code: "insufficient_machine_evidence" });
      }
    }
    if (freshness?.mode === "live_state" && check.status !== "not_applicable") {
      for (const reference of check.evidence) {
        const evidence = evidenceByDigest.get(reference.digest);
        if (
          !evidence
          || evaluatedTime - Date.parse(evidence.collected_at) > freshness.max_age_seconds * 1000
        ) {
          add({
            check_id: check.check_id,
            reason_code: evidence ? "live_evidence_stale" : "evidence_missing",
            evidence_digest: reference.digest,
          });
        }
      }
    }
    if (!notApplicableEvidenceIsCurrent(check, report, evidenceByDigest)) {
      add({ check_id: check.check_id, reason_code: "applicability_evidence_invalid" });
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
