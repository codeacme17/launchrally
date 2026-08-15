import { PromptCancelledError } from "./human-audit.js";

export function renderHumanInit(value) {
  const lines = [
    "LaunchRally Initialization Preview",
    `Mode: ${value.mode}`,
    `Source Report: ${value.source_report_id}`,
    "",
  ];
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
  initialOptions,
}) {
  let result;
  try {
    await prompt.start("init");
    result = await runInit(
      cwd,
      version,
      initialOptions ?? { report_package: reportPackage },
    );

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
