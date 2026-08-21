import path from "node:path";

import { PromptCancelledError } from "./human-audit.js";
import { createNextAction } from "./invocation-context.js";

const COMPLETION_PRESENTATION = Object.freeze({
  initialization: {
    manifestAction: "create",
    manifestLabel: "created",
    title: "LaunchRally Initialization Complete",
    outcome: "initialized",
  },
  migration: {
    manifestAction: "create",
    manifestLabel: "migrated",
    title: "LaunchRally Migration Complete",
    outcome: "migrated",
  },
  rebind: {
    manifestAction: "replace",
    manifestLabel: "replaced",
    title: "LaunchRally Manifest Rebind Complete",
    outcome: "rebound",
  },
  update: {
    manifestAction: "preserve",
    manifestLabel: "preserved",
    title: "LaunchRally Update Complete",
    outcome: "updated",
  },
});

const MANIFEST_ACTION_PRESENTATION = Object.freeze({
  create: "created",
  preserve: "preserved",
  replace: "replaced",
});

function styledText(value, style, enabled) {
  return enabled ? `\u001B[${style}m${value}\u001B[0m` : value;
}

function inferredCompletionMode(value) {
  if (value.outcome === "migrated") return "migration";
  if (value.outcome === "rebound") return "rebind";
  return undefined;
}

function manifestActionLabel(completion, action) {
  if (completion.manifestLabel && action === completion.manifestAction) {
    return completion.manifestLabel;
  }
  return MANIFEST_ACTION_PRESENTATION[action] ?? "unchanged";
}

function changeCounts(changes) {
  const counts = { create: 0, update: 0, delete: 0 };
  for (const change of changes) counts[change.operation] += 1;
  return counts;
}

function manifestSummary(value) {
  const action = value.manifest_action;
  if (!action) return [`Manifest source Report: ${value.source_report_id}`];
  const lines = [`Manifest action: ${action.action}`];
  if (action.action === "preserve") {
    lines.push(
      "Manifest intent: preserved",
      `Existing Manifest source Report: ${action.existing_source_report_id}`,
      `Supplied Report for immutable history: ${action.supplied_source_report_id}`,
      `Replace command: ${value.replacement_action.display}`,
    );
  } else if (action.action === "replace") {
    lines.push(
      "Manifest intent: replace after separate confirmation",
      `Old source Report: ${action.existing_source_report_id}`,
      `New source Report: ${action.supplied_source_report_id}`,
      `Immutable Report-history changes: ${value.preview.history_adoption.changes.length}`,
      `Release-intent replacement changes: ${value.preview.release_intent_replacement.changes.length}`,
    );
  } else {
    lines.push(`Manifest source Report: ${action.supplied_source_report_id}`);
  }
  return lines;
}

function materializationSummary(materialization) {
  if (!materialization) return ["Materialization: preserved existing Project Toolchain"];
  return [
    `Materialization: ${materialization.target}`,
    `Materialization command: ${[
      materialization.command.executable,
      ...materialization.command.arguments,
    ].join(" ")}`,
    `Materialization package closure: ${materialization.package_count} packages`,
    `Materialization integrity: ${materialization.integrity_digest}`,
    `Materialization boundary: ignored ${materialization.ignored ? "yes" : "no"}; authoritative before confirmation ${materialization.authoritative ? "yes" : "no"}`,
  ];
}

export function renderHumanInit(value, {
  root = "not provided",
  version = "unknown",
} = {}) {
  const changes = value.preview.changes;
  const counts = changeCounts(changes);
  const lines = [
    value.mode === "rebind"
      ? "LaunchRally Manifest Rebind Preview"
      : "LaunchRally Initialization Preview",
    `Mode: ${value.mode}`,
    `Source Report: ${value.source_report_id}`,
    `Affected root: ${root}`,
    `Changes: ${counts.create} create, ${counts.update} update, ${counts.delete} delete`,
    ...manifestSummary(value),
    `Project Toolchain: @launchrally/cli@${version}`,
    ...materializationSummary(value.preview.materialization),
    "",
    "Affected paths and exact content digests:",
  ];
  for (const change of changes) {
    lines.push(
      `${change.operation.toUpperCase()} ${change.path}`,
      `Before digest: ${change.before_digest ?? "none"}`,
      `After digest: ${change.after_digest ?? "none"}`,
    );
  }
  lines.push(
    "",
    "Authority boundaries:",
    "Write authority: exact listed .launchrally paths only",
    "Application source and dependency files: no writes",
    "Version control: no staging or commits",
    "Confirmation remains bound to this exact preview; stale or altered previews fail closed.",
    "Choose View full preview to inspect every exact diff and after-content before deciding.",
    "",
    value.request.prompt,
  );
  return lines.join("\n");
}

export function renderHumanInitFullPreview(value, context = {}) {
  const lines = [
    renderHumanInit(value, context),
    "",
    "Full exact digest-bound preview:",
  ];
  for (const change of value.preview.changes) {
    lines.push(
      "",
      `${change.operation.toUpperCase()} ${change.path}`,
      `Before digest: ${change.before_digest ?? "none"}`,
      `After digest: ${change.after_digest ?? "none"}`,
      "Diff:",
      change.diff,
      "After content:",
      change.after ?? "none",
    );
  }
  return lines.join("\n");
}

export function renderHumanInitCompletion(value, {
  invocationContext,
  presentation = {},
  root,
  styled = false,
  version = "unknown",
} = {}) {
  const mode = presentation.mode ?? value.mode ?? inferredCompletionMode(value);
  const completion = COMPLETION_PRESENTATION[mode] ?? {
    title: "LaunchRally Init Complete",
    outcome: value.outcome,
  };
  const manifestAction = presentation.manifest_action ?? value.manifest_action;
  const manifestActionValue = manifestAction?.action ?? completion.manifestAction;
  const nextAction = createNextAction(invocationContext, [
    "--version",
    "--json",
    "--cwd",
    path.resolve(root),
  ]);
  const lines = [
    styledText(completion.title, "1;36", styled),
    `Outcome: ${completion.outcome}`,
    `Manifest action: ${manifestActionLabel(completion, manifestActionValue)}`,
    `Manifest source Report: ${value.source_report_id}`,
  ];
  if (
    manifestAction?.action === "preserve"
    && manifestAction.supplied_source_report_id !== value.source_report_id
  ) {
    lines.push(
      `Supplied Report adopted into immutable history: ${manifestAction.supplied_source_report_id}`,
    );
  }
  lines.push(
    `Project Toolchain: @launchrally/cli@${version}`,
    `Applied changes: ${value.changes_applied.length}`,
    "Detailed paths remain available in the structured Init result from Agent/JSON Mode.",
    "",
    styledText("Required Execution Authority check", "1", styled),
    styledText(nextAction.display, "36", styled),
    "Continue only when authority.state: \"ready\" and authority.source: \"project_toolchain\".",
  );
  if (nextAction.disclosure) {
    lines.push("", styledText("Launcher entry", "1", styled), nextAction.disclosure);
  }
  return lines.join("\n");
}

export async function runHumanInit({
  cwd,
  version,
  prompt,
  runInit,
  reportPackage,
}) {
  let result;
  let presentation = {};
  try {
    await prompt.start("init");
    result = await runInit(cwd, version, { report_package: reportPackage });
    presentation = {
      manifest_action: result.manifest_action,
      mode: result.mode,
    };

    while (["needs_confirmation", "needs_permission"].includes(result.status)) {
      if (result.mode || result.manifest_action) {
        presentation = {
          manifest_action: result.manifest_action ?? presentation.manifest_action,
          mode: result.mode ?? presentation.mode,
        };
      }
      const response = await prompt.respondInit(result, { root: path.resolve(cwd), version });
      if (result.status === "needs_permission") {
        result = await runInit(cwd, version, {
          resume_token: result.interaction.resume_token,
          permission_decisions: response.permission_decisions,
        });
        continue;
      }
      result = await runInit(cwd, version, {
        resume_token: result.interaction.resume_token,
        confirmation: response.confirmation,
      });
    }

    return {
      exitCode: ["unavailable", "execution_error"].includes(result.status) ? 2 : 0,
      presentation,
      result,
    };
  } catch (error) {
    if (error instanceof PromptCancelledError) {
      return { exitCode: 130, result: null };
    }
    throw error;
  } finally {
    await prompt.close();
  }
}
