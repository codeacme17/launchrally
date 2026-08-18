import {
  PromptCancelledError,
  resumeHumanAuthenticatedJourney,
} from "./human-authenticated-journey.js";

export async function runHumanVerify({
  cwd,
  version,
  prompt,
  runVerify,
  reportPackage,
  scope,
  checkIds,
  resumeAuthenticatedJourney,
}) {
  let result;
  const runActivity = (label, operation) => prompt.activity
    ? prompt.activity(label, operation)
    : operation();
  try {
    await prompt.start("verify");
    result = await runActivity(
      "Preparing Verify scope and fresh Evidence permissions…",
      (signal) => runVerify(cwd, version, {
        report_package: reportPackage,
        scope,
        check_ids: checkIds,
      }, { signal }),
    );

    while (["needs_permission", "needs_input"].includes(result.status)) {
      if (
        result.status === "needs_input"
        && result.request?.type === "authenticated_journey_results"
      ) {
        result = await resumeHumanAuthenticatedJourney({
          cwd,
          version,
          operation: "verify",
          result,
          runActivity,
          activityLabel: "Verifying authenticated Core Journeys…",
          resumeAuthenticatedJourney,
        });
        if (result.status === "execution_error") break;
        continue;
      }
      const response = await prompt.respondVerify(result);
      result = await runActivity(
        "Collecting approved Evidence and completing Verify…",
        (signal) => runVerify(cwd, version, {
          resume_token: result.interaction.resume_token,
          permission_decisions: response.permission_decisions,
        }, { signal }),
      );
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
