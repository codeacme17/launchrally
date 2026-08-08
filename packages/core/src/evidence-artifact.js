import { isDeepStrictEqual } from "node:util";
import { isIP } from "node:net";

const EXCLUSION_KEYS = [
  "ignored",
  "dependencies",
  "build_outputs",
  "tooling_metadata",
  "binary",
  "large",
  "unsupported",
  "symlinks",
  "nested_repositories",
  "outside_root",
  "unreadable",
];
const PUBLIC_OUTCOMES = new Set([
  "resolved",
  "secure",
  "reachable",
  "healthy",
  "completed",
  "timeout",
  "dns_failure",
  "certificate_failure",
  "unreachable",
  "execution_failure",
  "target_mismatch",
  "redirect_not_followed",
  "journey_definition_incomplete",
  "http_status_failure",
]);
const PROVIDERS = Object.freeze({
  cloudflare: {
    adapter_version: "cloudflare-read/v1",
    target: "configured_worker_deployments",
    executable: "wrangler",
    arguments: ["deployments", "list", "--json"],
    requested_fields: [
      "deployments[].id",
      "deployments[].created_on",
      "deployments[].source",
      "deployments[].strategy",
      "deployments[].versions[].version_id",
      "deployments[].versions[].percentage",
    ],
  },
  vercel: {
    adapter_version: "vercel-read/v1",
    target: "authenticated_scope_projects",
    executable: "vercel",
    arguments: ["project", "ls", "--json"],
    requested_fields: [
      "projects[].id",
      "projects[].name",
      "projects[].framework",
      "projects[].nodeVersion",
      "projects[].createdAt",
      "projects[].updatedAt",
    ],
  },
});

function safeString(value, maximum = 2048) {
  return typeof value === "string"
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isoTimestamp(value) {
  return safeString(value, 64) && Number.isFinite(Date.parse(value));
}

function safeScalar(value) {
  return typeof value === "boolean"
    || typeof value === "number" && Number.isFinite(value)
    || safeString(value, 512);
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}

function optionalExactKeys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function safeProviderFacts(artifact) {
  if (artifact.provider === "cloudflare") {
    return exactKeys(artifact.facts, ["deployments"])
      && Array.isArray(artifact.facts.deployments)
      && artifact.facts.deployments.every((deployment) =>
        optionalExactKeys(
          deployment,
          [],
          ["id", "created_on", "source", "strategy", "versions"],
        )
        && Object.values(deployment).every((value) =>
          Array.isArray(value) || safeScalar(value))
        && (!deployment.versions || (
          Array.isArray(deployment.versions)
          && deployment.versions.every((version) =>
            optionalExactKeys(version, [], ["version_id", "percentage"])
            && Object.values(version).every(safeScalar))
        )));
  }
  if (artifact.provider === "vercel") {
    return exactKeys(artifact.facts, ["projects"])
      && Array.isArray(artifact.facts.projects)
      && artifact.facts.projects.every((project) =>
        optionalExactKeys(
          project,
          [],
          ["id", "name", "framework", "nodeVersion", "createdAt", "updatedAt"],
        ) && Object.values(project).every(safeScalar));
  }
  return false;
}

function safePublicDetails(artifact) {
  if (!artifact.details || typeof artifact.details !== "object" || Array.isArray(artifact.details)) {
    return false;
  }
  if (artifact.probe_kind === "dns") {
    return optionalExactKeys(artifact.details, [], ["addresses"])
      && (!artifact.details.addresses || (
        Array.isArray(artifact.details.addresses)
        && artifact.details.addresses.every((address) =>
          exactKeys(address, ["address", "family"])
          && isIP(address.address) !== 0
          && [4, 6].includes(address.family))
      ));
  }
  if (artifact.probe_kind === "tls") {
    return optionalExactKeys(artifact.details, [], ["protocol", "authorized"])
      && (!Object.hasOwn(artifact.details, "protocol")
        || safeString(artifact.details.protocol, 32))
      && (!Object.hasOwn(artifact.details, "authorized")
        || typeof artifact.details.authorized === "boolean");
  }
  return optionalExactKeys(artifact.details, [], ["status_code", "redirect_target"])
    && (!Object.hasOwn(artifact.details, "status_code")
      || Number.isInteger(artifact.details.status_code)
      && artifact.details.status_code >= 0
      && artifact.details.status_code <= 599)
    && (!Object.hasOwn(artifact.details, "redirect_target")
      || artifact.details.redirect_target === null
      || safeString(artifact.details.redirect_target, 2048));
}

export function isSafeEvidenceArtifact(artifact) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return false;
  if (artifact.kind === "file") {
    return exactKeys(artifact, ["kind", "path", "content_digest"])
      && safeString(artifact.path, 1024)
      && !artifact.path.startsWith("/")
      && !artifact.path.split("/").includes("..")
      && /^sha256:[a-f0-9]{64}$/u.test(artifact.content_digest);
  }
  if (artifact.kind === "project_fact") {
    return exactKeys(artifact, ["kind", "field", "value"])
      && (
        artifact.field === "package_manifest.status"
        && ["valid", "invalid", "missing", "unknown"].includes(artifact.value)
        || artifact.field === "project.type"
        && ["web", "unknown"].includes(artifact.value)
      );
  }
  if (artifact.kind === "release_intent") {
    return exactKeys(artifact, ["kind", "field", "value"])
      && (
        artifact.field === "baseline"
        && artifact.value === "web-application-baseline/v1"
        || ["core_journeys", "production_targets"].includes(artifact.field)
        && artifact.value === "confirmed"
        || artifact.field === "support_layers"
        && ["confirmed:no-monitoring", "confirmed:observability-selected"]
          .includes(artifact.value)
        || artifact.field === "provider_roles"
        && /^confirmed:(?:data-role|no-data-role|no-observability-role|[a-z0-9][a-z0-9-]{0,63})$/u
          .test(artifact.value)
      );
  }
  if (artifact.kind === "local_observation") {
    return exactKeys(artifact, ["kind", "target", "outcome", "collection", "provenance"])
      && exactKeys(artifact.collection, ["root", "complete", "exclusions"])
      && artifact.target === "repository:root-lockfiles"
      && artifact.outcome
        === "No supported root dependency lockfile was present in the complete Local Safe Scan."
      && safeString(artifact.collection.root, 4096)
      && typeof artifact.collection.complete === "boolean"
      && exactKeys(artifact.collection.exclusions, EXCLUSION_KEYS)
      && Object.values(artifact.collection.exclusions).every((count) =>
        Number.isInteger(count) && count >= 0)
      && exactKeys(artifact.provenance, ["collector", "exact_target"])
      && artifact.provenance.collector === "local_safe_scan/v1"
      && artifact.provenance.exact_target === artifact.target;
  }
  if (artifact.kind === "public_observation") {
    return optionalExactKeys(
      artifact,
      [
        "kind",
        "probe_id",
        "probe_kind",
        "target",
        "host",
        "port",
        "path",
        "method",
        "purpose",
        "status",
        "outcome",
        "collected_at",
        "duration_ms",
        "details",
        "provenance",
      ],
      ["verification_mode"],
    )
      && ["dns", "tls", "http", "health", "journey"].includes(artifact.probe_kind)
      && safeString(artifact.probe_id, 256)
      && safeString(artifact.target, 2048)
      && safeString(artifact.host, 253)
      && Number.isInteger(artifact.port) && artifact.port > 0 && artifact.port <= 65535
      && safeString(artifact.path, 2048) && artifact.path.startsWith("/")
      && ["DNS_LOOKUP", "TLS_HANDSHAKE", "GET"].includes(artifact.method)
      && safeString(artifact.purpose, 2048)
      && ["passed", "failed", "unverified"].includes(artifact.status)
      && PUBLIC_OUTCOMES.has(artifact.outcome)
      && isoTimestamp(artifact.collected_at)
      && Number.isFinite(artifact.duration_ms) && artifact.duration_ms >= 0
      && (!artifact.verification_mode
        || ["description_only", "executable_path"].includes(artifact.verification_mode))
      && exactKeys(artifact.provenance, ["collector", "exact_target", "collected_at"])
      && artifact.provenance.collector === "public-verification/v1"
      && artifact.provenance.exact_target === artifact.target
      && artifact.provenance.collected_at === artifact.collected_at
      && safePublicDetails(artifact);
  }
  if (artifact.kind === "machine_evidence") {
    return exactKeys(artifact, [
      "kind",
      "provider",
      "adapter_version",
      "target",
      "requested_fields",
      "facts",
      "collected_at",
      "provenance",
    ])
      && exactKeys(artifact.provenance, [
        "collector",
        "provider",
        "adapter_version",
        "exact_target",
        "executable",
        "arguments",
        "collected_at",
      ])
      && Object.hasOwn(PROVIDERS, artifact.provider)
      && artifact.adapter_version === PROVIDERS[artifact.provider].adapter_version
      && artifact.target === PROVIDERS[artifact.provider].target
      && isDeepStrictEqual(artifact.requested_fields, PROVIDERS[artifact.provider].requested_fields)
      && isoTimestamp(artifact.collected_at)
      && artifact.provenance.collector === "provider-adapter-contract/v1"
      && artifact.provenance.provider === artifact.provider
      && artifact.provenance.adapter_version === artifact.adapter_version
      && artifact.provenance.exact_target === artifact.target
      && artifact.provenance.executable === PROVIDERS[artifact.provider].executable
      && isDeepStrictEqual(artifact.provenance.arguments, PROVIDERS[artifact.provider].arguments)
      && artifact.provenance.collected_at === artifact.collected_at
      && safeProviderFacts(artifact);
  }
  return false;
}

export function assertSafeEvidenceArtifact(artifact) {
  if (!isSafeEvidenceArtifact(artifact)) {
    const error = new Error("Evidence is not an allowlisted secret-safe normalized artifact.");
    error.code = "unsafe_evidence_artifact";
    throw error;
  }
  return true;
}
