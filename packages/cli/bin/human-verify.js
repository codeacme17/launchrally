import path from "node:path";

import {
  PromptCancelledError,
  resumeHumanAuthenticatedJourney,
} from "./human-authenticated-journey.js";
import { createNextAction } from "./invocation-context.js";

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

const ASSESSMENT_STYLES = Object.freeze({
  launch_ready: "1;32",
  ready_with_warnings: "1;33",
  no_go: "1;31",
  inconclusive: "1;36",
});

function styledText(value, style, enabled) {
  return enabled ? `\u001B[${style}m${value}\u001B[0m` : value;
}

function priorityStyle(priority) {
  if (priority === "P0") return "1;31";
  if (priority === "P1") return "1;33";
  return "1;36";
}

function findingLines(items, description, styled) {
  if (items.length === 0) return ["None"];
  return items.flatMap((item) => {
    const priority = `[${item.priority.toUpperCase()}]`;
    return [
      `${styledText(priority, priorityStyle(item.priority.toUpperCase()), styled)} ${item.check_id}`,
      `  ${description(item)}`,
    ];
  });
}

function permissionLines(value) {
  const lines = ["Fresh Evidence permission boundary:"];
  for (const permission of value.request.permissions) {
    if (permission.boundary === "public_network") {
      lines.push(
        `  - Public verification: ${permission.scope.targets.join(", ")}`,
        ...permission.scope.probes.map(
          (probe) => `    ${probe.method} ${probe.target} — ${probe.purpose}`,
        ),
      );
    } else {
      lines.push(
        `  - Provider read ${permission.scope.provider}: ${permission.scope.target}`,
      );
    }
  }
  lines.push(
    "Choose approved or denied independently for each permission ID.",
    `Resume token: ${value.interaction.resume_token}`,
  );
  return lines;
}

export function renderHumanVerify(value, {
  cwd,
  invocationContext,
  styled = false,
} = {}) {
  const targeted = value.verification_scope.mode === "targeted";
  const title = `LaunchRally ${targeted ? "Targeted" : "Full"} Verification`;
  const lines = [
    styledText(title, "1;36", styled),
    `Whole release: ${value.verification_scope.whole_release ? "YES" : "NO"}`,
    "Checks:",
    ...value.verification_scope.check_ids.map((checkId) => `  - ${checkId}`),
  ];
  if (value.status === "needs_permission") {
    return [...lines, ...permissionLines(value)].join("\n");
  }

  lines.push(
    "",
    styledText("Assessment", "1", styled),
    styledText(
      value.assessment ?? "not available",
      ASSESSMENT_STYLES[value.assessment] ?? "1",
      styled,
    ),
    `Assessment scope: ${value.assessment_scope}`,
    `Manifest Drift: ${value.manifest_drift.length}`,
    "",
    styledText("Manifest Source Report", "1", styled),
    value.interaction?.source_report?.report_id ?? value.history.source_report_id,
  );
  if (targeted || !value.report || !value.history.current_report_id) {
    return lines.join("\n");
  }

  const reportPath = `.launchrally/reports/${value.history.current_report_id}/record.json`;
  const failed = value.report.results.checks.filter((check) => check.status === "failed");
  const gaps = value.report.results.verification_gaps;
  const nextAction = invocationContext
    ? createNextAction(invocationContext, [
      "plan",
      "--cwd",
      path.resolve(cwd),
      "--report",
      reportPath,
    ])
    : null;
  const nextCommand = nextAction?.display
    ?? `rally plan --cwd ${JSON.stringify(path.resolve(cwd))} --report ${JSON.stringify(reportPath)}`;
  lines.push(
    "",
    styledText("Current Report", "1", styled),
    value.history.current_report_id,
    "",
    styledText("Current Report input", "1", styled),
    styledText(reportPath, "36", styled),
    "",
    styledText(`Failed Checks (${failed.length})`, "1", styled),
    ...findingLines(failed, (check) => check.summary, styled),
    "",
    styledText(`Verification Gaps (${gaps.length})`, "1", styled),
    ...findingLines(gaps, (gap) => gap.reason, styled),
    "",
    styledText("Next command", "1", styled),
    styledText(nextCommand, "36", styled),
  );
  if (nextAction?.disclosure) {
    lines.push(
      "",
      styledText("Launcher entry", "1", styled),
      nextAction.disclosure,
    );
  }
  return lines.join("\n");
}
