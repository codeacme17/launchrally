import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const PROVIDER_ADAPTER_CONTRACT = "provider-adapter-contract/v1";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;

const ADAPTERS = Object.freeze({
  cloudflare: Object.freeze({
    adapter_version: "cloudflare-read/v1",
    target: "configured_worker_deployments",
    requested_fields: Object.freeze([
      "deployments[].id",
      "deployments[].created_on",
      "deployments[].source",
      "deployments[].strategy",
      "deployments[].versions[].version_id",
      "deployments[].versions[].percentage",
    ]),
    command: Object.freeze({
      executable: "wrangler",
      arguments: Object.freeze(["deployments", "list", "--json"]),
    }),
    normalize: normalizeCloudflare,
  }),
  vercel: Object.freeze({
    adapter_version: "vercel-read/v1",
    target: "authenticated_scope_projects",
    requested_fields: Object.freeze([
      "projects[].id",
      "projects[].name",
      "projects[].framework",
      "projects[].nodeVersion",
      "projects[].createdAt",
      "projects[].updatedAt",
    ]),
    command: Object.freeze({
      executable: "vercel",
      arguments: Object.freeze(["project", "ls", "--json"]),
    }),
    normalize: normalizeVercel,
  }),
});

function copyScalar(value) {
  return ["string", "number", "boolean"].includes(typeof value) ? value : undefined;
}

function pick(source, fields) {
  const result = {};
  for (const field of fields) {
    const value = copyScalar(source?.[field]);
    if (value !== undefined) result[field] = value;
  }
  return result;
}

function normalizeCloudflare(value) {
  const deployments = Array.isArray(value) ? value : value?.deployments;
  if (!Array.isArray(deployments)) throw new Error("invalid_provider_response");
  return {
    deployments: deployments.slice(0, 10).map((deployment) => ({
      ...pick(deployment, ["id", "created_on", "source", "strategy"]),
      ...(Array.isArray(deployment?.versions)
        ? {
          versions: deployment.versions.slice(0, 20).map((version) =>
            pick(version, ["version_id", "percentage"]),
          ),
        }
        : {}),
    })),
  };
}

function normalizeVercel(value) {
  const projects = Array.isArray(value) ? value : value?.projects;
  if (!Array.isArray(projects)) throw new Error("invalid_provider_response");
  return {
    projects: projects.slice(0, 20).map((project) =>
      pick(project, ["id", "name", "framework", "nodeVersion", "createdAt", "updatedAt"]),
    ),
  };
}

function groupedRoles(providerRoles) {
  const providers = new Map();
  for (const { provider, role } of providerRoles) {
    const roles = providers.get(provider) ?? new Set();
    roles.add(role);
    providers.set(provider, roles);
  }
  return [...providers.entries()].sort(([left], [right]) => left.localeCompare(right));
}

export function createProviderAdapterPlan(providerRoles = []) {
  return {
    contract_version: PROVIDER_ADAPTER_CONTRACT,
    requests: groupedRoles(providerRoles).map(([provider, rolesSet]) => {
      const roles = [...rolesSet].sort();
      const adapter = ADAPTERS[provider];
      return {
        provider,
        permission_id: `provider_read:${provider}`,
        roles,
        adapter_version: adapter?.adapter_version ?? null,
        operation: "read_only",
        target: adapter?.target ?? "declared_provider_role_metadata",
        requested_fields: adapter?.requested_fields
          ? [...adapter.requested_fields]
          : roles.map((role) => `${role}.configuration`),
        command: adapter
          ? {
            executable: adapter.command.executable,
            arguments: [...adapter.command.arguments],
          }
          : null,
      };
    }),
  };
}

function riskDomain(request) {
  if (request.roles.includes("observability")) return "observability_and_operations";
  if (request.roles.includes("deployment")) return "deployment";
  return "data_and_integrations";
}

function gap(request, reason_code, reason) {
  return {
    check_id: `provider.${request.provider}.metadata`,
    risk_domain: riskDomain(request),
    priority: "p0",
    status: "unverified",
    reason_code,
    reason,
  };
}

async function defaultRunner(command, cwd) {
  return execFileAsync(command.executable, command.arguments, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: TIMEOUT_MS,
    killSignal: "SIGTERM",
    env: {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
      VERCEL_TELEMETRY_DISABLED: "1",
      WRANGLER_SEND_METRICS: "false",
    },
  });
}

function failureKind(error) {
  if (error?.code === "ENOENT") return "missing_provider_tool";
  const message = `${error?.stderr ?? ""} ${error?.message ?? ""}`.toLowerCase();
  return /not authenticated|not logged in|must be logged in|authentication required|please log in|please login|unauthorized|missing credentials|api token|401/u.test(message)
    ? "missing_provider_login"
    : "adapter_error";
}

function failureReason(request, reasonCode) {
  if (reasonCode === "missing_provider_tool") {
    return `${request.provider} verification could not run because the disclosed ${request.command.executable} executable is not installed or not on PATH.`;
  }
  if (reasonCode === "missing_provider_login") {
    return `${request.provider} verification could not run because the existing CLI session is not authenticated; LaunchRally did not initiate login.`;
  }
  return `${request.provider} verification failed inside ${request.adapter_version}; no Provider response data was retained.`;
}

export async function executeProviderAdapters({
  cwd,
  plan,
  authorization_plan = [],
  runner = defaultRunner,
  now = () => new Date(),
}) {
  const decisions = new Map(authorization_plan.map((permission) => [
    permission.permission_id,
    permission.decision,
  ]));
  const evidence = [];
  const verification_gaps = [];
  const active_adapter_versions = [];

  for (const request of plan.requests) {
    const decision = decisions.get(request.permission_id);
    if (decision !== "approved") {
      verification_gaps.push(gap(
        request,
        "permission_denied",
        `Provider read permission was denied for ${request.provider} target ${request.target}.`,
      ));
      continue;
    }
    if (!request.adapter_version || !request.command) {
      verification_gaps.push(gap(
        request,
        "unsupported_provider",
        `No read-only Provider Adapter is available for ${request.provider}; the Web Baseline still completed.`,
      ));
      continue;
    }

    const adapter = ADAPTERS[request.provider];
    active_adapter_versions.push(request.adapter_version);
    try {
      const result = await runner(request.command, cwd);
      const normalized = adapter.normalize(JSON.parse(result.stdout));
      const collectedAt = now().toISOString();
      evidence.push({
        kind: "machine_evidence",
        provider: request.provider,
        adapter_version: request.adapter_version,
        target: request.target,
        requested_fields: [...request.requested_fields],
        facts: normalized,
        collected_at: collectedAt,
        provenance: {
          collector: PROVIDER_ADAPTER_CONTRACT,
          provider: request.provider,
          adapter_version: request.adapter_version,
          exact_target: request.target,
          executable: request.command.executable,
          arguments: [...request.command.arguments],
          collected_at: collectedAt,
        },
      });
    } catch (error) {
      const reasonCode = failureKind(error);
      verification_gaps.push(gap(request, reasonCode, failureReason(request, reasonCode)));
    }
  }

  return {
    evidence,
    verification_gaps,
    active_adapter_versions: [...new Set(active_adapter_versions)].sort(),
  };
}
