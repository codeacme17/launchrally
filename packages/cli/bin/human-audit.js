export class PromptCancelledError extends Error {
  constructor() {
    super("The prompt was cancelled.");
    this.name = "PromptCancelledError";
  }
}

function titleCase(value) {
  return String(value ?? "not available")
    .split("_")
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}

function shellArgument(value) {
  return JSON.stringify(String(value));
}

export function renderHumanAuditCompletion(result, { cwd, outputPath } = {}) {
  if (result.outcome === "scope_not_confirmed" && !result.report) {
    return [
      "LaunchRally Audit",
      "Audit cancelled before permission review. No Checks were run and no Report was written.",
    ].join("\n");
  }
  if (!result.report) {
    return result.message ?? "LaunchRally Audit could not complete.";
  }

  const scopeCancelled = result.outcome === "scope_not_confirmed";
  const failed = result.report.results.checks.filter((check) => check.status === "failed");
  const gaps = result.report.results.verification_gaps;
  const nextCommand = result.next?.type === "init"
    ? `rally init --cwd ${shellArgument(cwd)} --report ${
      outputPath ? shellArgument(outputPath) : "<saved-report-path>"
    }`
    : result.next?.message ?? "No next command is required.";
  return [
    "LaunchRally Audit",
    ...(scopeCancelled
      ? ["Audit Brief was not confirmed. No public or Provider permission was granted."]
      : []),
    `Assessment: ${titleCase(result.report.assessment)}`,
    "Failed Findings:",
    ...(failed.length > 0
      ? failed.map((check) => `  - [${check.priority.toUpperCase()}] ${check.check_id} — ${check.summary}`)
      : ["  - None"]),
    "Verification Gaps:",
    ...(gaps.length > 0
      ? gaps.map((gap) => `  - [${gap.priority.toUpperCase()}] ${gap.check_id} — ${gap.reason}`)
      : ["  - None"]),
    outputPath
      ? `Complete Report JSON: ${outputPath}`
      : "Complete Report JSON was not saved. Use --output or confirm a save path to write it.",
    `Next command: ${nextCommand}`,
  ].join("\n");
}

export async function runHumanAudit({
  cwd,
  version,
  prompt,
  runAudit,
  outputPath,
  saveResult,
}) {
  let result;
  try {
    await prompt.start();
    result = await runAudit(cwd, version);

    while (["needs_input", "needs_confirmation", "needs_permission"].includes(result.status)) {
      const response = await prompt.respond(result);
      if (result.status === "needs_input") {
        result = await runAudit(cwd, version, {
          resume_token: result.interaction.resume_token,
          answers: response.answers,
        });
        continue;
      }

      if (result.status === "needs_confirmation") {
        result = await runAudit(cwd, version, {
          resume_token: result.interaction.resume_token,
          confirmation: response.confirmation,
        });
        continue;
      }

      result = await runAudit(cwd, version, {
        resume_token: result.interaction.resume_token,
        permission_decisions: response.permission_decisions,
      });
    }

    if (result.status === "completed" && result.report) {
      let savePath = outputPath;
      if (!savePath) savePath = (await prompt.respond(result)).output_path;
      if (savePath) savePath = await saveResult?.(savePath, result) ?? savePath;
      outputPath = savePath;
    }

    return {
      exitCode: result.status === "execution_error" ? 2 : 0,
      result,
      outputPath,
    };
  } catch (error) {
    if (error instanceof PromptCancelledError) {
      return { exitCode: 130, result: null, outputPath: undefined };
    }
    throw error;
  } finally {
    await prompt.close();
  }
}
