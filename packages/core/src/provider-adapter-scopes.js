import { isDeepStrictEqual } from "node:util";

export const PROVIDER_ADAPTER_SCOPES = Object.freeze({
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
      Object.freeze({ executable: "clerk", arguments: Object.freeze(["apps", "list", "--json"]) }),
    ]),
  }),
  cloudflare: Object.freeze({
    adapter_version: "cloudflare-read/v1",
    target: "configured_worker_deployments",
    requested_fields: Object.freeze([
      "deployments[].id", "deployments[].created_on", "deployments[].source",
      "deployments[].strategy", "deployments[].versions[].version_id",
      "deployments[].versions[].percentage",
    ]),
    commands: Object.freeze([
      Object.freeze({ executable: "wrangler", arguments: Object.freeze(["deployments", "list", "--json"]) }),
    ]),
  }),
  neon: Object.freeze({
    adapter_version: "neon-read/v1",
    target: "authenticated_scope_and_linked_project_metadata",
    requested_fields: Object.freeze([
      "projects[].id", "projects[].name", "projects[].region_id", "projects[].created_at",
      "branches[].id", "branches[].name", "branches[].current_state", "branches[].created_at",
      "branches[].expires_at", "databases[].name", "databases[].created_at",
    ]),
    commands: Object.freeze([
      Object.freeze({ executable: "neonctl", arguments: Object.freeze(["projects", "list", "--output", "json", "--no-analytics"]) }),
      Object.freeze({ executable: "neonctl", arguments: Object.freeze(["branches", "list", "--output", "json", "--no-analytics"]) }),
      Object.freeze({ executable: "neonctl", arguments: Object.freeze(["databases", "list", "--output", "json", "--no-analytics"]) }),
    ]),
  }),
  resend: Object.freeze({
    adapter_version: "resend-read/v1",
    target: "authenticated_team_domains_and_recent_email_status",
    requested_fields: Object.freeze([
      "domains[].id", "domains[].name", "domains[].status", "domains[].region",
      "domains[].created_at", "domains[].capabilities.sending",
      "domains[].capabilities.receiving", "emails[].id", "emails[].created_at",
      "emails[].last_event", "emails[].scheduled_at",
    ]),
    commands: Object.freeze([
      Object.freeze({ executable: "resend", arguments: Object.freeze(["domains", "list", "--limit", "10", "--json"]) }),
      Object.freeze({ executable: "resend", arguments: Object.freeze(["emails", "list", "--limit", "10", "--json"]) }),
    ]),
  }),
  sentry: Object.freeze({
    adapter_version: "sentry-read/v1",
    target: "configured_organization_projects_and_recent_releases",
    requested_fields: Object.freeze([
      "projects[].id", "projects[].slug", "projects[].team", "projects[].name",
      "releases[].version",
    ]),
    commands: Object.freeze([
      Object.freeze({ executable: "sentry-cli", arguments: Object.freeze(["projects", "list"]) }),
      Object.freeze({ executable: "sentry-cli", arguments: Object.freeze(["releases", "list", "--raw"]) }),
    ]),
  }),
  vercel: Object.freeze({
    adapter_version: "vercel-read/v1",
    target: "authenticated_scope_projects",
    requested_fields: Object.freeze([
      "projects[].id", "projects[].name", "projects[].framework", "projects[].nodeVersion",
      "projects[].createdAt", "projects[].updatedAt",
    ]),
    commands: Object.freeze([
      Object.freeze({ executable: "vercel", arguments: Object.freeze(["project", "ls", "--json"]) }),
    ]),
  }),
});

export function canonicalProviderAdapterRequest(provider, roles = []) {
  const scope = PROVIDER_ADAPTER_SCOPES[provider];
  const sortedRoles = [...new Set(roles)].sort();
  if (!scope) {
    return {
      provider,
      permission_id: `provider_read:${provider}`,
      roles: sortedRoles,
      adapter_version: null,
      operation: "read_only",
      target: "declared_provider_role_metadata",
      requested_fields: sortedRoles.map((role) => `${role}.configuration`),
      command: null,
      commands: null,
    };
  }
  const commands = scope.commands.map((command) => ({
    executable: command.executable,
    arguments: [...command.arguments],
  }));
  return {
    provider,
    permission_id: `provider_read:${provider}`,
    roles: sortedRoles,
    adapter_version: scope.adapter_version,
    operation: "read_only",
    target: scope.target,
    requested_fields: [...scope.requested_fields],
    command: { ...commands[0], arguments: [...commands[0].arguments] },
    commands,
  };
}

export function isCanonicalProviderAdapterRequest(request) {
  return request?.adapter_version !== null
    && isDeepStrictEqual(
      request,
      canonicalProviderAdapterRequest(request?.provider, request?.roles),
    );
}
