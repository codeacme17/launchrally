import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  INVOCATION_CONTEXT_ENV,
  consumeInvocationContext,
  createInvocationContext,
  createNextAction,
} from "../packages/cli/bin/invocation-context.js";

test("an exact npm-exec Launcher produces an equivalent executable Init command", () => {
  const context = createInvocationContext({
    argv: [
      "/usr/bin/node",
      "/tmp/npm-cache/_npx/hash/node_modules/.bin/rally",
    ],
    env: {
      npm_command: "exec",
      npm_lifecycle_event: "npx",
      npm_config_package: "@launchrally/cli@0.3.1",
      PATH: "/tmp/npm-cache/_npx/hash/node_modules/.bin:/usr/bin",
    },
    launcherVersion: "0.3.1",
  });
  const action = createNextAction(context, [
    "init",
    "--cwd",
    "/workspace/site",
    "--report",
    "/reports/audit.json",
  ], { platform: "linux" });

  assert.deepEqual({ context, action }, {
    context: {
      schema_version: "launchrally.dev/invocation-context/v1",
      source: "npm_exec",
      launcher_version: "0.3.1",
    },
    action: {
      command: {
        executable: "npm",
        arguments: [
          "exec",
          "--package=@launchrally/cli@0.3.1",
          "--",
          "rally",
          "init",
          "--cwd",
          "/workspace/site",
          "--report",
          "/reports/audit.json",
        ],
        shell: false,
      },
      display: "npm exec --package=@launchrally/cli@0.3.1 -- rally init --cwd '/workspace/site' --report '/reports/audit.json'",
    },
  });
});

test("the Engine consumes only the explicit Launcher context and removes it from child environments", () => {
  const env = {
    npm_command: "exec",
    npm_lifecycle_event: "npx",
    npm_config_package: "@launchrally/cli@9.9.9",
    [INVOCATION_CONTEXT_ENV]: JSON.stringify({
      schema_version: "launchrally.dev/invocation-context/v1",
      source: "user_path",
      launcher_version: "0.3.1",
    }),
  };

  const context = consumeInvocationContext({
    env,
    fallbackVersion: "0.2.2",
  });

  assert.deepEqual({ context, remainingContext: env[INVOCATION_CONTEXT_ENV] }, {
    context: {
      schema_version: "launchrally.dev/invocation-context/v1",
      source: "user_path",
      launcher_version: "0.3.1",
    },
    remainingContext: undefined,
  });
});

test("a confirmed user-managed PATH entry keeps bare rally follow-up commands", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-path-"));
  const entrypoint = path.join(directory, "launcher.js");
  const executable = path.join(directory, "rally");
  await writeFile(entrypoint, "export {};\n");
  await chmod(entrypoint, 0o755);
  await symlink(entrypoint, executable);
  const context = createInvocationContext({
    argv: ["/usr/bin/node", executable],
    env: { PATH: `${directory}${path.delimiter}/usr/bin` },
    launcherVersion: "0.3.1",
  });

  assert.deepEqual(createNextAction(context, [
    "init",
    "--cwd",
    "/workspace/site",
    "--report",
    "/workspace/audit.json",
  ], { platform: "linux" }), {
    command: {
      executable: "rally",
      arguments: [
        "init",
        "--cwd",
        "/workspace/site",
        "--report",
        "/workspace/audit.json",
      ],
      shell: false,
    },
    display: "rally init --cwd '/workspace/site' --report '/workspace/audit.json'",
  });
});

test("an earlier PATH shadow prevents a direct entry from claiming stable PATH authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "launchrally-path-"));
  const shadowDirectory = path.join(root, "shadow");
  const selectedDirectory = path.join(root, "selected");
  await mkdir(shadowDirectory);
  await mkdir(selectedDirectory);
  const shadow = path.join(shadowDirectory, "rally");
  const selected = path.join(selectedDirectory, "rally");
  await writeFile(shadow, "shadow\n");
  await writeFile(selected, "selected\n");

  const context = createInvocationContext({
    argv: ["/usr/bin/node", selected],
    env: { PATH: `${shadowDirectory}${path.delimiter}${selectedDirectory}` },
    launcherVersion: "0.3.1",
  });

  assert.equal(context.source, "unknown");
});

test("an unknown direct entry discloses and uses the exact npm-exec fallback", () => {
  const context = createInvocationContext({
    argv: ["/usr/bin/node", "/workspace/packages/cli/bin/rally.js"],
    env: { PATH: "/usr/bin" },
    launcherVersion: "0.3.1",
  });

  assert.deepEqual(createNextAction(context, ["toolchain", "status"], {
    platform: "linux",
  }), {
    command: {
      executable: "npm",
      arguments: [
        "exec",
        "--package=@launchrally/cli@0.3.1",
        "--",
        "rally",
        "toolchain",
        "status",
      ],
      shell: false,
    },
    display: "npm exec --package=@launchrally/cli@0.3.1 -- rally toolchain status",
    disclosure: "The original Launcher entry could not be confirmed; using an exact-version npm-exec fallback.",
  });
});

test("Windows rendering is PowerShell-safe without changing executable argv", () => {
  const context = {
    schema_version: "launchrally.dev/invocation-context/v1",
    source: "npm_exec",
    launcher_version: "0.3.1",
  };

  assert.equal(createNextAction(context, [
    "init",
    "--cwd",
    "C:\\Work $Site\\100% 'ready'",
    "--report",
    "C:\\Reports\\audit.json",
  ], { platform: "win32" }).display,
  "& 'npm' 'exec' '--package=@launchrally/cli@0.3.1' '--' 'rally' 'init' '--cwd' 'C:\\Work $Site\\100% ''ready''' '--report' 'C:\\Reports\\audit.json'");
});
