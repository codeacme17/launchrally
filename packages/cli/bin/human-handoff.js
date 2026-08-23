import { terminalSafeText } from "./human-architect.js";

function list(values, render = terminalSafeText, fallback = "None") {
  return values?.length > 0
    ? values.map((value) => `  - ${render(value)}`)
    : [`  - ${fallback}`];
}

function candidateLines(candidate) {
  return [
    `${candidate.recommended ? "Recommended" : "Alternative"}: ${terminalSafeText(candidate.batch_id)}`,
    `  Executor: ${terminalSafeText(candidate.executor_id)}`,
    `  Tasks: ${candidate.task_ids.map(terminalSafeText).join(", ")}`,
    `  Authority: ${terminalSafeText(candidate.effect_class)} on ${terminalSafeText(candidate.target)}`,
    `  Availability: ${candidate.available ? "available" : terminalSafeText(candidate.unavailable_reason)}`,
    `  Tools: ${candidate.tools.map((tool) => `${terminalSafeText(tool.executable)}@${terminalSafeText(tool.exact_version)}`).join(", ")}`,
    `  Authentication: ${terminalSafeText(candidate.authentication_state)} (${candidate.auth_assumptions.map(terminalSafeText).join(", ")})`,
    `  Secret handling: ${terminalSafeText(candidate.secret_handling)}`,
    `  Cancellation: ${terminalSafeText(candidate.cancellation)}`,
    `  Partial failure: ${terminalSafeText(candidate.partial_failure)}`,
  ];
}

export function renderHumanHandoffDiscovery(result) {
  const lines = [
    "External Executor Discovery",
    "LaunchRally does not install, log in, request credentials, or execute external Tasks.",
    "Ready authority boundaries:",
    ...list(result.preview?.user_visible_effects),
  ];
  if (result.candidates?.length > 0) {
    lines.push(
      "Reviewed Executor candidates:",
      ...result.candidates.flatMap(candidateLines),
    );
  }
  if (result.recovery) {
    lines.push(
      "Executor recovery:",
      `  Reason: ${terminalSafeText(result.recovery.reason)}`,
      `  Tool: ${terminalSafeText(result.recovery.tool.executable)}@${terminalSafeText(result.recovery.tool.exact_version)}`,
      `  Official manual: ${terminalSafeText(result.recovery.official_manual.url)}`,
      ...(result.recovery.installation_instructions?.length > 0
        ? [
          "  User-managed commands (not executed):",
          ...result.recovery.installation_instructions.map(({ command }) =>
            `    - ${[command.executable, ...command.arguments].map(terminalSafeText).join(" ")}`),
        ]
        : []),
    );
  }
  if (result.manual_path) {
    lines.push(
      "Manual or custom Executor path is available without granting authority.",
      `Required capabilities: ${result.manual_path.required_capabilities?.map(terminalSafeText).join(", ") || "none"}`,
    );
  }
  return lines.join("\n");
}

export function renderHumanHandoffAuthority(result) {
  const handoff = result.handoff_package;
  const authority = handoff.authority_batch;
  return [
    "Exact External Authority Preview",
    `Handoff Package: ${terminalSafeText(handoff.handoff_id)}`,
    `Environment: ${terminalSafeText(handoff.environment)}`,
    `Executor: ${terminalSafeText(handoff.executor.id)}`,
    "Tasks:",
    ...list(handoff.task_ids),
    "Allowed effects:",
    ...list(authority.allowed_effects),
    "Prohibited effects:",
    ...list(authority.prohibited_effects),
    "User-visible effects:",
    ...list(authority.user_visible_effects),
    `Authentication: ${terminalSafeText(authority.executor_requirements.authentication_state)} (${authority.executor_requirements.auth_assumptions.map(terminalSafeText).join(", ")})`,
    `Secret handling: ${terminalSafeText(authority.executor_requirements.secret_handling)}`,
    `Cancellation: ${terminalSafeText(authority.coordination.cancellation)}`,
    `Partial failure: ${terminalSafeText(authority.coordination.partial_failure)}`,
    "Confirmation grants only this exact external authority. LaunchRally still performs no external execution.",
  ].join("\n");
}

export function renderHumanHandoffReceipt(result) {
  const receipt = result.execution_receipt;
  const outcomes = result.execution_outcomes ?? [];
  return [
    receipt ? "Execution Receipt Review" : "Approved Handoff Package",
    `Handoff Package: ${terminalSafeText(result.handoff_package?.handoff_id)}`,
    `Approval: ${terminalSafeText(result.handoff_package?.approval?.state)}`,
    ...(receipt ? [
      `Receipt: ${terminalSafeText(receipt.receipt_id)}`,
      "Classification: claim only; not Machine Evidence; verification remains unverified.",
      "Reported Task outcomes:",
      ...list(outcomes, (outcome) => [
        terminalSafeText(outcome.task_id),
        terminalSafeText(outcome.receipt_state),
        outcome.remaining_work?.state === "required"
          ? `remaining work ${terminalSafeText(outcome.remaining_work.coordination)}`
          : "no remaining work reported",
      ].join(" — ")),
    ] : [
      "Run the approved package with the selected external Executor outside LaunchRally, then submit its normalized Execution Receipt.",
      "The receipt must be secret-free and exactly bound to this Handoff Package.",
    ]),
  ].join("\n");
}

export function renderHumanHandoffOutcome(result) {
  if (result.status === "completed" && result.next?.operation === "verify") {
    return [
      "Handoff Ready for Fresh Verify",
      "The Execution Receipt remains a claim and has not been promoted to Machine Evidence.",
      `Verify scope: ${terminalSafeText(result.next.scope)}`,
      "Task requests:",
      ...list(result.next.task_requests, (request) =>
        `${terminalSafeText(request.task_id)} — ${terminalSafeText(request.scope)}; Evidence: ${request.evidence_targets.map(terminalSafeText).join(", ")}`),
      "Next action: run fresh independent Verify for these exact targets.",
    ].join("\n");
  }
  if (result.outcome === "manual_or_custom_selected") {
    return [
      "Manual or Custom Executor Selected",
      "No external authority was granted and no external execution was started.",
    ].join("\n");
  }
  if (
    ["deferred", "receipt_deferred"].includes(result.outcome)
    || (result.status === "resumable" && result.state === "verification_pending")
  ) {
    let detail = "No external authority was granted.";
    if (result.state === "verification_pending") {
      detail = "The Execution Receipt remains a claim and fresh Verify remains pending.";
    } else if (result.outcome === "receipt_deferred") {
      detail = "The approved package remains external; no receipt was accepted.";
    }
    return [
      "Handoff Deferred",
      detail,
      "Run Handoff again with current inputs when you are ready to continue.",
    ].join("\n");
  }
  if (result.status === "denied") {
    return [
      "External Authority Declined",
      "No external authority was granted and no external Task was executed by LaunchRally.",
    ].join("\n");
  }
  if (result.status === "cancelled") {
    return [
      "Handoff Cancelled",
      `Authority granted before cancellation: ${result.safety?.authority_granted ? "yes" : "no"}`,
      "LaunchRally did not execute an external Task.",
    ].join("\n");
  }
  if (result.status === "stale_input") {
    return [
      "Handoff Inputs Are Stale",
      "Refresh the Task Graph and reviewed Executor inputs before granting authority.",
    ].join("\n");
  }
  if (result.status === "execution_error" || result.status === "unavailable") {
    return [
      "Handoff Could Not Continue",
      `Error: ${terminalSafeText(result.error)}`,
      ...(result.message ? [`Message: ${terminalSafeText(result.message)}`] : []),
      "No additional authority was granted by this failure.",
    ].join("\n");
  }
  return [
    "Handoff Complete",
    `Outcome: ${terminalSafeText(result.outcome ?? result.status)}`,
    "LaunchRally did not execute an external Task.",
  ].join("\n");
}

export async function runHumanHandoff({
  source,
  receipt,
  prompt,
  runHandoff,
  loadReceipt,
}) {
  let result;
  let suppliedReceipt = receipt;
  try {
    await prompt.start?.("handoff");
    result = await runHandoff(source, {});
    while (["needs_input", "needs_confirmation", "resumable", "partial_completion"]
      .includes(result.status)) {
      const response = await prompt.respondHandoff(result, {
        receiptAvailable: suppliedReceipt !== undefined,
      });
      const options = { resume_token: result.resume_token };
      if (result.request?.kind === "executor_selection") {
        options.selection = response.selection;
      } else if (result.request?.kind === "authority_confirmation") {
        options.confirmation = response.confirmation;
      } else if (result.request?.kind === "execution_receipt") {
        if (response.choice === "submit") {
          if (suppliedReceipt === undefined) {
            suppliedReceipt = await loadReceipt(response.receipt_path);
          }
          options.receipt = suppliedReceipt;
        } else {
          options.choice = response.choice;
        }
      } else {
        options.choice = response.choice;
      }
      result = await runHandoff({}, options);
      if (response.choice === "defer") break;
    }
    await prompt.finishHandoff(result);
    return result;
  } finally {
    await prompt.close();
  }
}
