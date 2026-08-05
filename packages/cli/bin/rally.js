#!/usr/bin/env node

import process from "node:process";

import { CLI_INTERACTION_CONTRACT } from "@launchrally/contracts";
import {
  createNotImplementedResult,
  runTemplateAudit,
} from "@launchrally/core";

const VERSION = "0.1.0";
const args = process.argv.slice(2);
const json = args.includes("--json");

function commandName() {
  if (args.includes("--version")) return "version";
  const optionsWithValues = new Set(["--cwd"]);
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

function print(value) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  if (value.operation === "audit" && value.report) {
    process.stdout.write("LaunchRally template audit\n");
    process.stdout.write(`Project: ${value.snapshot.project.name}\n`);
    process.stdout.write(`Assessment: ${value.report.assessment}\n`);
    process.stdout.write(`${value.report.limitations[0]}\n`);
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
      "  audit    Run the safe scaffold discovery audit",
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
    print(await runTemplateAudit(cwd, VERSION));
    return 0;
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
  .catch((error) => {
    print({
      contract: CLI_INTERACTION_CONTRACT,
      status: "execution_error",
      operation: command,
      error: "unexpected_error",
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
