import {
  EXECUTION_RECEIPT_SCHEMA,
  EXECUTOR_DESCRIPTOR_SCHEMA,
  HANDOFF_PACKAGE_SCHEMA,
  assertValidExecutorDescriptor,
  computeExecutorDescriptorDigest,
} from "@launchrally/contracts";

const PLATFORMS = Object.freeze([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
]);

function descriptor({ id, name, toolId, executable, version, authorityId }) {
  const value = {
    schema_version: EXECUTOR_DESCRIPTOR_SCHEMA,
    descriptor_id: id,
    descriptor_version: "1.0.0",
    executor_name: name,
    supported_task_types: ["implement_architecture_decision", "remediate_confirmed_finding"],
    contract_versions: [HANDOFF_PACKAGE_SCHEMA, EXECUTION_RECEIPT_SCHEMA],
    platforms: [...PLATFORMS],
    environments: ["development", "preview", "production", "staging"],
    tools: [{
      tool_id: toolId,
      executable,
      exact_version: version,
      installation_authority_id: authorityId,
    }],
    auth_assumptions: ["user_completes_login_outside_launchrally"],
    allowed_effects: ["source_write"],
    prohibited_effects: [
      "credential_persistence",
      "deployment_write",
      "production_data_write",
      "provider_configuration_write",
    ],
    secret_handling: "external_reference_only",
    result_schema: EXECUTION_RECEIPT_SCHEMA,
    cancellation: "supported_between_effects",
    partial_failure: "reported_per_task",
    trust: {
      tier: "core_catalog",
      digest: "sha256:placeholder",
      reviewed_at: "2026-08-14T00:00:00.000Z",
      expires_at: "2026-11-12T00:00:00.000Z",
    },
  };
  value.trust.digest = computeExecutorDescriptorDigest(value);
  assertValidExecutorDescriptor(value);
  return Object.freeze(value);
}

export const referenceExecutorDescriptors = Object.freeze([
  descriptor({
    id: "executor_codex_reference",
    name: "OpenAI Codex CLI reference Executor",
    toolId: "codex_cli",
    executable: "codex",
    version: "0.147.0",
    authorityId: "authority_codex_cli_v1",
  }),
  descriptor({
    id: "executor_claude_reference",
    name: "Anthropic Claude Code reference Executor",
    toolId: "claude_code",
    executable: "claude",
    version: "2.1.231",
    authorityId: "authority_claude_code_v1",
  }),
]);
