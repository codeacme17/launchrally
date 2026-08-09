#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { CLI_INTERACTION_CONTRACT } from "@launchrally/contracts";
import {
  environmentTargetLabel,
  reviewedEnvironmentLabel,
  runAudit,
  runInit,
  runPlan,
  runProviderGuidance,
  runVerify,
} from "@launchrally/core";
import {
  humanAuditPresentationOptions,
  renderHumanAuditCompletion,
  runHumanAudit,
} from "./human-audit.js";
import { inspectReportDestination } from "./report-destination.js";
import { createSystemFilePicker } from "./system-file-picker.js";

const VERSION = "0.1.0";
const args = process.argv.slice(2);
const json = args.includes("--json");

function commandName() {
  if (args.includes("--version")) return "version";
  const optionsWithValues = new Set([
    "--answers",
    "--confirm",
    "--constraints",
    "--checks",
    "--cwd",
    "--gap",
    "--output",
    "--permissions",
    "--report",
    "--role",
    "--resume",
    "--scope",
    "--select",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    if (optionsWithValues.has(args[index])) {
      index += 1;
      continue;
    }
    if (!args[index].startsWith("-")) return args[index];
  }
  return "help";
}

const command = commandName();

function optionValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function jsonOption(name) {
  const value = optionValue(name);
  if (value === undefined) {
    return args.includes(name)
      ? { error: true, value: undefined }
      : { error: false, value: undefined };
  }
  try {
    return { error: false, value: JSON.parse(value) };
  } catch {
    return { error: true, value: undefined };
  }
}

function providerLabel(role) {
  return `${role.provider} (${role.role})`;
}

function renderHumanInteraction(value) {
  const brief = value.audit_brief;
  const lines = [
    "LaunchRally Audit",
    "Audit Brief",
    `Project: ${brief.project.name} (${brief.project.type})`,
    `Package manager: ${brief.project.package_manager}`,
    "Local Safe Scan: authorized by starting this Audit",
  ];

  if (value.status === "needs_input") {
    lines.push(
      "Needs input",
      ...value.request.fields.map((field) => `  - ${field.prompt}`),
      "Inferred candidates (not confirmed):",
      ...(brief.provider_roles.candidates.length > 0
        ? brief.provider_roles.candidates.map((role) => `  - ${providerLabel(role)}`)
        : ["  - Provider roles: none discovered"]),
      ...(brief.support_layers.candidates.length > 0
        ? brief.support_layers.candidates.map((layer) => `  - Support layer: ${layer}`)
        : ["  - Support layers: none discovered"]),
    );
    if (value.request.validation_errors.length > 0) {
      lines.push(
        "Input errors:",
        ...value.request.validation_errors.map(
          (error) => `  - ${error.field_id}: ${error.code}`,
        ),
      );
    }
  } else {
    lines.push(
      "Complete plan preview",
      `Environment: ${reviewedEnvironmentLabel(brief.intended_environment.value)}`,
      ...brief.production_targets.values.map((target) =>
        `${environmentTargetLabel(brief.intended_environment.value, { capitalize: true })}: ${target}`,
      ),
      ...brief.core_journeys.values.map((journey) =>
        typeof journey === "string"
          ? `Core journey: ${journey}`
          : `Core journey: ${journey.method} ${journey.path} — ${journey.purpose}`,
      ),
      ...(brief.provider_roles.values.length > 0
        ? brief.provider_roles.values.map((role) => `Provider role: ${providerLabel(role)}`)
        : ["Provider roles: none"]),
      ...(brief.support_layers.values.length > 0
        ? brief.support_layers.values.map((layer) => `Support layer: ${layer}`)
        : ["Support layers: none"]),
      "Public probe plan:",
      ...brief.public_verification.probes.map(
        (probe) => `  - ${probe.method} ${probe.host}:${probe.port}${probe.path} — ${probe.purpose}`,
      ),
      "Provider Adapter plan:",
      ...(brief.provider_adapters.requests.length > 0
        ? brief.provider_adapters.requests.flatMap((request) => [
          `  - ${request.provider}: ${request.adapter_version ?? "no adapter"}`,
          `    Target: ${request.target}`,
          `    Fields: ${request.requested_fields.join(", ")}`,
          `    Command: ${request.command
            ? [request.command.executable, ...request.command.arguments].join(" ")
            : "none"}`,
        ])
        : ["  - None requested"]),
      "Planned Checks:",
      ...brief.planned_checks.map(
        (check) => `  - ${check.check_id} [${check.permission_id}]`,
      ),
      "Permission preview:",
      ...value.authorization_plan.map(
        (permission) => `  - ${permission.permission_id}: ${permission.decision.toUpperCase()}`,
      ),
    );
  }

  if (value.status === "needs_confirmation") {
    lines.push(
      "No public or Provider permission has been granted.",
      value.request.prompt,
      "Choose: confirm, revise, or cancel.",
    );
  } else if (value.status === "needs_permission") {
    lines.push(
      "Permission requested only for these pending boundaries:",
      ...value.request.permissions.map((permission) =>
        permission.boundary === "public_network"
          ? `  - Public verification: ${permission.scope.targets.join(", ")}`
          : `  - ${permission.scope.provider}: target ${permission.scope.target}; fields ${permission.scope.requested_fields.join(", ")}; command ${permission.scope.command
            ? [permission.scope.command.executable, ...permission.scope.command.arguments].join(" ")
            : "none"}`,
      ),
      "Choose approved or denied independently for each permission ID.",
    );
  }
  lines.push(`Resume token: ${value.interaction.resume_token}`);
  return lines.join("\n");
}

function renderHumanInit(value) {
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
  lines.push(
    value.request.prompt,
    "Choose: confirm or decline.",
    `Resume token: ${value.interaction.resume_token}`,
  );
  return lines.join("\n");
}

function renderHumanPlan(value) {
  const lines = [
    "LaunchRally Read-only Launch Plan",
    `Source Report: ${value.source_report_id}`,
    `Assessment: ${value.assessment}`,
    "Read-only: no source, deployment, production, or Provider mutation is authorized.",
    "",
    "Confirmed Finding work",
  ];
  if (value.items.length === 0) lines.push("- None.");
  for (const item of value.items) {
    lines.push(
      `${item.rank}. [${item.priority.toUpperCase()} ${item.severity.toUpperCase()}] ${item.check_id} — ${item.gating ? "RELEASE GATE" : "NON-GATING"}`,
      `   What is wrong: ${item.problem}`,
      `   Why it affects release: ${item.release_impact}`,
      `   Remediation: ${item.remediation}`,
      `   Investigate: ${item.investigation.risk_domain}`,
      `   Required inputs: ${item.investigation.required_inputs.join(", ")}`,
      `   Evidence targets: ${item.investigation.evidence_targets.join(", ") || "none recorded"}`,
      `   Verification rules: ${item.investigation.verification_rules.join(" | ")}`,
      `   Recollect: ${item.evidence_to_recollect.accepted_kinds.join(", ")} Evidence; minimum ${item.evidence_to_recollect.minimum_items}; ${item.evidence_to_recollect.instruction}`,
    );
  }
  lines.push("", "Verification Gaps (not confirmed fixes)");
  if (value.verification_gaps.length === 0) lines.push("- None.");
  for (const gap of value.verification_gaps) {
    lines.push(
      `- [${gap.priority.toUpperCase()} ${gap.severity.toUpperCase()}] ${gap.check_id} — ${gap.work_type.toUpperCase()}`,
      `  Reason: ${gap.reason}`,
      `  Next: ${gap.next_action}`,
    );
  }
  if (value.handoff) {
    lines.push(
      "",
      "Remediation Handoff (explicitly requested)",
      "Owner: host Agent",
      ...value.handoff.instructions.map((instruction) => `- ${instruction}`),
      `Provider write permission: ${value.handoff.authority.provider_write_permission.toUpperCase().replaceAll("_", " ")}`,
      `Deployment write permission: ${value.handoff.authority.deployment_write_permission.toUpperCase().replaceAll("_", " ")}`,
      `Production write permission: ${value.handoff.authority.production_write_permission.toUpperCase().replaceAll("_", " ")}`,
    );
  }
  lines.push("", value.next.message);
  return lines.join("\n");
}

function renderHumanProviders(value) {
  const lines = [
    "LaunchRally Advisory Provider Guidance",
    ...(value.source_report_id ? [`Source Report: ${value.source_report_id}`] : []),
    ...(value.trigger?.capability_id ? [`Capability: ${value.trigger.capability_id}`] : []),
  ];
  if (value.trigger?.summary) lines.push(`Trigger: ${value.trigger.summary}`);

  if (value.request?.kind === "provider_constraints") {
    lines.push(
      "Provider brands remain hidden until all six constraints are confirmed.",
      ...value.request.fields.map((field) => `- ${field.prompt}`),
    );
    if (value.request.validation_errors.length > 0) {
      lines.push(
        "Constraint errors:",
        ...value.request.validation_errors.map(
          (error) => `- ${error.field_id}: ${error.code}`,
        ),
      );
    }
  } else if (value.request?.kind === "constraint_confirmation") {
    lines.push(
      "Confirm Provider constraints",
      `Budget: ${value.constraints.budget}`,
      `Scale: ${value.constraints.scale}`,
      `Region: ${value.constraints.region}`,
      `Existing stack: ${value.constraints.existing_stack.join(", ") || "none"}`,
      `Operational ability: ${value.constraints.operational_ability}`,
      `Lock-in preference: ${value.constraints.lock_in_preference}`,
      value.request.prompt,
      `Choose: ${value.request.choices.join(", ")}.`,
    );
  } else if (value.request?.kind === "provider_selection") {
    lines.push(
      "Advisory shortlist — no universal best Provider",
      "Live pricing is not guaranteed; check each Card's current official sources.",
    );
    for (const [index, option] of value.shortlist.entries()) {
      const { card } = option;
      lines.push(
        `${index + 1}. ${card.provider.name} (${card.card_id} v${card.card_version})`,
        `   Scope: ${card.capability_scope.summary}`,
        "   Reasons:",
        ...option.reasons.map((reason) => `   - ${reason}`),
        "   Limits and caveats:",
        ...option.limits.map((limit) => `   - ${limit}`),
        `   Compatibility: ${card.compatibility.notes.join(" ")}`,
        `   Operations: ${card.operations.considerations.join(" ")}`,
        `   Lock-in: ${card.lock_in.level} — ${card.lock_in.considerations.join(" ")}`,
        `   Cost basis: ${card.cost_model.basis.join(", ")}`,
        `   Reviewed: ${card.review_date}`,
        "   Official sources:",
        ...card.official_sources.map((source) => `   - ${source.title}: ${source.url}`),
        "   Unknowns:",
        ...card.unknowns.map((unknown) => `   - ${unknown}`),
      );
    }
    lines.push(value.request.prompt);
  } else if (value.request?.kind === "manifest_intent_confirmation") {
    lines.push(
      "Manifest Intent Preview",
      `Selection: ${value.selection.provider_name} (${value.selection.provider_role})`,
      `Path: ${value.preview.path}`,
      `After roles: ${JSON.stringify(value.preview.after_roles)}`,
      "This selection is Manifest intent only: it is not Machine Evidence and cannot Pass a Check.",
      "No Provider or production mutation is authorized.",
      value.request.prompt,
      `Choose: ${value.request.choices.join(", ")}.`,
    );
  } else if (value.outcome === "manifest_intent_recorded") {
    lines.push(
      `Provider intent recorded: ${value.selection.provider_name} (${value.selection.provider_role}).`,
      "The selection remains Unverified and is not Machine Evidence.",
      value.next.message,
    );
  } else if (value.message) {
    lines.push(value.message);
  }
  if (value.interaction?.resume_token) {
    lines.push(`Resume token: ${value.interaction.resume_token}`);
  }
  return lines.join("\n");
}

function renderHumanVerify(value) {
  const targeted = value.verification_scope.mode === "targeted";
  const lines = [
    `LaunchRally ${targeted ? "Targeted" : "Full"} Verification`,
    `Whole release: ${value.verification_scope.whole_release ? "YES" : "NO"}`,
    "Checks:",
    ...value.verification_scope.check_ids.map((checkId) => `  - ${checkId}`),
  ];
  if (value.status === "needs_permission") {
    lines.push("Fresh Evidence permission boundary:");
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
  } else {
    lines.push(
      `Assessment scope: ${value.assessment_scope}`,
      `Launch Assessment: ${value.assessment ?? "not available"}`,
      `Manifest Drift: ${value.manifest_drift.length}`,
      `Source Report: ${value.history.source_report_id}`,
    );
  }
  return lines.join("\n");
}

function print(value) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  if (
    value.operation === "audit"
    && ["needs_input", "needs_confirmation", "needs_permission"].includes(value.status)
  ) {
    process.stdout.write(`${renderHumanInteraction(value)}\n`);
    return;
  }

  if (value.operation === "init") {
    if (value.status === "needs_confirmation") {
      process.stdout.write(`${renderHumanInit(value)}\n`);
      return;
    }
    if (value.status === "needs_permission") {
      const permission = value.request.permissions[0];
      process.stdout.write([
        "LaunchRally Init requires an npm registry read after the offline cache attempt failed.",
        `Source: ${permission.source}`,
        `Package: ${permission.package}@${permission.version}`,
        `Command: ${permission.command}`,
        "Lifecycle scripts remain disabled. Choose approved or denied for npm_registry_read.",
        `Resume token: ${value.interaction.resume_token}`,
      ].join("\n") + "\n");
      return;
    }
  }

  if (value.operation === "plan" && value.status === "completed") {
    process.stdout.write(`${renderHumanPlan(value)}\n`);
    return;
  }

  if (
    value.operation === "providers"
    && ["needs_input", "needs_confirmation", "completed"].includes(value.status)
  ) {
    process.stdout.write(`${renderHumanProviders(value)}\n`);
    return;
  }

  if (
    value.operation === "verify"
    && ["needs_permission", "completed"].includes(value.status)
  ) {
    process.stdout.write(`${renderHumanVerify(value)}\n`);
    return;
  }

  if (value.status === "needs_refresh") {
    process.stdout.write([
      value.message,
      `Next operation: ${value.request.operation} (${value.request.scope}).`,
    ].join("\n") + "\n");
    return;
  }

  if (
    value.operation === "audit"
    && value.outcome === "scope_not_confirmed"
    && !value.report
  ) {
    process.stdout.write(
      "LaunchRally Audit\nAudit Brief was not confirmed. No permission was granted and no Checks were run.\n",
    );
    return;
  }

  if (value.operation === "audit" && value.report) {
    process.stdout.write(`${value.report_view.content}\n${value.next.message}\n`);
    return;
  }

  process.stdout.write(`${value.message ?? JSON.stringify(value, null, 2)}\n`);
}

function help() {
  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "completed",
    operation: "help",
    commands: {
      core: ["audit", "init", "plan", "verify"],
      supporting: [{ operation: "providers", mode: "advisory" }],
    },
    message: [
      "Usage: rally <command> [--json] [--plain] [--cwd <path>] [--output <path>]",
      "",
      "Core commands:",
      "  audit    Build, confirm, authorize, and run a local-first Web Audit",
      "  init     Preview and confirm local adoption after a complete Audit Report",
      "  plan     Build a deterministic read-only Launch Plan from a current Report",
      "  verify   Recollect fresh Evidence for full or targeted verification",
      "",
      "Supporting advisory operation:",
      "  providers Guide a Provider choice from an evidenced gap or constraint mismatch",
      "",
      "Utility commands:",
      "  version  Print CLI and interaction contract versions",
    ].join("\n"),
  };
}

async function main() {
  if (command === "help") {
    print(help());
    return 0;
  }

  if (command === "version") {
    print({
      contract: CLI_INTERACTION_CONTRACT,
      status: "completed",
      operation: "version",
      cli_version: VERSION,
    });
    return 0;
  }

  if (command === "audit") {
    const cwd = optionValue("--cwd") ?? process.cwd();
    const answers = jsonOption("--answers");
    const permissionDecisions = jsonOption("--permissions");
    if (answers.error || permissionDecisions.error) {
      print({
        contract: CLI_INTERACTION_CONTRACT,
        status: "execution_error",
        operation: "audit",
        error: "invalid_option_json",
        message: "Audit answers and permission decisions must use valid JSON.",
      });
      return 2;
    }
    if (json) {
      const result = await runAudit(cwd, VERSION, {
        resume_token: optionValue("--resume"),
        answers: answers.value,
        confirmation: optionValue("--confirm"),
        permission_decisions: permissionDecisions.value,
      });
      print(result);
      return result.status === "execution_error" ? 2 : 0;
    }

    if (process.stdin.isTTY !== true) {
      process.stderr.write([
        "Non-TTY Human Mode cannot prompt safely.",
        "Use rally audit --json --cwd <path> for the resumable Agent/CI protocol.",
      ].join("\n") + "\n");
      return 2;
    }

    const { createClackPromptAdapter, createPlainPromptAdapter } = await import(
      "./prompt-adapters.js"
    );
    const presentation = humanAuditPresentationOptions({
      args,
      env: process.env,
      output: process.stdout,
    });
    const prompt = presentation.plain
      ? createPlainPromptAdapter({ input: process.stdin, output: process.stderr })
      : await createClackPromptAdapter({ input: process.stdin, output: process.stderr });
    const filePicker = createSystemFilePicker({ defaultDirectory: path.resolve(cwd) });
    let outcome;
    try {
      outcome = await runHumanAudit({
        cwd,
        version: VERSION,
        prompt,
        runAudit,
        outputPath: optionValue("--output"),
        filePicker,
        inspectDestination: inspectReportDestination,
        saveResult: async (
          requestedPath,
          result,
          { overwrite = false } = {},
          { signal } = {},
        ) => {
          const resolvedPath = path.resolve(requestedPath);
          try {
            await writeFile(resolvedPath, `${JSON.stringify(result, null, 2)}\n`, {
              encoding: "utf8",
              flag: overwrite ? "w" : "wx",
              signal,
            });
          } catch (error) {
            error.code = "audit_output_failed";
            throw error;
          }
          return resolvedPath;
        },
      });
    } catch (error) {
      if (error?.code !== "audit_output_failed") throw error;
      process.stderr.write("The complete Audit JSON could not be written. Choose a new, writable --output path.\n");
      return 2;
    }
    if (outcome.exitCode === 130) {
      process.stderr.write("Audit cancelled. The repository was not changed.\n");
      return 130;
    }
    process.stdout.write(`${renderHumanAuditCompletion(outcome.result, {
      cwd: path.resolve(cwd),
      outputPath: outcome.outputPath,
      styled: presentation.styled,
      width: presentation.width,
    })}\n`);
    return outcome.exitCode;
  }

  if (command === "init") {
    const cwd = optionValue("--cwd") ?? process.cwd();
    const permissionDecisions = jsonOption("--permissions");
    if (permissionDecisions.error) {
      print({
        contract: CLI_INTERACTION_CONTRACT,
        status: "execution_error",
        operation: "init",
        error: "invalid_option_json",
        message: "Init permission decisions must use valid JSON.",
      });
      return 2;
    }
    let reportPackage;
    const reportPath = optionValue("--report");
    if (reportPath) {
      try {
        reportPackage = JSON.parse(await readFile(reportPath, "utf8"));
      } catch {
        const result = {
          contract: CLI_INTERACTION_CONTRACT,
          status: "execution_error",
          operation: "init",
          error: "invalid_report_file",
          message: "The saved Audit JSON could not be read and parsed.",
        };
        print(result);
        return 2;
      }
    }
    const result = await runInit(cwd, VERSION, {
      resume_token: optionValue("--resume"),
      confirmation: optionValue("--confirm"),
      permission_decisions: permissionDecisions.value,
      report_package: reportPackage,
    });
    print(result);
    return ["unavailable", "execution_error"].includes(result.status) ? 2 : 0;
  }

  if (command === "plan") {
    const cwd = optionValue("--cwd") ?? process.cwd();
    let reportPackage;
    const reportPath = optionValue("--report");
    if (reportPath) {
      try {
        reportPackage = JSON.parse(await readFile(reportPath, "utf8"));
      } catch {
        const result = {
          contract: CLI_INTERACTION_CONTRACT,
          status: "execution_error",
          operation: "plan",
          error: "invalid_report_file",
          message: "The saved Audit JSON could not be read and parsed.",
        };
        print(result);
        return 2;
      }
    }
    const result = runPlan(reportPackage, {
      cwd,
      handoff_requested: args.includes("--handoff"),
    });
    print(result);
    return ["unavailable", "execution_error"].includes(result.status) ? 2 : 0;
  }

  if (command === "providers") {
    const cwd = optionValue("--cwd") ?? process.cwd();
    let reportPackage;
    const reportPath = optionValue("--report");
    if (reportPath) {
      try {
        reportPackage = JSON.parse(await readFile(reportPath, "utf8"));
      } catch {
        print({
          contract: CLI_INTERACTION_CONTRACT,
          status: "execution_error",
          operation: "providers",
          error: "invalid_report_file",
          message: "The saved Audit JSON could not be read and parsed.",
        });
        return 2;
      }
    }
    const constraints = jsonOption("--constraints");
    if (constraints.error) {
      print({
        contract: CLI_INTERACTION_CONTRACT,
        status: "execution_error",
        operation: "providers",
        error: "invalid_option_json",
        message: "Provider constraints must use valid JSON.",
      });
      return 2;
    }
    const result = await runProviderGuidance(cwd, reportPackage, {
      source_check_id: optionValue("--gap"),
      provider_role: optionValue("--role"),
      resume_token: optionValue("--resume"),
      constraints: constraints.value,
      confirmation: optionValue("--confirm"),
      selection: optionValue("--select"),
    });
    print(result);
    return ["unavailable", "execution_error"].includes(result.status) ? 2 : 0;
  }

  if (command === "verify") {
    const cwd = optionValue("--cwd") ?? process.cwd();
    let reportPackage;
    const reportPath = optionValue("--report");
    if (reportPath) {
      try {
        reportPackage = JSON.parse(await readFile(reportPath, "utf8"));
      } catch {
        print({
          contract: CLI_INTERACTION_CONTRACT,
          status: "execution_error",
          operation: "verify",
          error: "invalid_report_file",
          message: "The saved source Report JSON could not be read and parsed.",
        });
        return 2;
      }
    }
    const checks = jsonOption("--checks");
    const permissionDecisions = jsonOption("--permissions");
    if (checks.error || permissionDecisions.error) {
      print({
        contract: CLI_INTERACTION_CONTRACT,
        status: "execution_error",
        operation: "verify",
        error: "invalid_option_json",
        message: "Verify Check IDs and permission decisions must use valid JSON.",
      });
      return 2;
    }
    const result = await runVerify(cwd, VERSION, {
      report_package: reportPackage,
      scope: optionValue("--scope"),
      check_ids: checks.value,
      resume_token: optionValue("--resume"),
      permission_decisions: permissionDecisions.value,
    });
    print(result);
    return ["unavailable", "execution_error"].includes(result.status) ? 2 : 0;
  }

  print({
    contract: CLI_INTERACTION_CONTRACT,
    status: "execution_error",
    operation: command,
    error: "unknown_command",
    message: `Unknown command: ${command}`,
  });
  return 2;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch(() => {
    const auditFailure = command === "audit";
    print({
      contract: CLI_INTERACTION_CONTRACT,
      status: "execution_error",
      operation: command,
      error: auditFailure ? "local_safe_scan_failed" : "unexpected_error",
      message: auditFailure
        ? "Local Safe Scan could not complete safely."
        : "The operation could not complete.",
    });
    process.exitCode = 1;
  });
