import { accessSync, constants, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export const INVOCATION_CONTEXT_SCHEMA =
  "launchrally.dev/invocation-context/v1";
export const INVOCATION_CONTEXT_ENV = "LAUNCHRALLY_INVOCATION_CONTEXT";
const EXACT_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;

function exactNpmPackage(version) {
  return `@launchrally/cli@${version}`;
}

function confirmedPathInvocation(entrypoint, env) {
  if (!entrypoint) return false;
  if (!["rally", "rally.cmd", "rally.exe"].includes(
    path.basename(entrypoint).toLowerCase(),
  )) return false;
  let selectedEntrypoint;
  try {
    selectedEntrypoint = realpathSync(entrypoint);
  } catch {
    return false;
  }
  const executableNames = process.platform === "win32"
    ? ["rally.cmd", "rally.exe", "rally"]
    : ["rally"];
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of executableNames) {
      try {
        const candidate = path.resolve(directory, name);
        accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        if (realpathSync(candidate) === selectedEntrypoint) return true;
        return false;
      } catch {
        // Continue until the first PATH entry that actually supplies rally.
      }
    }
  }
  return false;
}

export function createInvocationContext({
  argv = process.argv,
  env = process.env,
  launcherVersion,
} = {}) {
  const entrypoint = argv[1];
  if (
    env.npm_command === "exec"
    && env.npm_lifecycle_event === "npx"
    && env.npm_config_package === exactNpmPackage(launcherVersion)
  ) {
    return {
      schema_version: INVOCATION_CONTEXT_SCHEMA,
      source: "npm_exec",
      launcher_version: launcherVersion,
    };
  }

  if (confirmedPathInvocation(entrypoint, env)) {
    return {
      schema_version: INVOCATION_CONTEXT_SCHEMA,
      source: "user_path",
      launcher_version: launcherVersion,
    };
  }

  return {
    schema_version: INVOCATION_CONTEXT_SCHEMA,
    source: "unknown",
    launcher_version: launcherVersion,
  };
}

export function consumeInvocationContext({
  env = process.env,
  fallbackVersion,
} = {}) {
  const serialized = env[INVOCATION_CONTEXT_ENV];
  delete env[INVOCATION_CONTEXT_ENV];
  try {
    const context = JSON.parse(serialized);
    if (
      context?.schema_version === INVOCATION_CONTEXT_SCHEMA
      && ["npm_exec", "unknown", "user_path"].includes(context.source)
      && EXACT_VERSION.test(context.launcher_version)
      && JSON.stringify(Object.keys(context).sort()) === JSON.stringify([
        "launcher_version",
        "schema_version",
        "source",
      ])
    ) return context;
  } catch {
    // Direct Engine execution has no trusted Launcher context.
  }
  return {
    schema_version: INVOCATION_CONTEXT_SCHEMA,
    source: "unknown",
    launcher_version: fallbackVersion,
  };
}

function invocationPrefix(context) {
  if (context.source === "user_path") {
    return { executable: "rally", arguments: [] };
  }
  return {
    executable: "npm",
    arguments: [
      "exec",
      `--package=${exactNpmPackage(context.launcher_version)}`,
      "--",
      "rally",
    ],
  };
}

function posixArgument(value, forceQuote = false) {
  const argument = String(value);
  if (!forceQuote && /^[A-Za-z0-9_@%+=:,./-]+$/u.test(argument)) return argument;
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

function powershellArgument(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function renderCommand(command, { platform = process.platform } = {}) {
  if (platform === "win32") {
    return `& ${[command.executable, ...command.arguments]
      .map(powershellArgument)
      .join(" ")}`;
  }
  const renderArgument = posixArgument;
  return [command.executable, ...command.arguments].map((argument, index, values) =>
    renderArgument(argument, ["--cwd", "--report"].includes(values[index - 1]))).join(" ");
}

export function createNextAction(context, arguments_, options = {}) {
  const prefix = invocationPrefix(context);
  const command = {
    executable: prefix.executable,
    arguments: [...prefix.arguments, ...arguments_.map(String)],
    shell: false,
  };
  return {
    command,
    display: renderCommand(command, options),
    ...(context.source === "unknown" ? {
      disclosure: "The original Launcher entry could not be confirmed; using an exact-version npm-exec fallback.",
    } : {}),
  };
}
