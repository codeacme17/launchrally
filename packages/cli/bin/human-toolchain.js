import path from "node:path";

import { PromptCancelledError } from "./human-audit.js";
import { createNextAction } from "./invocation-context.js";

function styledText(value, style, enabled) {
  return enabled ? `\u001B[${style}m${value}\u001B[0m` : value;
}

function preservedBoundary() {
  return [
    "Authoritative Project Toolchain updates: .launchrally/toolchain/package.json, package-lock.json, and authority.json only",
    "Rebuildable materialization replaced: .launchrally/toolchain/node_modules (ignored and non-authoritative)",
    "Report currentness: the current pointer may be marked non-current; immutable Reports and Evidence are preserved",
    "Preserved: Manifest, immutable Reports and Evidence, Architecture history, and application source/dependencies",
  ];
}

export function renderHumanToolchainMigrationPreview(value, { styled = false } = {}) {
  const { preview } = value;
  return [
    styledText("LaunchRally Project Toolchain Migration Preview", "1;36", styled),
    `Engine: ${preview.from_version} -> ${preview.to_version}`,
    "Authoritative files:",
    ...preview.changes.map((change) => [
      `  - ${change.operation.toUpperCase()} ${change.path}`,
      `    Before digest: ${change.before_digest ?? "none"}`,
      `    After digest: ${change.after_digest ?? "none"}`,
    ]).flat(),
    `Materialization: ${preview.materialization.package_count} packages at ${preview.materialization.target}`,
    `Materialization integrity: ${preview.materialization.integrity_digest}`,
    "Materialization boundary: ignored and non-authoritative before confirmation",
    ...preservedBoundary(),
    "Consequence: Execution Authority changes; a fresh full Verify is required.",
    "Choose View full exact diff to inspect every exact before/after content value and return here.",
  ].join("\n");
}

function exactContent(value) {
  return value === null ? "null" : JSON.stringify(value).replace(
    /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu,
    (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function renderHumanToolchainMigrationFullPreview(value, context = {}) {
  return [
    renderHumanToolchainMigrationPreview(value, context),
    "",
    "Full exact digest-bound diff:",
    ...value.preview.changes.flatMap((change) => [
      "",
      `${change.operation.toUpperCase()} ${change.path}`,
      `--- before (${change.before_digest ?? "none"})`,
      `- ${exactContent(change.before)}`,
      `+++ after (${change.after_digest ?? "none"})`,
      `+ ${exactContent(change.after)}`,
    ]),
  ].join("\n");
}

export function renderHumanToolchainPermission(value) {
  const permission = value.request.permissions[0];
  const command = permission.commands[0];
  return [
    "Project Toolchain migration requires an npm registry read after the offline cache attempt failed.",
    `Source: ${permission.source}`,
    `Package: ${permission.package}@${permission.version}`,
    `Temporary target: ${permission.temporary_target}`,
    `Command: ${[command.executable, ...command.arguments].join(" ")}`,
    "Lifecycle scripts remain disabled. The safe default is Deny.",
  ].join("\n");
}

export function renderHumanToolchainOutcome(value, {
  invocationContext,
  preview,
  root,
  styled = false,
} = {}) {
  if (value.outcome === "migrated") {
    const nextAction = createNextAction(invocationContext, [
      "verify",
      "--scope",
      "full",
      "--cwd",
      path.resolve(root),
    ]);
    return [
      styledText("LaunchRally Project Toolchain Migration Complete", "1;36", styled),
      `Engine: ${preview.from_version} -> ${preview.to_version}`,
      `Selected Engine: @launchrally/cli@${value.authority.engine.version}`,
      `Authority: ${value.authority.state} (${value.authority.source})`,
      ...preservedBoundary(),
      "Fresh full Verify required: execution_authority_changed",
      styledText(nextAction.display, "36", styled),
      ...(nextAction.disclosure ? [nextAction.disclosure] : []),
    ].join("\n");
  }
  if (value.outcome === "migration_declined") {
    return [
      styledText("Project Toolchain Migration Declined", "1;33", styled),
      `Engine remains: ${preview?.from_version ?? "unchanged"}`,
      "No Project Toolchain state was changed.",
    ].join("\n");
  }
  if (value.outcome === "already_pinned") {
    return [
      "Project Toolchain Already Pinned",
      `Selected Engine: @launchrally/cli@${value.authority.engine.version}`,
      `Authority: ${value.authority.state} (${value.authority.source})`,
      "No Project Toolchain state was changed.",
    ].join("\n");
  }
  const stale = value.error === "preview_stale";
  return [
    styledText(
      stale
        ? "Project Toolchain Migration Preview Is Stale"
        : "Project Toolchain Migration Could Not Complete",
      "1;31",
      styled,
    ),
    `Error: ${value.error ?? value.status}`,
    ...(value.message ? [`Message: ${value.message}`] : []),
    "Prior Project Toolchain authority was preserved; inspect the error and start a fresh migration.",
  ].join("\n");
}

export async function runHumanToolchainMigration({
  cwd,
  invocationContext,
  prompt,
  runLifecycle,
  styled = false,
  to,
  version,
}) {
  let preview;
  let result;
  try {
    await prompt.start("toolchain");
    result = await runLifecycle(cwd, version, { operation: "migrate", to });
    while (["needs_permission", "needs_confirmation"].includes(result.status)) {
      if (result.status === "needs_confirmation") preview = result.preview;
      const response = await prompt.respondToolchain(result, { styled });
      result = await runLifecycle(cwd, version, {
        operation: "migrate",
        to,
        resume_token: result.interaction.resume_token,
        ...(result.status === "needs_permission"
          ? { permission_decisions: response.permission_decisions }
          : { confirmation: response.confirmation }),
      });
    }
    await prompt.finishToolchain(result, {
      invocationContext,
      preview,
      root: cwd,
      styled,
    });
    return {
      exitCode: ["unavailable", "execution_error"].includes(result.status) ? 2 : 0,
      result,
    };
  } catch (error) {
    if (error instanceof PromptCancelledError) {
      if (["needs_permission", "needs_confirmation"].includes(result?.status)) {
        await runLifecycle(cwd, version, {
          operation: "migrate",
          to,
          resume_token: result.interaction.resume_token,
          ...(result.status === "needs_permission"
            ? { permission_decisions: { npm_registry_read: "denied" } }
            : { confirmation: "decline" }),
        });
      }
      return { exitCode: 130, result: null };
    }
    throw error;
  } finally {
    await prompt.close();
  }
}
