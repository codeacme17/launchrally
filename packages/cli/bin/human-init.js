import { PromptCancelledError } from "./human-audit.js";

export function renderHumanInit(value) {
  const lines = [
    value.mode === "rebind"
      ? "LaunchRally Manifest Rebind Preview"
      : "LaunchRally Initialization Preview",
    `Mode: ${value.mode}`,
    `Source Report: ${value.source_report_id}`,
    "",
  ];
  if (value.manifest_action?.action === "preserve") {
    lines.push(
      "Manifest intent: preserved",
      `Existing Manifest source Report: ${value.manifest_action.existing_source_report_id}`,
      `Supplied Report for immutable history: ${value.manifest_action.supplied_source_report_id}`,
      `Replace command: ${value.replacement_action.display}`,
      "",
    );
  } else if (value.manifest_action?.action === "replace") {
    lines.push(
      "Manifest intent: replace after separate confirmation",
      `Old source Report: ${value.manifest_action.existing_source_report_id}`,
      `New source Report: ${value.manifest_action.supplied_source_report_id}`,
      `Immutable Report-history changes: ${value.preview.history_adoption.changes.length}`,
      `Release-intent replacement changes: ${value.preview.release_intent_replacement.changes.length}`,
      "",
    );
  }
  for (const change of value.preview.changes) {
    lines.push(
      `${change.operation.toUpperCase()} ${change.path}`,
      `Before digest: ${change.before_digest ?? "none"}`,
      `After digest: ${change.after_digest}`,
      "Diff:",
      change.diff,
      "After content:",
      change.after,
    );
  }
  if (value.preview.materialization) {
    const materialization = value.preview.materialization;
    lines.push(
      "Rebuildable Project Engine materialization:",
      `Command: ${[
        materialization.command.executable,
        ...materialization.command.arguments,
      ].join(" ")}`,
      `Package closure: ${materialization.package_count} packages`,
      `Integrity summary: ${materialization.integrity_digest}`,
      `Target: ${materialization.target}`,
      `Ignored: ${materialization.ignored ? "yes" : "no"}`,
      `Authoritative: ${materialization.authoritative ? "yes" : "no"}`,
    );
  }
  lines.push(value.request.prompt);
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
  try {
    await prompt.start("init");
    result = await runInit(cwd, version, { report_package: reportPackage });

    while (["needs_confirmation", "needs_permission"].includes(result.status)) {
      const response = await prompt.respondInit(result);
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
