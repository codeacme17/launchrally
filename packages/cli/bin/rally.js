#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";

import { CLI_INTERACTION_CONTRACT } from "@launchrally/contracts";
import {
  createNotImplementedResult,
  runAudit,
  runInit,
  runPlan,
} from "@launchrally/core";

const VERSION = "0.1.0";
const args = process.argv.slice(2);
const json = args.includes("--json");

function commandName() {
  if (args.includes("--version")) return "version";
  const optionsWithValues = new Set([
    "--answers",
    "--confirm",
    "--cwd",
    "--permissions",
    "--report",
    "--resume",
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
      `Environment: ${brief.intended_environment.value}`,
      ...brief.production_targets.values.map((target) => `Target: ${target}`),
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

  if (value.operation === "init" && value.status === "needs_confirmation") {
    process.stdout.write(`${renderHumanInit(value)}\n`);
    return;
  }

  if (value.operation === "plan" && value.status === "completed") {
    process.stdout.write(`${renderHumanPlan(value)}\n`);
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
    message: [
      "Usage: rally <command> [--json] [--cwd <path>]",
      "",
      "Commands:",
      "  audit    Build, confirm, authorize, and run a local-first Web Audit",
      "  init     Preview and confirm local adoption after a complete Audit Report",
      "  plan     Build a deterministic read-only Launch Plan from a current Report",
      "  verify   Reserved Phase 0 verification workflow",
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
    const result = await runAudit(cwd, VERSION, {
      resume_token: optionValue("--resume"),
      answers: answers.value,
      confirmation: optionValue("--confirm"),
      permission_decisions: permissionDecisions.value,
    });
    print(result);
    return result.status === "execution_error" ? 2 : 0;
  }

  if (command === "init") {
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
      report_package: reportPackage,
    });
    print(result);
    return ["unavailable", "execution_error"].includes(result.status) ? 2 : 0;
  }

  if (command === "plan") {
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
      handoff_requested: args.includes("--handoff"),
    });
    print(result);
    return ["unavailable", "execution_error"].includes(result.status) ? 2 : 0;
  }

  if (command === "verify") {
    print(createNotImplementedResult(command));
    return 2;
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
