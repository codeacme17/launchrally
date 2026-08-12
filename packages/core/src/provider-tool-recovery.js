import { createRequire } from "node:module";
import process from "node:process";

import {
  CLI_INTERACTION_CONTRACT,
  PROVIDER_TOOL_RECOVERY_SCHEMA,
  assertValidProviderToolRecovery,
} from "@launchrally/contracts";

import { isCanonicalProviderAdapterRequest } from "./provider-adapter-scopes.js";
import { runProviderCommand } from "./provider-command-runner.js";

const require = createRequire(import.meta.url);
const authorityEntries = require("../provider-tool-installation/v1/authority.json");
const AUTHORITY_BY_PROVIDER = new Map(
  authorityEntries.map((entry) => [entry.provider, Object.freeze(entry)]),
);

const INITIAL_CHOICES = Object.freeze([
  Object.freeze({
    id: "continue_with_gap",
    label: "Continue with the explicit Verification Gap",
    default: true,
  }),
  Object.freeze({
    id: "show_install_instructions",
    label: "Show reviewed exact-version installation instructions",
    default: false,
  }),
  Object.freeze({
    id: "cancel",
    label: "Cancel this recovery flow",
    default: false,
  }),
]);
const POST_INSTALL_CHOICES = Object.freeze([
  INITIAL_CHOICES[0],
  Object.freeze({
    id: "rediscover_executable",
    label: "Rediscover and verify the executable",
    default: false,
  }),
  INITIAL_CHOICES[2],
]);

const SAFETY = Object.freeze({
  launchrally_executes_installation: false,
  provider_read_approval_reused: false,
  authentication_initiated: false,
  credentials_requested: false,
  provider_write_authorized: false,
});

function initialChoicesFor(recovery) {
  return (recovery.active_environment.guidance_available
    ? INITIAL_CHOICES
    : INITIAL_CHOICES.filter(({ id }) => id !== "show_install_instructions"))
    .map(clone);
}

function clone(value) {
  return structuredClone(value);
}

function evidenceBenefit(request) {
  return {
    target: request.target,
    requested_fields: [...request.requested_fields],
    summary:
      `The ${request.adapter_version} read-only Adapter can collect the disclosed, allowlisted ${request.provider} metadata and may replace the Verification Gap with Machine Evidence.`,
  };
}

function expectedChoices(recovery) {
  if ([
    "installation_declined",
    "authentication_declined",
    "fresh_read_declined",
    "recovery_cancelled",
  ].includes(recovery.state)) return [];
  if (recovery.state === "ready_for_fresh_permission") {
    return [INITIAL_CHOICES[0], INITIAL_CHOICES[2]].map(clone);
  }
  if (recovery.state === "unauthenticated") {
    return INITIAL_CHOICES.filter(({ id }) => id !== "show_install_instructions").map(clone);
  }
  if (recovery.installation_instructions.length > 0) return POST_INSTALL_CHOICES.map(clone);
  return initialChoicesFor(recovery);
}

function expectedInstallationInstructions(authority, recovery) {
  if (!["executable_missing", "unsupported_version"].includes(recovery.state)) return [];
  return authority.installation_routes
    .filter((route) =>
      route.platforms.includes(recovery.active_environment.platform)
      && route.shells.includes(recovery.active_environment.shell))
    .map(({ route_id, command }) => ({ route_id, command: clone(command) }));
}

function authorityFor(request) {
  const authority = AUTHORITY_BY_PROVIDER.get(request.provider);
  if (
    !authority
    || authority.adapter_version !== request.adapter_version
    || authority.executable !== request.command?.executable
  ) return null;
  return authority;
}

function installationAuthority(authority) {
  return {
    official_source: clone(authority.official_source),
    package: clone(authority.package),
    supported_platforms: [...authority.supported_platforms],
    supported_shells: [...authority.supported_shells],
    verification_command: clone(authority.verification_command),
    reviewed_at: authority.reviewed_at,
  };
}

function assertTrustedRecoveryAuthority(recovery) {
  assertValidProviderToolRecovery(recovery);
  const authority = AUTHORITY_BY_PROVIDER.get(recovery.provider);
  const scope = recovery.provider_read_scope;
  const expectedAuthority = authority ? installationAuthority(authority) : null;
  const guidanceAvailable = authority?.installation_routes.some((route) =>
    route.platforms.includes(recovery.active_environment.platform)
    && route.shells.includes(recovery.active_environment.shell));
  const reviewedInstructions = authority
    ? expectedInstallationInstructions(authority, recovery)
    : [];
  const validInstructions = recovery.installation_instructions.length === 0
    || JSON.stringify(recovery.installation_instructions) === JSON.stringify(reviewedInstructions);
  const valid = authority
    && authority.adapter_version === recovery.adapter_version
    && authority.executable === recovery.executable
    && scope?.provider === recovery.provider
    && scope?.adapter_version === recovery.adapter_version
    && scope?.permission_id === recovery.permission_id
    && isCanonicalProviderAdapterRequest(scope)
    && JSON.stringify(recovery.evidence_benefit) === JSON.stringify(evidenceBenefit(scope))
    && JSON.stringify(recovery.installation_authority) === JSON.stringify(expectedAuthority)
    && recovery.active_environment.guidance_available === guidanceAvailable
    && JSON.stringify(recovery.choices) === JSON.stringify(expectedChoices(recovery))
    && validInstructions;
  if (!valid) {
    const error = new Error("The Provider Tool Recovery authority is untrusted or stale.");
    error.code = "invalid_provider_tool_recovery_authority";
    throw error;
  }
  return authority;
}

function detectedFor(reasonCode) {
  if (reasonCode === "missing_provider_login") {
    return {
      executable: "present",
      version: "unknown",
      detected_version: null,
      authentication: "unauthenticated",
    };
  }
  return {
    executable: "missing",
    version: "unknown",
    detected_version: null,
    authentication: "unknown",
  };
}

export function createProviderToolRecovery(request, {
  reason_code = "missing_provider_tool",
  platform = process.platform,
  shell = platform === "win32" ? "powershell" : "posix",
} = {}) {
  const authority = authorityFor(request);
  if (!authority) return null;
  const guidanceAvailable = authority.installation_routes.some((route) =>
    route.platforms.includes(platform) && route.shells.includes(shell));
  const recovery = {
    schema_version: PROVIDER_TOOL_RECOVERY_SCHEMA,
    provider: request.provider,
    adapter_version: request.adapter_version,
    permission_id: request.permission_id,
    executable: request.command.executable,
    state: reason_code === "missing_provider_login"
      ? "unauthenticated"
      : guidanceAvailable ? "executable_missing" : "guidance_unavailable",
    detected: detectedFor(reason_code),
    evidence_benefit: evidenceBenefit(request),
    provider_read_scope: clone(request),
    installation_authority: installationAuthority(authority),
    active_environment: {
      platform,
      shell,
      guidance_available: guidanceAvailable,
    },
    choices: reason_code === "missing_provider_login"
      ? INITIAL_CHOICES.filter(({ id }) => id !== "show_install_instructions").map(clone)
      : guidanceAvailable
        ? INITIAL_CHOICES.map(clone)
        : INITIAL_CHOICES.filter(({ id }) => id !== "show_install_instructions").map(clone),
    installation_instructions: [],
    safety: clone(SAFETY),
  };
  assertValidProviderToolRecovery(recovery);
  return recovery;
}

export async function inspectProviderTool(recovery, {
  runner = runProviderCommand,
  cwd = process.cwd(),
  signal,
} = {}) {
  const authority = assertTrustedRecoveryAuthority(recovery);
  let result;
  try {
    result = await runner(clone(authority.verification_command), cwd, { signal });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      const unsupported = {
        ...clone(recovery),
        state: "unsupported_version",
        detected: {
          executable: "present",
          version: "unsupported",
          detected_version: null,
          authentication: "unknown",
        },
        choices: initialChoicesFor(recovery),
        installation_instructions: [],
      };
      delete unsupported.fresh_permission;
      assertValidProviderToolRecovery(unsupported);
      return unsupported;
    }
    const missing = {
      ...clone(recovery),
      state: recovery.active_environment.guidance_available
        ? "executable_missing"
        : "guidance_unavailable",
      detected: {
        executable: "missing",
        version: "unknown",
        detected_version: null,
        authentication: "unknown",
      },
      choices: initialChoicesFor(recovery),
      installation_instructions: [],
    };
    delete missing.fresh_permission;
    assertValidProviderToolRecovery(missing);
    return missing;
  }

  const output = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  const detectedVersion = output.match(
    /(?:^|[^0-9])((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?)(?:$|[^0-9A-Za-z.-])/u,
  )?.[1] ?? null;
  const supportedVersion = recovery.installation_authority.package.exact_version;
  if (detectedVersion !== supportedVersion) {
    const unsupported = {
      ...clone(recovery),
      state: "unsupported_version",
      detected: {
        executable: "present",
        version: "unsupported",
        detected_version: detectedVersion,
        authentication: "unknown",
      },
      choices: initialChoicesFor(recovery),
      installation_instructions: [],
    };
    delete unsupported.fresh_permission;
    assertValidProviderToolRecovery(unsupported);
    return unsupported;
  }

  const ready = {
    ...clone(recovery),
    state: "ready_for_fresh_permission",
    detected: {
      executable: "present",
      version: "supported",
      detected_version: detectedVersion,
      authentication: "unknown",
    },
    choices: [INITIAL_CHOICES[0], INITIAL_CHOICES[2]].map(clone),
    installation_instructions: [],
    fresh_permission: {
      permission_id: recovery.permission_id,
      boundary: "provider_read",
      decision: "pending",
      basis: "provider_tool_rediscovered",
      previous_approval_reused: false,
      scope: clone(recovery.provider_read_scope),
    },
  };
  assertValidProviderToolRecovery(ready);
  return ready;
}

export async function applyProviderToolRecoveryChoice(recovery, choice, dependencies = {}) {
  const authority = assertTrustedRecoveryAuthority(recovery);
  const allowedChoices = {
    executable_missing: ["continue_with_gap", "show_install_instructions", "rediscover_executable", "cancel"],
    unsupported_version: ["continue_with_gap", "show_install_instructions", "rediscover_executable", "cancel"],
    guidance_unavailable: ["continue_with_gap", "rediscover_executable", "cancel"],
    unauthenticated: ["continue_with_gap", "cancel"],
    ready_for_fresh_permission: ["continue_with_gap", "cancel"],
    installation_declined: [],
    authentication_declined: [],
    fresh_read_declined: [],
    recovery_cancelled: [],
  }[recovery.state] ?? [];
  if (!allowedChoices.includes(choice)) {
    const error = new Error("The Provider Tool Recovery choice is invalid for its current state.");
    error.code = "invalid_provider_tool_recovery_choice";
    throw error;
  }
  if (choice === "show_install_instructions") {
    const routes = recovery.active_environment.guidance_available
      ? authority.installation_routes.filter((route) =>
        route.platforms.includes(recovery.active_environment.platform)
        && route.shells.includes(recovery.active_environment.shell))
      : [];
    const shown = {
      ...clone(recovery),
      choices: (routes.length > 0
        ? POST_INSTALL_CHOICES
        : INITIAL_CHOICES.filter(({ id }) => id !== "show_install_instructions"))
        .map(clone),
      installation_instructions: routes.map(({ route_id, command }) => ({
        route_id,
        command: clone(command),
      })),
    };
    assertValidProviderToolRecovery(shown);
    return shown;
  }
  if (choice === "continue_with_gap") {
    const continued = {
      ...clone(recovery),
      state: recovery.state === "ready_for_fresh_permission"
        ? "fresh_read_declined"
        : recovery.state === "unauthenticated"
          ? "authentication_declined"
          : "installation_declined",
      installation_instructions: [],
      choices: [],
    };
    delete continued.fresh_permission;
    assertValidProviderToolRecovery(continued);
    return continued;
  }
  if (choice === "cancel") {
    const cancelled = {
      ...clone(recovery),
      state: "recovery_cancelled",
      installation_instructions: [],
      choices: [],
    };
    delete cancelled.fresh_permission;
    assertValidProviderToolRecovery(cancelled);
    return cancelled;
  }
  if (choice === "rediscover_executable") {
    return inspectProviderTool(recovery, dependencies);
  }
  const error = new Error("The Provider Tool Recovery choice is invalid.");
  error.code = "invalid_provider_tool_recovery_choice";
  throw error;
}

export function providerToolInstallationAuthorities() {
  return authorityEntries.map(clone);
}

function recoveryInput(recovery) {
  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "needs_input",
    operation: "providers",
    recovery,
    request: {
      kind: "provider_tool_recovery",
      choices: clone(recovery.choices),
    },
  };
}

export async function runProviderToolRecovery(recovery, options = {}, dependencies = {}) {
  try {
    assertTrustedRecoveryAuthority(recovery);
  } catch (error) {
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "execution_error",
      operation: "providers",
      error: error.code ?? "invalid_provider_tool_recovery",
      message: error.message,
    };
  }
  if (!options.choice) return recoveryInput(clone(recovery));

  let nextRecovery;
  try {
    nextRecovery = await applyProviderToolRecoveryChoice(
      recovery,
      options.choice,
      dependencies,
    );
  } catch (error) {
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "execution_error",
      operation: "providers",
      error: error.code ?? "provider_tool_recovery_failed",
      message: error.message,
    };
  }

  if (nextRecovery.state === "ready_for_fresh_permission") {
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "completed",
      operation: "providers",
      outcome: "ready_for_fresh_permission",
      recovery: nextRecovery,
      request: {
        type: "fresh_provider_read_permission",
        permission: clone(nextRecovery.fresh_permission),
      },
      next: {
        type: "restart_audit_or_verify",
        required: true,
        message:
          `Start a new Audit or Verify collection boundary and decide ${nextRecovery.permission_id} again before any Provider metadata is read.`,
      },
    };
  }
  if (nextRecovery.state === "installation_declined"
    || nextRecovery.state === "authentication_declined"
    || nextRecovery.state === "fresh_read_declined") {
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "completed",
      operation: "providers",
      outcome: nextRecovery.state === "authentication_declined"
        ? "continued_with_authentication_gap"
        : "continued_with_gap",
      recovery: nextRecovery,
      gap_preserved: true,
    };
  }
  if (nextRecovery.state === "recovery_cancelled") {
    return {
      contract: CLI_INTERACTION_CONTRACT,
      status: "completed",
      operation: "providers",
      outcome: "recovery_cancelled",
      recovery: nextRecovery,
      gap_preserved: true,
    };
  }
  return recoveryInput(nextRecovery);
}
