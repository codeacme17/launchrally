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
  let result = runArchitect(cwd, source, { review_date: reviewDate });
  if (result.status !== "needs_confirmation") return result;
  const blueprintConfirmation = await prompt.confirmBlueprint(result.blueprint);
  result = runArchitect(cwd, {}, {
    resume_token: result.resume_token,
    blueprint_confirmation: blueprintConfirmation,
  });
  while (result.status === "partial_completion") {
    const decisionId = result.pending_decision_ids[0];
    const decision = result.blueprint.decisions.find(({ decision_id: id }) => id === decisionId);
    const response = await prompt.reviewDecision(decision);
    result = runArchitect(cwd, {}, {
      resume_token: result.resume_token,
      decision_responses: { [decisionId]: response },
    });
  }
  return result;
}
