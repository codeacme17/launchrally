#!/usr/bin/env node

import process from "node:process";

import { CLI_INTERACTION_CONTRACT } from "@launchrally/contracts";
import {
  createNotImplementedResult,
  runAudit,
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

  if (value.operation === "audit" && value.outcome === "scope_not_confirmed") {
    process.stdout.write(
      "LaunchRally Audit\nAudit Brief was not confirmed. No permission was granted and no Checks were run.\n",
    );
    return;
  }

  if (value.operation === "audit" && value.report) {
    const assessment = value.report.assessment
      .split("_")
      .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
      .join(" ");
    const lines = [
      "LaunchRally Audit",
      "Audit Brief",
      `Environment: ${value.audit_brief.intended_environment.value}`,
      ...value.audit_brief.production_targets.values.map((target) => `Target: ${target}`),
      ...value.audit_brief.core_journeys.values.map((journey) =>
        typeof journey === "string"
          ? `Core journey: ${journey}`
          : `Core journey: ${journey.method} ${journey.path} — ${journey.purpose}`,
      ),
      "Initial Readiness Snapshot",
      `Project: ${value.snapshot.project.name} (${value.snapshot.project.type})`,
      `Package manager: ${value.snapshot.project.package_manager}`,
      "Scope: local repository, read-only",
      "Obvious Blockers:",
      ...(value.snapshot.obvious_blockers.length > 0
        ? value.snapshot.obvious_blockers.map((blocker) => `  - ${blocker}`)
        : ["  None"]),
      "Checks:",
      ...value.report.results.checks.map(
        (check) =>
          `  ${{ passed: "PASS", failed: "FAIL" }[check.status] ?? check.status.toUpperCase()} [${check.priority.toUpperCase()}] ${check.check_id} — ${check.summary}`,
      ),
      `Assessment: ${assessment}`,
      "Action Queue:",
      ...(value.report.results.action_queue.length > 0
        ? value.report.results.action_queue.map(
          (item) => `  [${item.priority.toUpperCase()}] ${item.check_id} — ${item.action}`,
        )
        : ["  None"]),
      "Verification Gaps:",
      ...value.report.results.verification_gaps.map(
        (gap) =>
          `  ${gap.status.toUpperCase()} [${gap.priority.toUpperCase()}] ${gap.check_id} — ${gap.reason}`,
      ),
      "Limitations:",
      ...value.report.limitations.map((limitation) => `  - ${limitation}`),
      `Next input/approval: ${value.snapshot.next.message}`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
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
      "  init     Reserved Phase 0 initialization workflow",
      "  plan     Reserved Phase 0 read-only planning workflow",
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

  if (["init", "plan", "verify"].includes(command)) {
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
