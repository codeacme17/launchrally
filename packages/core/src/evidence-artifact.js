import { isDeepStrictEqual } from "node:util";
import { isIP } from "node:net";
import { assertValidAuthenticatedJourneyEvidence } from "@launchrally/contracts";

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
  "access_boundary_confirmed",
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
  clerk: {
    adapter_version: "clerk-read/v1",
    contract_versions: ["provider-adapter-contract/v2"],
    target: "authenticated_workspace_applications",
    commands: [{ executable: "clerk", arguments: ["apps", "list", "--json"] }],
    requested_fields: [
      "applications[].application_id",
      "applications[].name",
      "applications[].instances[].instance_id",
      "applications[].instances[].environment_type",
    ],
  },
  cloudflare: {
    adapter_version: "cloudflare-read/v1",
    contract_versions: ["provider-adapter-contract/v1", "provider-adapter-contract/v2"],
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
  neon: {
    adapter_version: "neon-read/v1",
    contract_versions: ["provider-adapter-contract/v2"],
    target: "authenticated_scope_and_linked_project_metadata",
    commands: [
      {
        executable: "neonctl",
        arguments: ["projects", "list", "--output", "json", "--no-analytics"],
      },
      {
        executable: "neonctl",
        arguments: ["branches", "list", "--output", "json", "--no-analytics"],
      },
      {
        executable: "neonctl",
        arguments: ["databases", "list", "--output", "json", "--no-analytics"],
      },
    ],
    requested_fields: [
      "projects[].id",
      "projects[].name",
      "projects[].region_id",
      "projects[].created_at",
      "branches[].id",
      "branches[].name",
      "branches[].current_state",
      "branches[].created_at",
      "branches[].expires_at",
      "databases[].name",
      "databases[].created_at",
    ],
  },
  resend: {
    adapter_version: "resend-read/v1",
    contract_versions: ["provider-adapter-contract/v2"],
    target: "authenticated_team_domains_and_recent_email_status",
    commands: [
      {
        executable: "resend",
        arguments: ["domains", "list", "--limit", "10", "--json"],
      },
      {
        executable: "resend",
        arguments: ["emails", "list", "--limit", "10", "--json"],
      },
    ],
    requested_fields: [
      "domains[].id",
      "domains[].name",
      "domains[].status",
      "domains[].region",
      "domains[].created_at",
      "domains[].capabilities.sending",
      "domains[].capabilities.receiving",
      "emails[].id",
      "emails[].created_at",
      "emails[].last_event",
      "emails[].scheduled_at",
    ],
  },
  sentry: {
    adapter_version: "sentry-read/v1",
    contract_versions: ["provider-adapter-contract/v2"],
    target: "configured_organization_projects_and_recent_releases",
    commands: [
      { executable: "sentry-cli", arguments: ["projects", "list"] },
      { executable: "sentry-cli", arguments: ["releases", "list", "--raw"] },
    ],
    requested_fields: [
      "projects[].id",
      "projects[].slug",
      "projects[].team",
      "projects[].name",
      "releases[].version",
    ],
  },
  vercel: {
    adapter_version: "vercel-read/v1",
    contract_versions: ["provider-adapter-contract/v1", "provider-adapter-contract/v2"],
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
  if (artifact.provider === "clerk") {
    return exactKeys(artifact.facts, ["applications"])
      && Array.isArray(artifact.facts.applications)
      && artifact.facts.applications.length <= 20
      && artifact.facts.applications.every((application) =>
        optionalExactKeys(application, [], ["application_id", "name", "instances"])
        && (!application.instances || (
          Array.isArray(application.instances)
          && application.instances.length <= 10
          && application.instances.every((instance) =>
            optionalExactKeys(instance, [], ["instance_id", "environment_type"])
            && Object.values(instance).every(safeScalar))
        ))
        && Object.entries(application)
          .filter(([key]) => key !== "instances")
          .every(([, value]) => safeScalar(value)));
  }
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
  if (artifact.provider === "neon") {
    return exactKeys(artifact.facts, ["projects", "branches", "databases"])
      && Array.isArray(artifact.facts.projects)
      && artifact.facts.projects.length <= 20
      && artifact.facts.projects.every((project) =>
        optionalExactKeys(project, [], ["id", "name", "region_id", "created_at"])
        && Object.values(project).every(safeScalar))
      && Array.isArray(artifact.facts.branches)
      && artifact.facts.branches.length <= 20
      && artifact.facts.branches.every((branch) =>
        optionalExactKeys(
          branch,
          [],
          ["id", "name", "current_state", "created_at", "expires_at"],
        ) && Object.values(branch).every(safeScalar))
      && Array.isArray(artifact.facts.databases)
      && artifact.facts.databases.length <= 20
      && artifact.facts.databases.every((database) =>
        optionalExactKeys(database, [], ["name", "created_at"])
        && Object.values(database).every(safeScalar));
  }
  if (artifact.provider === "resend") {
    return exactKeys(artifact.facts, ["domains", "emails"])
      && Array.isArray(artifact.facts.domains)
      && artifact.facts.domains.length <= 10
      && artifact.facts.domains.every((domain) =>
        optionalExactKeys(
          domain,
          [],
          ["id", "name", "status", "region", "created_at", "capabilities"],
        )
        && (!domain.capabilities || (
          optionalExactKeys(domain.capabilities, [], ["sending", "receiving"])
          && Object.values(domain.capabilities).every(safeScalar)
        ))
        && Object.entries(domain)
          .filter(([key]) => key !== "capabilities")
          .every(([, value]) => safeScalar(value)))
      && Array.isArray(artifact.facts.emails)
      && artifact.facts.emails.length <= 10
      && artifact.facts.emails.every((email) =>
        optionalExactKeys(email, [], ["id", "created_at", "last_event", "scheduled_at"])
        && Object.values(email).every(safeScalar));
  }
  if (artifact.provider === "sentry") {
    return exactKeys(artifact.facts, ["projects", "releases"])
      && Array.isArray(artifact.facts.projects)
      && artifact.facts.projects.length <= 20
      && artifact.facts.projects.every((project) =>
        optionalExactKeys(project, [], ["id", "slug", "team", "name"])
        && Object.values(project).every(safeScalar))
      && Array.isArray(artifact.facts.releases)
      && artifact.facts.releases.length <= 20
      && artifact.facts.releases.every((release) =>
        exactKeys(release, ["version"])
        && safeScalar(release.version));
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
        || [
          "description_only",
          "executable_path",
          "protected_anonymous_boundary",
        ].includes(artifact.verification_mode))
      && exactKeys(artifact.provenance, ["collector", "exact_target", "collected_at"])
      && artifact.provenance.collector === "public-verification/v1"
      && artifact.provenance.exact_target === artifact.target
      && artifact.provenance.collected_at === artifact.collected_at
      && safePublicDetails(artifact);
  }
  if (artifact.kind === "authenticated_journey_observation") {
    return exactKeys(artifact, [
      "kind",
      "journey_id",
      "target",
      "method",
      "purpose",
      "authentication_class",
      "status",
      "outcome",
      "status_code",
      "collected_at",
      "provenance",
    ])
      && /^target-[1-9][0-9]*:journey-[1-9][0-9]*:authenticated$/u.test(artifact.journey_id)
      && safeString(artifact.target, 2048)
      && artifact.method === "GET"
      && safeString(artifact.purpose, 2048)
      && ["user", "staff", "signed_token"].includes(artifact.authentication_class)
      && ["passed", "failed", "unverified"].includes(artifact.status)
      && [
        "completed",
        "missing_authentication",
        "insufficient_capability",
        "expired_authentication",
        "runner_unavailable",
        "unexpected_denial",
        "redirect",
        "timeout",
        "execution_failure",
      ].includes(artifact.outcome)
      && (artifact.status_code === null
        || Number.isInteger(artifact.status_code)
        && artifact.status_code >= 100
        && artifact.status_code <= 599)
      && isoTimestamp(artifact.collected_at)
      && exactKeys(artifact.provenance, ["collector", "exact_target", "collected_at"])
      && artifact.provenance.collector === "host-agent-authenticated-journey/v1"
      && artifact.provenance.exact_target === artifact.target
      && artifact.provenance.collected_at === artifact.collected_at;
  }
  if (artifact.kind === "authenticated_journey_machine_evidence") {
    try {
      return assertValidAuthenticatedJourneyEvidence(artifact);
    } catch {
      return false;
    }
  }
  if (artifact.kind === "machine_evidence") {
    const provider = PROVIDERS[artifact.provider];
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
      && provider
      && exactKeys(
        artifact.provenance,
        provider.commands
          ? [
            "collector",
            "provider",
            "adapter_version",
            "exact_target",
            "commands",
            "collected_at",
          ]
          : [
            "collector",
            "provider",
            "adapter_version",
            "exact_target",
            "executable",
            "arguments",
            "collected_at",
          ],
      )
      && artifact.adapter_version === provider.adapter_version
      && artifact.target === provider.target
      && isDeepStrictEqual(artifact.requested_fields, provider.requested_fields)
      && isoTimestamp(artifact.collected_at)
      && provider.contract_versions.includes(artifact.provenance.collector)
      && artifact.provenance.provider === artifact.provider
      && artifact.provenance.adapter_version === artifact.adapter_version
      && artifact.provenance.exact_target === artifact.target
      && (provider.commands
        ? isDeepStrictEqual(artifact.provenance.commands, provider.commands)
        : artifact.provenance.executable === provider.executable
          && isDeepStrictEqual(artifact.provenance.arguments, provider.arguments))
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
