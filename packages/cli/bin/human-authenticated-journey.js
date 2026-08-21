export class PromptCancelledError extends Error {
  constructor() {
    super("The prompt was cancelled.");
    this.name = "PromptCancelledError";
  }
}

function authenticatedRunnerError(
  operation,
  error = "authenticated_journey_runner_unavailable",
) {
  const invalid = error === "invalid_authenticated_journey_results";
  return {
    status: "execution_error",
    operation,
    error,
    message: invalid
      ? "The trusted authenticated Core Journey runner returned an invalid normalized result."
      : "The trusted authenticated Core Journey runner could not complete safely.",
  };
}

export async function resumeHumanAuthenticatedJourney({
  cwd,
  version,
  operation,
  result,
  runActivity,
  activityLabel,
  resumeAuthenticatedJourney,
}) {
  if (typeof resumeAuthenticatedJourney !== "function") {
    return authenticatedRunnerError(operation);
  }
  let resumed;
  try {
    resumed = await runActivity(
      activityLabel,
      (signal) => resumeAuthenticatedJourney({
        cwd,
        version,
        operation,
        resume_token: result.interaction.resume_token,
        request: result.request,
        signal,
      }),
    );
  } catch (error) {
    if (error instanceof PromptCancelledError) throw error;
    return authenticatedRunnerError(operation, error?.code);
  }
  if (!resumed || typeof resumed !== "object") {
    return authenticatedRunnerError(operation);
  }
  if (resumed.status === "needs_input") {
    const validationError = resumed.request?.validation_errors?.find(
      ({ field_id: fieldId }) => fieldId === "journey_results",
    );
    return authenticatedRunnerError(
      operation,
      validationError?.code ?? "invalid_authenticated_journey_results",
    );
  }
  return resumed;
}
