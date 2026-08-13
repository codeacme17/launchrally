export function normalizeArchitectAnswer(answer) {
  const normalized = answer.trim().toLowerCase();
  if (["y", "yes"].includes(normalized)) return "confirm";
  if (["n", "no"].includes(normalized)) return "reject";
  if (normalized === "cancel") return "cancel";
  return null;
}

export async function runHumanArchitect({
  cwd,
  source,
  reviewDate,
  prompt,
  runArchitect,
}) {
  const withHumanMode = (result) => ({
    ...result,
    human_mode: {
      typed_interactions: true,
      external_agent_automation: false,
      cross_host_resume: false,
      unavailable_capabilities: [
        "external_executor_automation",
        "cross_host_agent_resume",
      ],
    },
  });
  let result = await runArchitect(cwd, source, { review_date: reviewDate });
  if (result.status !== "needs_confirmation") return withHumanMode(result);
  if (result.state === "p1_migration_preview") {
    const answer = await prompt.confirmMigration(result.preview);
    const migrationConfirmation = answer === "reject" ? "deny" : answer;
    result = await runArchitect(cwd, {}, {
      resume_token: result.resume_token,
      migration_confirmation: migrationConfirmation,
    });
    if (result.status !== "needs_confirmation") return withHumanMode(result);
  }
  const blueprintConfirmation = await prompt.confirmBlueprint(result.blueprint);
  result = await runArchitect(cwd, {}, {
    resume_token: result.resume_token,
    blueprint_confirmation: blueprintConfirmation,
  });
  while (result.status === "partial_completion") {
    const decisionId = result.pending_decision_ids[0];
    const decision = result.blueprint.decisions.find(({ decision_id: id }) => id === decisionId);
    const response = await prompt.reviewDecision(decision);
    result = await runArchitect(cwd, {}, {
      resume_token: result.resume_token,
      decision_responses: { [decisionId]: response },
    });
  }
  return withHumanMode(result);
}
