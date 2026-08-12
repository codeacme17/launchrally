import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { throwIfAborted } from "./cancellation.js";

const execFileAsync = promisify(execFile);
export const PROVIDER_COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;
const PROVIDER_COMMAND_TIMEOUT_MS = 10_000;
const WINDOWS_EXECUTABLE_EXTENSIONS = Object.freeze([".COM", ".EXE", ".BAT", ".CMD"]);

function windowsExecutableExtensions(executable, env) {
  if (path.extname(executable)) return [""];
  const supported = new Set(WINDOWS_EXECUTABLE_EXTENSIONS);
  const extensions = (env.PATHEXT ?? WINDOWS_EXECUTABLE_EXTENSIONS.join(";"))
    .split(";")
    .map((extension) => extension.trim().toUpperCase())
    .filter((extension, index, values) =>
      supported.has(extension) && values.indexOf(extension) === index);
  return extensions.length > 0 ? extensions : [...WINDOWS_EXECUTABLE_EXTENSIONS];
}

async function resolveWindowsExecutable(executable, cwd, env, accessFile) {
  const searchPath = env.PATH ?? env.Path ?? "";
  for (const entry of searchPath.split(path.delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/u, "$1");
    if (!directory) continue;
    for (const extension of windowsExecutableExtensions(executable, env)) {
      const candidate = path.resolve(cwd, directory, `${executable}${extension}`);
      try {
        await accessFile(candidate);
        return candidate;
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes(error?.code)) throw error;
      }
    }
  }
  const error = new Error("The disclosed Provider executable is not on PATH.");
  error.code = "ENOENT";
  throw error;
}

function windowsBatchCommand(executable, arguments_) {
  const values = [executable, ...arguments_];
  if (values.some((value) => /["%\r\n]/u.test(value))) {
    const error = new Error("The disclosed Provider command cannot be represented safely.");
    error.code = "unsafe_provider_command";
    throw error;
  }
  return `"${values.map((value) => `"${value}"`).join(" ")}"`;
}

export async function runProviderCommand(command, cwd, {
  signal,
  platform = process.platform,
  environment = process.env,
  execute = execFileAsync,
  accessFile = access,
} = {}) {
  throwIfAborted(signal);
  const env = {
    ...environment,
    CI: "1",
    NO_COLOR: "1",
    RESEND_TELEMETRY_DISABLED: "1",
    SENTRY_DISABLE_UPDATE_CHECK: "true",
    VERCEL_TELEMETRY_DISABLED: "1",
    WRANGLER_SEND_METRICS: "false",
  };
  let invocation = command;
  if (platform === "win32") {
    const executable = await resolveWindowsExecutable(command.executable, cwd, env, accessFile);
    throwIfAborted(signal);
    invocation = /\.(?:bat|cmd)$/iu.test(executable)
      ? {
        executable: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
        arguments: ["/d", "/s", "/c", windowsBatchCommand(executable, command.arguments)],
        windowsVerbatimArguments: true,
      }
      : { executable, arguments: command.arguments };
  }
  return execute(invocation.executable, invocation.arguments, {
    cwd,
    encoding: "utf8",
    maxBuffer: PROVIDER_COMMAND_MAX_OUTPUT_BYTES,
    timeout: PROVIDER_COMMAND_TIMEOUT_MS,
    killSignal: "SIGTERM",
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    ...(signal ? { signal } : {}),
    env,
  });
}
