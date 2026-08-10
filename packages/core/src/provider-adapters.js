import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";

import { rethrowIfAborted, throwIfAborted } from "./cancellation.js";
import { assertSafeEvidenceArtifact } from "./evidence-artifact.js";

export const PROVIDER_ADAPTER_CONTRACT = "provider-adapter-contract/v2";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;
const WINDOWS_EXECUTABLE_EXTENSIONS = Object.freeze([
  ".COM",
  ".EXE",
  ".BAT",
  ".CMD",
]);

const ADAPTERS = Object.freeze({
  clerk: Object.freeze({
    adapter_version: "clerk-read/v1",
    target: "authenticated_workspace_applications",
    requested_fields: Object.freeze([
      "applications[].application_id",
      "applications[].name",
      "applications[].instances[].instance_id",
      "applications[].instances[].environment_type",
    ]),
    commands: Object.freeze([
      Object.freeze({
        executable: "clerk",
        arguments: Object.freeze(["apps", "list", "--json"]),
      }),
    ]),
    normalize: normalizeClerk,
  }),
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
  neon: Object.freeze({
    adapter_version: "neon-read/v1",
    target: "authenticated_scope_and_linked_project_metadata",
    requested_fields: Object.freeze([
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
    ]),
    commands: Object.freeze([
      Object.freeze({
        executable: "neonctl",
        arguments: Object.freeze([
          "projects", "list", "--output", "json", "--no-analytics",
        ]),
      }),
      Object.freeze({
        executable: "neonctl",
        arguments: Object.freeze([
          "branches", "list", "--output", "json", "--no-analytics",
        ]),
      }),
      Object.freeze({
        executable: "neonctl",
        arguments: Object.freeze([
          "databases", "list", "--output", "json", "--no-analytics",
        ]),
      }),
    ]),
    normalize: normalizeNeon,
  }),
  resend: Object.freeze({
    adapter_version: "resend-read/v1",
    target: "authenticated_team_domains_and_recent_email_status",
    requested_fields: Object.freeze([
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
    ]),
    commands: Object.freeze([
      Object.freeze({
        executable: "resend",
        arguments: Object.freeze(["domains", "list", "--limit", "10", "--json"]),
      }),
      Object.freeze({
        executable: "resend",
        arguments: Object.freeze(["emails", "list", "--limit", "10", "--json"]),
      }),
    ]),
    normalize: normalizeResend,
  }),
  sentry: Object.freeze({
    adapter_version: "sentry-read/v1",
    target: "configured_organization_projects_and_recent_releases",
    requested_fields: Object.freeze([
      "projects[].id",
      "projects[].slug",
      "projects[].team",
      "projects[].name",
      "releases[].version",
    ]),
    commands: Object.freeze([
      Object.freeze({
        executable: "sentry-cli",
        arguments: Object.freeze(["projects", "list"]),
      }),
      Object.freeze({
        executable: "sentry-cli",
        arguments: Object.freeze(["releases", "list", "--raw"]),
      }),
    ]),
    parse: (stdout) => stdout,
    normalize: normalizeSentry,
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

function normalizeClerk(value) {
  if (!Array.isArray(value)) throw new Error("invalid_provider_response");
  return {
    applications: value.slice(0, 20).map((application) => ({
      ...pick(application, ["application_id", "name"]),
      ...(Array.isArray(application?.instances)
        ? {
          instances: application.instances.slice(0, 10).map((instance) =>
            pick(instance, ["instance_id", "environment_type"]),
          ),
        }
        : {}),
    })),
  };
}

function normalizeNeon(value) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error("invalid_provider_response");
  }
  const [projectResponse, branches, databases] = value;
  const ownedProjects = Array.isArray(projectResponse)
    ? projectResponse
    : projectResponse?.projects;
  const sharedProjects = Array.isArray(projectResponse?.shared_with_you)
    ? projectResponse.shared_with_you
    : [];
  if (!Array.isArray(ownedProjects) || !Array.isArray(branches) || !Array.isArray(databases)) {
    throw new Error("invalid_provider_response");
  }
  return {
    projects: [...ownedProjects, ...sharedProjects].slice(0, 20).map((project) =>
      pick(project, ["id", "name", "region_id", "created_at"]),
    ),
    branches: branches.slice(0, 20).map((branch) =>
      pick(branch, ["id", "name", "current_state", "created_at", "expires_at"]),
    ),
    databases: databases.slice(0, 20).map((database) =>
      pick(database, ["name", "created_at"]),
    ),
  };
}

function normalizeResend(value) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("invalid_provider_response");
  }
  const [domainResponse, emailResponse] = value;
  if (!Array.isArray(domainResponse?.data) || !Array.isArray(emailResponse?.data)) {
    throw new Error("invalid_provider_response");
  }
  return {
    domains: domainResponse.data.slice(0, 10).map((domain) => ({
      ...pick(domain, ["id", "name", "status", "region", "created_at"]),
      ...(domain?.capabilities && typeof domain.capabilities === "object"
        ? { capabilities: pick(domain.capabilities, ["sending", "receiving"]) }
        : {}),
    })),
    emails: emailResponse.data.slice(0, 10).map((email) =>
      pick(email, ["id", "created_at", "last_event", "scheduled_at"]),
    ),
  };
}

function sentryTableRows(value) {
  if (typeof value !== "string") throw new Error("invalid_provider_response");
  const rows = value
    .replaceAll(/\u001b\[[0-9;]*m/gu, "")
    .split(/\r?\n/u)
    .filter((line) => line.trim().startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  if (rows.length === 0) return [];
  if (rows[0].join("\u0000") !== ["ID", "Slug", "Team", "Name"].join("\u0000")) {
    throw new Error("invalid_provider_response");
  }
  if (rows.slice(1).some((row) => row.length !== 4)) {
    throw new Error("invalid_provider_response");
  }
  return rows.slice(1, 21).map(([id, slug, team, name]) => ({ id, slug, team, name }));
}

function normalizeSentry(value) {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[1] !== "string") {
    throw new Error("invalid_provider_response");
  }
  return {
    projects: sentryTableRows(value[0]),
    releases: value[1]
      .split(/\r?\n/u)
      .map((version) => version.trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((version) => ({ version })),
  };
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

function disclosedCommands(request, adapter) {
  const registered = adapter.commands ?? [adapter.command];
  const commands = request.commands ?? [request.command];
  return isDeepStrictEqual(request.command, registered[0])
    && isDeepStrictEqual(commands, registered)
    ? commands
    : null;
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
            executable: (adapter.command ?? adapter.commands[0]).executable,
            arguments: [...(adapter.command ?? adapter.commands[0]).arguments],
          }
          : null,
        commands: adapter
          ? (adapter.commands ?? [adapter.command]).map((command) => ({
            executable: command.executable,
            arguments: [...command.arguments],
          }))
          : null,
      };
    }),
  };
}

export function providerRiskDomain(roles) {
  if (roles.includes("observability")) return "observability_and_operations";
  if (roles.includes("deployment")) return "deployment";
  return "data_and_integrations";
}

function gap(request, reason_code, reason) {
  return {
    check_id: `provider.${request.provider}.metadata`,
    risk_domain: providerRiskDomain(request.roles),
    priority: "p0",
    status: "unverified",
    reason_code,
    reason,
  };
}

function windowsExecutableExtensions(executable, env) {
  if (path.extname(executable)) return [""];
  const supported = new Set(WINDOWS_EXECUTABLE_EXTENSIONS);
  const extensions = (env.PATHEXT ?? WINDOWS_EXECUTABLE_EXTENSIONS.join(";"))
    .split(";")
    .map((extension) => extension.trim().toUpperCase())
    .filter((extension, index, values) =>
      supported.has(extension) && values.indexOf(extension) === index);
  return extensions.length > 0 ? extensions : [...WINDOWS_EXECUTABLE_EXTENSIONS];
}

async function resolveWindowsExecutable(executable, cwd, env) {
  const searchPath = env.PATH ?? env.Path ?? "";
  const directories = searchPath.split(path.delimiter);
  const extensions = windowsExecutableExtensions(executable, env);
  for (const entry of directories) {
    const directory = entry.trim().replace(/^"(.*)"$/u, "$1");
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.resolve(cwd, directory, `${executable}${extension}`);
      try {
        await access(candidate);
        return candidate;
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes(error?.code)) throw error;
      }
    }
  }
  const error = new Error("The disclosed Provider executable is not on PATH.");
  error.code = "ENOENT";
  throw error;
}

async function defaultRunner(command, cwd, { signal } = {}) {
  throwIfAborted(signal);
  const env = {
    ...process.env,
    CI: "1",
    NO_COLOR: "1",
    RESEND_TELEMETRY_DISABLED: "1",
    SENTRY_DISABLE_UPDATE_CHECK: "true",
    VERCEL_TELEMETRY_DISABLED: "1",
    WRANGLER_SEND_METRICS: "false",
  };
  let invocation = command;
  if (process.platform === "win32") {
    const executable = await resolveWindowsExecutable(command.executable, cwd, env);
    throwIfAborted(signal);
    invocation = /\.(?:bat|cmd)$/iu.test(executable)
      ? {
        executable: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
        arguments: ["/d", "/s", "/c", command.executable, ...command.arguments],
      }
      : { executable, arguments: command.arguments };
  }
  return execFileAsync(invocation.executable, invocation.arguments, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: TIMEOUT_MS,
    killSignal: "SIGTERM",
    ...(signal ? { signal } : {}),
    env,
  });
}

function failureKind(error) {
  if (error?.code === "ENOENT") return "missing_provider_tool";
  if (["provider_response_too_large", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"].includes(error?.code)) {
    return "provider_response_too_large";
  }
  if (error?.code === "ETIMEDOUT" || error?.killed && error?.signal === "SIGTERM") {
    return "provider_timeout";
  }
  if (
    error instanceof SyntaxError
    || error?.message === "invalid_provider_response"
    || error?.code === "unsafe_evidence_artifact"
  ) {
    return "malformed_provider_response";
  }
  const message = `${error?.stderr ?? ""} ${error?.message ?? ""}`.toLowerCase();
  if (/not authenticated|not logged in|must be logged in|authentication required|please log in|please login|unauthorized|missing credentials|api token|401/u.test(message)) {
    return "missing_provider_login";
  }
  if (/does not have access|insufficient (?:scope|permission)|not linked|org_id is required|project id.*required|unsupported capability|not available on (?:the )?.*plan/u.test(message)) {
    return "unsupported_provider_capability";
  }
  return "adapter_error";
}

function failureReason(request, reasonCode) {
  if (reasonCode === "missing_provider_tool") {
    return `${request.provider} verification could not run because the disclosed ${request.command.executable} executable is not installed or not on PATH.`;
  }
  if (reasonCode === "missing_provider_login") {
    return `${request.provider} verification could not run because the existing CLI session is not authenticated; LaunchRally did not initiate login.`;
  }
  if (reasonCode === "malformed_provider_response") {
    return `${request.provider} returned a malformed or unsupported response; no Provider response data was retained.`;
  }
  if (reasonCode === "provider_response_too_large") {
    return `${request.provider} returned more data than the bounded Adapter limit; no Provider response data was retained.`;
  }
  if (reasonCode === "provider_timeout") {
    return `${request.provider} did not complete within the bounded Adapter timeout; no Provider response data was retained.`;
  }
  if (reasonCode === "unsupported_provider_capability") {
    return `${request.provider} could not expose the disclosed read through the current account capability or linked project context; no Provider response data was retained.`;
  }
  return `${request.provider} verification failed inside ${request.adapter_version}; no Provider response data was retained.`;
}

export async function executeProviderAdapters({
  cwd,
  plan,
  authorization_plan = [],
  runner = defaultRunner,
  now = () => new Date(),
  signal,
}) {
  throwIfAborted(signal);
  const decisions = new Map(authorization_plan.map((permission) => [
    permission.permission_id,
    permission.decision,
  ]));
  const evidence = [];
  const verification_gaps = [];
  const active_adapter_versions = [];

  for (const request of plan.requests) {
    throwIfAborted(signal);
    const decision = decisions.get(request.permission_id);
    if (decision === "denied") {
      verification_gaps.push(gap(
        request,
        "permission_denied",
        `Provider read permission was denied for ${request.provider} target ${request.target}.`,
      ));
      continue;
    }
    if (decision !== "approved") {
      verification_gaps.push(gap(
        request,
        "execution_skipped",
        `Provider read permission remains undecided for ${request.provider} target ${request.target}; no Provider command was run.`,
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
    const commands = disclosedCommands(request, adapter);
    if (!commands) {
      verification_gaps.push(gap(
        request,
        "adapter_error",
        `The disclosed Provider command sequence for ${request.provider} did not match ${request.adapter_version}; no Provider command was run.`,
      ));
      continue;
    }
    active_adapter_versions.push(request.adapter_version);
    try {
      const commandResults = [];
      for (const command of commands) {
        const result = await runner(command, cwd, { signal });
        throwIfAborted(signal);
        if (typeof result?.stdout !== "string") {
          throw new Error("invalid_provider_response");
        }
        if (Buffer.byteLength(result.stdout, "utf8") > MAX_OUTPUT_BYTES) {
          const error = new Error("provider_response_too_large");
          error.code = "provider_response_too_large";
          throw error;
        }
        commandResults.push(adapter.parse
          ? adapter.parse(result.stdout)
          : JSON.parse(result.stdout));
      }
      const normalized = adapter.normalize(
        commandResults.length === 1 ? commandResults[0] : commandResults,
      );
      const collectedAt = now().toISOString();
      const artifact = {
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
          ...(adapter.commands
            ? {
              commands: commands.map((command) => ({
                executable: command.executable,
                arguments: [...command.arguments],
              })),
            }
            : {
              executable: request.command.executable,
              arguments: [...request.command.arguments],
            }),
          collected_at: collectedAt,
        },
      };
      assertSafeEvidenceArtifact(artifact);
      evidence.push(artifact);
    } catch (error) {
      rethrowIfAborted(error, signal);
      const reasonCode = failureKind(error);
      verification_gaps.push(gap(request, reasonCode, failureReason(request, reasonCode)));
    }
  }

  throwIfAborted(signal);
  return {
    evidence,
    verification_gaps,
    active_adapter_versions: [...new Set(active_adapter_versions)].sort(),
  };
}
