import { stripVTControlCharacters } from "node:util";

export function terminalSafeText(value) {
  return stripVTControlCharacters(String(value ?? "none"))
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function items(values, fallback = "None") {
  return (values?.length ?? 0) > 0
    ? values.map((value) => `  - ${terminalSafeText(value)}`)
    : [`  - ${fallback}`];
}

function wrapOutput(value, width = 100) {
  const selectedWidth = Number.isInteger(width) && width >= 40 ? width : 100;
  return value.split("\n").flatMap((line) => {
    if (line.length <= selectedWidth) return [line];
    const indent = line.match(/^\s*/u)?.[0] ?? "";
    const capacity = Math.max(20, selectedWidth - indent.length);
    const words = line.trim().split(/\s+/u);
    const output = [];
    let current = "";
    for (const word of words) {
      const segments = word.length <= capacity
        ? [word]
        : word.match(new RegExp(`.{1,${capacity}}`, "gu"));
      for (const segment of segments) {
        if (current && current.length + 1 + segment.length > capacity) {
          output.push(`${indent}${current}`);
          current = "";
        }
        current = current ? `${current} ${segment}` : segment;
      }
    }
    if (current) output.push(`${indent}${current}`);
    return output;
  }).join("\n");
}

function referenceLines(label, reference) {
  return [
    `${label}: ${terminalSafeText(reference.id)}`,
    `  Schema: ${terminalSafeText(reference.schema_version)}`,
    `  Digest: ${terminalSafeText(reference.digest)}`,
  ];
}

function knowledgeReferenceLines(references) {
  if (references.length === 0) return ["  - None"];
  return references.flatMap((reference) => [
    `  - ${terminalSafeText(reference.id)}`,
    `    Schema: ${terminalSafeText(reference.schema_version)}`,
    `    Digest: ${terminalSafeText(reference.digest)}`,
  ]);
}

export function renderHumanArchitectMigration(preview) {
  return [
    "Additive Phase 1 Migration Preview",
    `Preview Schema: ${terminalSafeText(preview.schema_version)}`,
    `Migration: ${terminalSafeText(preview.migration)}`,
    "Created paths:",
    ...items(preview.files),
    "Preserved Phase 0 paths:",
    ...items(preview.preserved_paths),
    "Phase 0 history is preserved. Only the listed Phase 1 local records are added after confirmation.",
  ].join("\n");
}

export function renderHumanArchitectDecision(decision, progress, { width } = {}) {
  return wrapOutput([
    `Decision ${progress.current} of ${progress.total}`,
    `Decision ID: ${terminalSafeText(decision.decision_id)}`,
    `Capability: ${terminalSafeText(decision.capability_id)}`,
    `Recommendation: ${terminalSafeText(decision.action)} (${terminalSafeText(decision.disposition)})`,
    `Implementation path: ${terminalSafeText(decision.implementation_path)}`,
    "Rationale:",
    ...items(decision.rationale),
    "Trade-offs:",
    ...items(decision.tradeoffs),
    "Assumptions:",
    ...items(decision.assumptions),
    "Reevaluation triggers:",
    ...items(decision.reevaluation_triggers),
    "Provider Knowledge references:",
    ...knowledgeReferenceLines(decision.knowledge_refs),
  ].join("\n"), width);
}

export function renderHumanArchitectureBlueprint(blueprint, { width } = {}) {
  const lines = [
    "Whole-product Architecture Blueprint",
    `Blueprint Schema: ${terminalSafeText(blueprint.schema_version)}`,
    `Blueprint ID: ${terminalSafeText(blueprint.blueprint_id)}`,
    `Revision: ${terminalSafeText(blueprint.revision)}`,
    `Environment: ${terminalSafeText(blueprint.environment)}`,
    ...referenceLines("Source Report", blueprint.source_report),
    ...referenceLines("Product Intent Profile", blueprint.product_intent),
    ...referenceLines("Capability Graph", blueprint.capability_graph),
    "",
    "Hard constraints:",
    ...items(blueprint.constraints.hard),
    "Preferences:",
    ...items(blueprint.constraints.preferences),
    "",
    `Architecture decisions (${blueprint.decisions.length}):`,
  ];
  blueprint.decisions.forEach((decision, index) => {
    lines.push("", renderHumanArchitectDecision(decision, {
      current: index + 1,
      total: blueprint.decisions.length,
    }));
  });
  lines.push(
    "",
    "Whole-product analysis",
    `Integration compatibility: ${terminalSafeText(blueprint.whole_product.integration_compatibility)}`,
    "Operational burden:",
    ...items(blueprint.whole_product.operational_burden),
  );
  blueprint.whole_product.cost_scenarios.forEach((scenario, index) => {
    lines.push(
      "",
      `Cost scenario ${index + 1}: ${terminalSafeText(scenario.scenario)}`,
      `Review date: ${terminalSafeText(scenario.review_date)}`,
      `Currency estimate: ${terminalSafeText(scenario.currency_estimate)}`,
      "Drivers:",
      ...items(scenario.drivers),
      "Assumptions:",
      ...items(scenario.assumptions),
      "Unknowns:",
      ...items(scenario.unknowns),
    );
  });
  lines.push(
    "",
    "Data flow and residency:",
    ...items(blueprint.whole_product.data_flow_residency),
    "Failure domains:",
    ...items(blueprint.whole_product.failure_domains),
    `Provider concentration: ${terminalSafeText(blueprint.whole_product.provider_concentration)}`,
    "Lock-in and exit:",
    ...items(blueprint.whole_product.lock_in_exit),
    "Duplication:",
    ...items(blueprint.whole_product.duplication),
    "Migration cost:",
    ...items(blueprint.whole_product.migration_cost),
    "Blueprint unknowns:",
    ...items(blueprint.unknowns),
    "",
    "Every typed Blueprint field is shown above. Confirming the Blueprint does not confirm its decisions; each decision follows independently.",
  );
  return wrapOutput(lines.join("\n"), width);
}

export function renderHumanArchitectOutcome(result) {
  if (result.status === "completed") {
    const confirmed = result.decision_results.filter(({ response }) => response === "confirm").length;
    const rejected = result.decision_results.filter(({ response }) => response === "reject").length;
    return [
      "Architecture Review Complete",
      `Outcome: ${terminalSafeText(result.outcome)}`,
      `Decisions reviewed: ${result.decision_results.length}`,
      `Confirmed: ${confirmed}`,
      `Rejected: ${rejected}`,
      `Architecture Package: ${result.architecture_package ? "created in memory" : "not created because no decisions were confirmed"}`,
      "No Provider, production, staging, or version-control writes were authorized.",
    ].join("\n");
  }
  if (result.status === "denied") {
    return [
      "Architecture Review Declined",
      `Outcome: ${terminalSafeText(result.outcome)}`,
      "No Architecture decisions were confirmed.",
    ].join("\n");
  }
  if (result.status === "cancelled") {
    return [
      "Architecture Review Cancelled",
      `Outcome: ${terminalSafeText(result.outcome)}`,
      `Decisions reviewed before cancellation: ${result.decision_results?.length ?? 0}`,
      "No Architecture Package was created by the cancelled review.",
    ].join("\n");
  }
  if (result.status === "partial_completion") {
    const total = result.blueprint?.decisions.length ?? 0;
    return [
      "Architecture Review In Progress",
      `Decisions reviewed: ${result.decision_results?.length ?? 0} of ${total}`,
      `Next decision: ${terminalSafeText(result.pending_decision_ids?.[0])}`,
    ].join("\n");
  }
  if (result.status === "stale_input") {
    return [
      "Architecture Input Is Stale",
      "The Report or bound Architecture inputs changed. Refresh the inputs and review a new Blueprint.",
    ].join("\n");
  }
  return [
    "Architecture Review Could Not Complete",
    `Status: ${terminalSafeText(result.status)}`,
    ...(result.error ? [`Error: ${terminalSafeText(result.error)}`] : []),
    ...(result.message ? [`Message: ${terminalSafeText(result.message)}`] : []),
  ].join("\n");
}

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
  desktopSharedBackendCapabilityIds,
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
  await prompt.start?.("architect");
  const finish = async (value) => {
    const completed = withHumanMode(value);
    await prompt.finishArchitect?.(completed);
    return completed;
  };
  let result = await runArchitect(cwd, source, {
    review_date: reviewDate,
    desktop_shared_backend_capability_ids: desktopSharedBackendCapabilityIds,
  });
  if (result.status !== "needs_confirmation") return finish(result);
  if (result.migration_preview) {
    const answer = await prompt.confirmMigration(result.migration_preview);
    const migrationConfirmation = answer === "reject" ? "deny" : answer;
    result = await runArchitect(cwd, {}, {
      resume_token: result.resume_token,
      migration_confirmation: migrationConfirmation,
    });
    if (result.status !== "needs_confirmation") return finish(result);
  }
  const blueprintConfirmation = await prompt.confirmBlueprint(result.blueprint);
  result = await runArchitect(cwd, {}, {
    resume_token: result.resume_token,
    blueprint_confirmation: blueprintConfirmation,
  });
  const totalDecisions = result.blueprint?.decisions.length ?? 0;
  while (result.status === "partial_completion") {
    const decisionId = result.pending_decision_ids[0];
    const decision = result.blueprint.decisions.find(({ decision_id: id }) => id === decisionId);
    const response = await prompt.reviewDecision(decision, {
      current: totalDecisions - result.pending_decision_ids.length + 1,
      total: totalDecisions,
    });
    if (response === "cancel") {
      const request = { kind: "none", choices: ["none"] };
      result = {
        ...result,
        status: "cancelled",
        resume_token: null,
        request,
        outcome: "architecture_decision_review_cancelled",
        interaction: {
          ...result.interaction,
          status: "cancelled",
          resume_token: null,
          request,
        },
      };
      break;
    }
    result = await runArchitect(cwd, {}, {
      resume_token: result.resume_token,
      decision_responses: { [decisionId]: response },
    });
  }
  return finish(result);
}
