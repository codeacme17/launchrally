import path from "node:path";

import { isLaunchRallyDestination } from "./report-destination.js";
import { DEFAULT_REPORT_FILENAME } from "./system-file-picker.js";
import { createNextAction } from "./invocation-context.js";

export class PromptCancelledError extends Error {
  constructor() {
    super("The prompt was cancelled.");
    this.name = "PromptCancelledError";
  }
}

const ASSESSMENT_PRESENTATION = Object.freeze({
  launch_ready: Object.freeze({ label: "Ready", style: "1;32" }),
  ready_with_warnings: Object.freeze({ label: "Ready with Warnings", style: "1;33" }),
  no_go: Object.freeze({ label: "No Go", style: "1;31" }),
  inconclusive: Object.freeze({ label: "Inconclusive", style: "1;36" }),
});
const UNKNOWN_ASSESSMENT_PRESENTATION = Object.freeze({ label: "Not Available", style: "1" });
const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });
const PROVIDER_LABELS = Object.freeze({
  cloudflare: "Cloudflare",
  netlify: "Netlify",
  posthog: "PostHog",
  sentry: "Sentry",
  stripe: "Stripe",
  supabase: "Supabase",
  vercel: "Vercel",
});

function styledText(value, style, enabled) {
  return enabled ? `\u001B[${style}m${value}\u001B[0m` : value;
}

function isFullwidthCodePoint(codePoint) {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0x303e)
    || (codePoint >= 0x3040 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1b000 && codePoint <= 0x1b001)
    || (codePoint >= 0x1f200 && codePoint <= 0x1f251)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function graphemeWidth(value) {
  if (/\p{Extended_Pictographic}|\uFE0F/u.test(value)) return 2;
  return [...value].reduce((width, character) => {
    if (/[\p{Mark}\p{Control}\p{Format}]/u.test(character)) return width;
    return width + (isFullwidthCodePoint(character.codePointAt(0)) ? 2 : 1);
  }, 0);
}

function displaySegments(value) {
  return [...GRAPHEME_SEGMENTER.segment(String(value))].map(({ segment }) => ({
    segment,
    width: graphemeWidth(segment),
  }));
}

function displayLength(value) {
  return displaySegments(value).reduce((width, segment) => width + segment.width, 0);
}

function normalizedWidth(width) {
  return Number.isFinite(width) && width > 0 ? Math.max(1, Math.floor(width)) : 80;
}

function wrapText(value, width, indent = "") {
  const normalized = String(value ?? "").trim().replace(/\s+/gu, " ");
  const limit = normalizedWidth(width);
  const effectiveIndent = displayLength(indent) < limit ? indent : "";
  if (displayLength(`${effectiveIndent}${normalized}`) <= limit) {
    return [`${effectiveIndent}${normalized}`];
  }

  const lines = [];
  let line = effectiveIndent;
  for (const word of normalized.split(" ")) {
    const separator = line === effectiveIndent ? "" : " ";
    if (displayLength(`${line}${separator}${word}`) <= limit) {
      line = `${line}${separator}${word}`;
      continue;
    }
    if (line !== effectiveIndent) {
      lines.push(line);
      line = effectiveIndent;
    }
    const segments = displaySegments(word);
    const capacity = Math.max(1, limit - displayLength(effectiveIndent));
    while (segments.reduce((total, segment) => total + segment.width, 0) > capacity) {
      const chunk = [];
      let chunkWidth = 0;
      while (
        segments.length > 0
        && (chunk.length === 0 || chunkWidth + segments[0].width <= capacity)
      ) {
        const [segment] = segments.splice(0, 1);
        chunk.push(segment.segment);
        chunkWidth += segment.width;
      }
      lines.push(`${effectiveIndent}${chunk.join("")}`);
    }
    line = `${effectiveIndent}${segments.map((segment) => segment.segment).join("")}`;
  }
  if (line !== effectiveIndent || lines.length === 0) lines.push(line);
  return lines;
}

function priorityStyle(priority) {
  if (priority === "P0") return "1;31";
  if (priority === "P1") return "1;33";
  return "1;36";
}

export function humanAuditPresentationOptions({ args = [], env = {}, output = {} } = {}) {
  const plain = args.includes("--plain") || env.TERM === "dumb";
  const noColor = Object.prototype.hasOwnProperty.call(env, "NO_COLOR");
  return {
    plain,
    styled: !plain && !noColor && output.isTTY === true,
    width: Number.isInteger(output.columns) && output.columns > 0 ? output.columns : 80,
  };
}

function assessmentPresentation(value) {
  return ASSESSMENT_PRESENTATION[value] ?? UNKNOWN_ASSESSMENT_PRESENTATION;
}

function shellArgument(value) {
  return JSON.stringify(String(value));
}

function approvedAuditActivityLabel(result, permissionDecisions) {
  const approved = result.request.permissions.filter(
    ({ permission_id: permissionId }) => permissionDecisions[permissionId] === "approved",
  );
  const publicApproved = approved.some(({ boundary }) => boundary === "public_network");
  const authenticatedApproved = approved.some(
    ({ boundary }) => boundary === "authenticated_network_read",
  );
  const providers = approved
    .filter(({ boundary }) => boundary === "provider_read")
    .map(({ scope }) => scope.provider);
  if (authenticatedApproved && (publicApproved || providers.length > 0)) {
    return "Preparing approved reads and authenticated Core Journey verification…";
  }
  if (authenticatedApproved) {
    return "Preparing authenticated Core Journey verification…";
  }
  if (publicApproved && providers.length > 0) {
    return "Running public and Provider verification and generating Report…";
  }
  if (publicApproved) return "Verifying public Journeys and generating Report…";
  if (providers.length === 1) {
    const provider = PROVIDER_LABELS[providers[0]]
      ?? `${providers[0][0]?.toUpperCase() ?? ""}${providers[0].slice(1)}`;
    return `Reading ${provider} Provider data and generating Report…`;
  }
  if (providers.length > 1) return "Reading approved Provider data and generating Report…";
  return "Evaluating Audit and generating Report…";
}

function authenticatedRunnerError(error = "authenticated_journey_runner_unavailable") {
  const invalid = error === "invalid_authenticated_journey_results";
  return {
    status: "execution_error",
    operation: "audit",
    error,
    message: invalid
      ? "The trusted authenticated Core Journey runner returned an invalid normalized result."
      : "The trusted authenticated Core Journey runner could not complete safely.",
  };
}

export function renderHumanAuditCompletion(result, {
  cwd,
  outputPath,
  invocationContext,
  styled = false,
  width = 80,
} = {}) {
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
  const assessment = assessmentPresentation(result.report.assessment);
  const renderWidth = normalizedWidth(width);
  const failed = result.report.results.checks.filter((check) => check.status === "failed");
  const gaps = result.report.results.verification_gaps;
  const nextAction = result.next?.type === "init" && invocationContext
    ? createNextAction(invocationContext, [
      "init",
      "--cwd",
      cwd,
      "--report",
      outputPath ?? "<saved-report-path>",
    ])
    : null;
  const nextCommand = result.next?.type === "init"
    ? nextAction?.display ?? `rally init --cwd ${shellArgument(cwd)} --report ${
      outputPath ? shellArgument(outputPath) : "<saved-report-path>"
    }`
    : result.next?.message ?? "No next command is required.";
  const itemLines = (items, description) => items.length > 0
    ? items.flatMap((item) => {
      const priority = `[${item.priority.toUpperCase()}]`;
      const itemHeading = `${priority} ${item.check_id}`;
      const headingLines = displayLength(itemHeading) <= renderWidth
        ? [itemHeading]
        : [priority, ...wrapText(item.check_id, renderWidth, "  ")];
      return [
        ...headingLines,
        ...wrapText(description(item), renderWidth, "  "),
      ];
    })
    : ["None"];
  const sections = [
    ["LaunchRally Audit"],
    ...(scopeCancelled
      ? [["Scope", "Audit Brief was not confirmed. No public or Provider permission was granted."]]
      : []),
    ["Assessment", assessment.label],
    [`Failed Findings (${failed.length})`, ...itemLines(failed, (check) => check.summary)],
    [`Verification Gaps (${gaps.length})`, ...itemLines(gaps, (gap) => gap.reason)],
    [
      "Report",
      outputPath
        ? outputPath
        : "Not saved. Use --output or confirm a save path to write the complete Report JSON.",
    ],
    ["Next command", nextCommand],
    ...(nextAction?.disclosure
      ? [["Launcher entry", nextAction.disclosure]]
      : []),
  ];
  return sections.map(([heading, ...lines], index) => {
    const headingLines = wrapText(heading, renderWidth).map((line) =>
      styledText(line, index === 0 ? "1;36" : "1", styled));
    const copyableValue = (heading === "Report" && outputPath)
      || (heading === "Next command" && result.next?.type === "init");
    const contentLines = copyableValue
      ? lines
      : lines.flatMap((line) => /^(?:Failed Findings|Verification Gaps)/u.test(heading)
        ? [line]
        : wrapText(line, renderWidth));
    const renderedLines = contentLines.map((line) => {
      if (heading === "Assessment") {
        return styledText(line, assessment.style, styled);
      }
      if (heading === "Report" || heading === "Next command") {
        return styledText(line, "36", styled);
      }
      if (/^(?:Failed Findings|Verification Gaps)/u.test(heading)) {
        return line.replace(/^\[(P\d+)\]/u, (priority, label) =>
          styledText(priority, priorityStyle(label), styled));
      }
      return line;
    });
    return [...headingLines, ...renderedLines].join("\n");
  }).join("\n\n");
}

export async function runHumanAudit({
  cwd,
  version,
  prompt,
  runAudit,
  outputPath,
  saveResult,
  inspectDestination = async () => ({ valid: true, collision: false }),
  filePicker,
  resumeAuthenticatedJourney,
}) {
  let result;
  let initialRepositoryScanCompleted = false;
  const runActivity = (label, operation) => prompt.activity
    ? prompt.activity(label, operation)
    : operation();
  try {
    await prompt.start();
    result = await runActivity(
      "Discovering project and scanning repository…",
      (signal) => runAudit(cwd, version, undefined, { signal }),
    );
    initialRepositoryScanCompleted = true;

    while (["needs_input", "needs_confirmation", "needs_permission"].includes(result.status)) {
      if (
        result.status === "needs_input"
        && result.request?.type === "authenticated_journey_results"
      ) {
        if (typeof resumeAuthenticatedJourney !== "function") {
          result = authenticatedRunnerError();
          break;
        }
        try {
          const authenticatedRequest = result;
          result = await runActivity(
            "Verifying authenticated Core Journeys and generating Report…",
            (signal) => resumeAuthenticatedJourney({
              cwd,
              version,
              operation: "audit",
              resume_token: authenticatedRequest.interaction.resume_token,
              request: authenticatedRequest.request,
              signal,
            }),
          );
        } catch (error) {
          if (error instanceof PromptCancelledError) throw error;
          result = authenticatedRunnerError(error?.code);
          break;
        }
        if (!result || typeof result !== "object") {
          result = authenticatedRunnerError();
          break;
        }
        if (result.status === "needs_input") {
          const validationError = result.request?.validation_errors?.find(
            ({ field_id: fieldId }) => fieldId === "journey_results",
          );
          result = authenticatedRunnerError(
            validationError?.code ?? "invalid_authenticated_journey_results",
          );
          break;
        }
        continue;
      }
      const response = await prompt.respond(result);
      if (result.status === "needs_input") {
        result = await runActivity(
          "Updating project scan and Audit Brief…",
          (signal) => runAudit(cwd, version, {
            resume_token: result.interaction.resume_token,
            answers: response.answers,
          }, { signal }),
        );
        continue;
      }

      if (result.status === "needs_confirmation") {
        result = await runActivity(
          "Preparing Audit permission requests…",
          (signal) => runAudit(cwd, version, {
            resume_token: result.interaction.resume_token,
            confirmation: response.confirmation,
          }, { signal }),
        );
        continue;
      }

      result = await runActivity(
        approvedAuditActivityLabel(result, response.permission_decisions),
        (signal) => runAudit(cwd, version, {
          resume_token: result.interaction.resume_token,
          permission_decisions: response.permission_decisions,
        }, { signal }),
      );
    }

    if (result.status === "completed" && result.report) {
      let savePath = outputPath;
      let overwrite = false;
      if (!savePath && prompt.reportSave) {
        const suggestedPath = path.resolve(cwd, DEFAULT_REPORT_FILENAME);
        const filePickerState = filePicker
          ? await runActivity(
            "Checking Report save options…",
            (signal) => filePicker.availability({ signal }),
          )
          : { available: false };
        let saveConfirmed = false;
        let notice;
        while (!savePath) {
          const choice = await prompt.reportSave({
            phase: "choose",
            suggested_path: suggestedPath,
            file_picker_available: filePickerState.available,
            ...(saveConfirmed ? { save_confirmed: true } : {}),
            ...(notice ? { notice } : {}),
          });
          notice = undefined;
          if (!choice.output_path && !choice.file_picker) break;
          saveConfirmed = true;
          let selectedPath = choice.output_path;
          if (choice.file_picker) {
            try {
              selectedPath = await runActivity(
                "Opening system file picker…",
                (signal) => filePicker.chooseSavePath({ signal }),
              );
            } catch (error) {
              if (error instanceof PromptCancelledError) throw error;
              notice = "The system file picker could not open. Choose another destination.";
              continue;
            }
            if (!selectedPath) continue;
          }
          const resolvedPath = path.resolve(selectedPath);
          const destinationState = await runActivity(
            "Checking Report destination…",
            async (signal) => {
              if (await isLaunchRallyDestination(cwd, resolvedPath, { signal })) {
                return { reserved: true };
              }
              return { inspection: await inspectDestination(resolvedPath, { signal }) };
            },
          );
          if (destinationState.reserved) {
            notice = "Audit cannot save inside .launchrally/**. Choose another destination; Init creates that directory only after separate confirmation.";
            continue;
          }
          const inspection = destinationState.inspection;
          if (!inspection.valid) {
            notice = "The selected Report destination is not usable. Choose another destination.";
            continue;
          }
          const collision = inspection.collision;
          if (choice.suggested && !collision) {
            savePath = resolvedPath;
            break;
          }
          const confirmation = await prompt.reportSave({
            phase: "confirm",
            resolved_path: resolvedPath,
            collision,
          });
          if (confirmation.decision === "choose_another") continue;
          if (confirmation.decision === "save" && !collision) savePath = resolvedPath;
          if (confirmation.decision === "overwrite" && collision) {
            savePath = resolvedPath;
            overwrite = true;
          }
          if (!savePath) break;
        }
      } else if (!savePath) {
        savePath = (await prompt.respond(result)).output_path;
      }
      if (savePath) {
        savePath = await runActivity(
          "Saving Audit Report…",
          async (signal) => await saveResult?.(
            savePath,
            result,
            { overwrite },
            { signal },
          ) ?? savePath,
        );
      }
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
    if (!initialRepositoryScanCompleted) {
      error.code = "initial_repository_scan_failed";
    } else if (!error.code) {
      error.code = "human_audit_interaction_failed";
    }
    throw error;
  } finally {
    await prompt.close();
  }
}
