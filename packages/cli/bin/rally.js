#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveExecutionAuthority } from "@launchrally/core";
import { commandName, optionValue } from "./cli-arguments.js";
import {
  INVOCATION_CONTEXT_ENV,
  createInvocationContext,
  createNextAction,
} from "./invocation-context.js";
import { VERSION } from "./version.js";

const REPOSITORY_OPERATIONS = new Set([
  "audit",
  "architect",
  "architecture-package",
  "init",
  "plan",
  "providers",
  "verify",
]);
const BUNDLED_ENGINE = fileURLToPath(new URL("./engine.js", import.meta.url));

function runEngine(entrypoint, arguments_, invocationContext) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...arguments_], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        [INVOCATION_CONTEXT_ENV]: JSON.stringify(invocationContext),
      },
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    const signals = process.platform === "win32"
      ? ["SIGINT", "SIGTERM", "SIGBREAK"]
      : ["SIGHUP", "SIGINT", "SIGTERM"];
    const handlers = new Map(signals.map((signal) => [signal, () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill(signal);
      } catch {
        // The Engine may have completed between the state check and signal delivery.
      }
    }]));
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    for (const [signal, handler] of handlers) process.on(signal, handler);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      if (Number.isInteger(code)) {
        resolve(code);
        return;
      }
      const signalNumber = osConstants.signals[signal];
      resolve(Number.isInteger(signalNumber) ? 128 + signalNumber : 1);
    });
  });
}

function bootstrapAction(authority, cwd, invocationContext) {
  if (authority.state === "needs_toolchain_restore") {
    return createNextAction(invocationContext, [
      "toolchain",
      "restore",
      "--cwd",
      cwd,
    ]);
  }
  if (authority.state === "needs_toolchain_migration") {
    return createNextAction(invocationContext, [
      "toolchain",
      "migrate",
      "--to",
      VERSION,
      "--cwd",
      cwd,
    ]);
  }
  return createNextAction(invocationContext, [
    "toolchain",
    "status",
    "--cwd",
    cwd,
  ]);
}

function printAuthorityFailure(command, authority, cwd, invocationContext, json) {
  const invalid = authority.state === "invalid_toolchain";
  const nextAction = bootstrapAction(authority, cwd, invocationContext);
  const result = {
    contract: "launchrally.dev/cli/v2",
    status: invalid ? "execution_error" : "unavailable",
    operation: command,
    launcher_version: VERSION,
    authority,
    error: authority.state,
    next_action: nextAction,
    message: invalid
      ? "The project Execution Authority is invalid; the Launcher did not fall back."
      : "The project Engine is not executable; complete the explicit toolchain action.",
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.message}\nNext command\n${nextAction.display}\n`);
    if (nextAction.disclosure) process.stdout.write(`${nextAction.disclosure}\n`);
  }
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const command = commandName(arguments_);
  const invocationContext = createInvocationContext({
    launcherVersion: VERSION,
  });
  if (!REPOSITORY_OPERATIONS.has(command)) {
    return await runEngine(BUNDLED_ENGINE, arguments_, invocationContext);
  }

  const authority = await resolveExecutionAuthority({
    cwd: optionValue(arguments_, "--cwd"),
    launcher_version: VERSION,
  });
  if (authority.state !== "ready") {
    const cwd = path.resolve(optionValue(arguments_, "--cwd") ?? process.cwd());
    printAuthorityFailure(
      command,
      authority,
      cwd,
      invocationContext,
      arguments_.includes("--json"),
    );
    return 2;
  }
  const entrypoint = authority.source === "project_toolchain"
    ? authority.selection.engine_entrypoint
    : BUNDLED_ENGINE;
  return await runEngine(path.resolve(entrypoint), arguments_, invocationContext);
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch(() => {
    const arguments_ = process.argv.slice(2);
    const command = commandName(arguments_);
    const auditFailure = command === "audit";
    const result = {
      contract: "launchrally.dev/cli/v2",
      status: "execution_error",
      operation: command,
      error: auditFailure ? "local_safe_scan_failed" : "unexpected_error",
      message: auditFailure
        ? "Local Safe Scan could not complete safely."
        : "The Launcher could not start the selected Engine.",
    };
    if (arguments_.includes("--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stderr.write(`${result.message}\n`);
    }
    process.exitCode = 1;
  });
