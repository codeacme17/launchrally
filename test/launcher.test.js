import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  materializeExactToolchain,
  writeExactToolchain,
} from "./helpers/exact-toolchain.js";

const execFileAsync = promisify(execFile);
const launcher = path.resolve("packages/cli/bin/rally.js");
const pythonAvailable = process.platform !== "win32"
  && spawnSync("python3", ["--version"]).status === 0;

function validManifest() {
  const unknown = (reason) => ({ state: "unknown", reason });
  return {
    schema_version: "launchrally.dev/manifest/v2",
    project: {
      name: unknown("fixture"),
      type: unknown("fixture"),
      package_manager: unknown("fixture"),
    },
    release: {
      intended_environment: unknown("fixture"),
      production_targets: unknown("fixture"),
      core_journeys: unknown("fixture"),
    },
    execution: {
      source_report_id: unknown("fixture"),
      assessment: unknown("fixture"),
      public_verification: unknown("fixture"),
    },
    support: { layers: unknown("fixture") },
    providers: { roles: unknown("fixture") },
  };
}

async function projectWithEngine(
  engineSource,
  version = "0.3.0",
  { entrypoint = "bin/engine.js", materialized = true } = {},
) {
  const repository = await mkdtemp(path.join(os.tmpdir(), "launchrally-launcher-"));
  await mkdir(path.join(repository, ".git"));
  await mkdir(path.join(repository, ".launchrally"));
  await writeFile(
    path.join(repository, ".launchrally", "manifest.yaml"),
    `${JSON.stringify(validManifest())}\n`,
  );
  await writeExactToolchain(repository, version);
  await writeFile(
    path.join(repository, ".launchrally", "toolchain", "authority.json"),
    `${JSON.stringify({
      contract: "launchrally.dev/execution-authority/v1",
      engine: {
        package: "@launchrally/cli",
        version,
        entrypoint,
      },
    }, null, 2)}\n`,
  );
  if (!materialized) return repository;
  await materializeExactToolchain(repository, version);
  const cliDirectory = path.join(
    repository,
    ".launchrally",
    "toolchain",
    "node_modules",
    "@launchrally",
    "cli",
  );
  const packagePath = path.join(cliDirectory, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  if (entrypoint === "bin/engine.js") {
    packageJson.launchrally.engine = "./bin/engine.js";
  } else {
    delete packageJson.launchrally.engine;
  }
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(path.join(cliDirectory, entrypoint), engineSource);
  return repository;
}

test("rally delegates repository operations to the validated project Engine", async () => {
  const repository = await projectWithEngine([
    "process.stdout.write(JSON.stringify({",
    "  delegated: true,",
    "  arguments: process.argv.slice(2),",
    "}));",
    "",
  ].join("\n"));

  const result = JSON.parse((await execFileAsync(process.execPath, [
    launcher,
    "audit",
    "--json",
    "--cwd",
    repository,
  ])).stdout);

  assert.deepEqual(result, {
    delegated: true,
    arguments: ["audit", "--json", "--cwd", repository],
  });
});

test("rally delegates through an existing v1 bin/rally.js compatibility Engine", async () => {
  const repository = await projectWithEngine(
    "process.stdout.write('compatible project Engine');\n",
    "0.2.2",
    { entrypoint: "bin/rally.js" },
  );

  const { stdout } = await execFileAsync(process.execPath, [
    launcher,
    "audit",
    "--cwd",
    repository,
  ]);

  assert.equal(stdout, "compatible project Engine");
});

test("rally rejects a non-allowlisted bin/rally.js Engine before it can recurse", async () => {
  const repository = await projectWithEngine(
    "process.stdout.write('must not execute');\n",
    "0.3.0",
    { entrypoint: "bin/rally.js" },
  );
  let failure;

  await assert.rejects(execFileAsync(process.execPath, [
    launcher,
    "audit",
    "--json",
    "--cwd",
    repository,
  ]), (error) => {
    failure = error;
    return error.code === 2;
  });

  const result = JSON.parse(failure.stdout);
  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "invalid_toolchain");
  assert.doesNotMatch(failure.stdout, /must not execute/u);
});

test("rally rejects an allowlisted bin/rally.js descriptor over a split Launcher", async () => {
  const repository = await projectWithEngine(
    "process.stdout.write('must not execute');\n",
    "0.2.2",
    { entrypoint: "bin/rally.js" },
  );
  const packagePath = path.join(
    repository,
    ".launchrally/toolchain/node_modules/@launchrally/cli/package.json",
  );
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.launchrally.engine = "./bin/engine.js";
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  let failure;

  await assert.rejects(execFileAsync(process.execPath, [
    launcher,
    "audit",
    "--json",
    "--cwd",
    repository,
  ]), (error) => {
    failure = error;
    return error.code === 2;
  });

  const result = JSON.parse(failure.stdout);
  assert.equal(result.status, "execution_error");
  assert.equal(result.authority.reason, "invalid_engine_materialization");
  assert.doesNotMatch(failure.stdout, /must not execute/u);
});

test("a missing project Engine returns the Audit authority state and executable restore action", async () => {
  const repository = await projectWithEngine("", "0.3.0", { materialized: false });
  let failure;

  await assert.rejects(
    execFileAsync(process.execPath, [
      launcher,
      "audit",
      "--json",
      "--cwd",
      repository,
    ]),
    (error) => {
      failure = error;
      return error.code === 2;
    },
  );
  const result = JSON.parse(failure.stdout);

  assert.deepEqual({
    status: result.status,
    operation: result.operation,
    error: result.error,
    command: result.next_action.command,
    disclosed: result.next_action.disclosure,
  }, {
    status: "unavailable",
    operation: "audit",
    error: "needs_toolchain_restore",
    command: {
      executable: "npm",
      arguments: [
        "exec",
        "--package=@launchrally/cli@0.3.0",
        "--",
        "rally",
        "toolchain",
        "restore",
        "--cwd",
        repository,
      ],
      shell: false,
    },
    disclosed: "The original Launcher entry could not be confirmed; using an exact-version npm-exec fallback.",
  });
});

test("migration and invalid authority return exact bootstrap actions without running Verify", async () => {
  const migrationRepository = await projectWithEngine("", "0.3.0", {
    materialized: false,
  });
  await writeFile(
    path.join(migrationRepository, ".launchrally", "toolchain", "authority.json"),
    `${JSON.stringify({
      contract: "launchrally.dev/execution-authority/v0",
      engine: {
        package: "@launchrally/cli",
        version: "0.3.0",
        entrypoint: "bin/engine.js",
      },
    })}\n`,
  );
  const invalidRepository = await mkdtemp(path.join(os.tmpdir(), "launchrally-launcher-"));
  await mkdir(path.join(invalidRepository, ".git"));
  await mkdir(path.join(invalidRepository, ".launchrally"));
  const results = [];

  for (const repository of [migrationRepository, invalidRepository]) {
    try {
      await execFileAsync(process.execPath, [
        launcher,
        "verify",
        "--json",
        "--cwd",
        repository,
      ]);
      assert.fail("Unavailable project authority must stop Verify.");
    } catch (error) {
      results.push(JSON.parse(error.stdout));
    }
  }

  assert.deepEqual(results.map((result) => ({
    status: result.status,
    operation: result.operation,
    error: result.error,
    arguments: result.next_action.command.arguments.slice(4),
  })), [
    {
      status: "unavailable",
      operation: "verify",
      error: "needs_toolchain_migration",
      arguments: [
        "toolchain",
        "migrate",
        "--to",
        "0.3.0",
        "--cwd",
        migrationRepository,
      ],
    },
    {
      status: "execution_error",
      operation: "verify",
      error: "invalid_toolchain",
      arguments: ["toolchain", "status", "--cwd", invalidRepository],
    },
  ]);
});

test("the Launcher replaces an inherited internal context before delegation", async () => {
  const repository = await projectWithEngine([
    "const context = JSON.parse(process.env.LAUNCHRALLY_INVOCATION_CONTEXT);",
    "process.stdout.write(JSON.stringify(context));",
    "",
  ].join("\n"));

  const context = JSON.parse((await execFileAsync(process.execPath, [
    launcher,
    "audit",
    "--json",
    "--cwd",
    repository,
  ], {
    env: {
      ...process.env,
      LAUNCHRALLY_INVOCATION_CONTEXT: JSON.stringify({
        schema_version: "launchrally.dev/invocation-context/v1",
        source: "user_path",
        launcher_version: "9.9.9",
      }),
    },
  })).stdout);

  assert.deepEqual(context, {
    schema_version: "launchrally.dev/invocation-context/v1",
    source: "unknown",
    launcher_version: "0.3.0",
  });
});

test("Ctrl-C reaches the delegated Engine and preserves cancellation status", async () => {
  const repository = await projectWithEngine([
    "const timer = setTimeout(() => process.exit(99), 2000);",
    "process.on(\"SIGINT\", () => {",
    "  clearTimeout(timer);",
    "  process.stderr.write(\"Engine cancelled\\n\");",
    "  process.exit(130);",
    "});",
    "process.stdout.write(\"Engine ready\\n\");",
    "",
  ].join("\n"));

  const outcome = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      launcher,
      "audit",
      "--cwd",
      repository,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("Engine ready\n")) child.kill("SIGINT");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });

  assert.deepEqual(outcome, {
    code: 130,
    signal: null,
    stdout: "Engine ready\n",
    stderr: "Engine cancelled\n",
  });
});

test("delegation preserves stdin, stdout, stderr, and a non-zero Engine exit", async () => {
  const repository = await projectWithEngine([
    "process.stdin.setEncoding(\"utf8\");",
    "let input = \"\";",
    "process.stdin.on(\"data\", (chunk) => { input += chunk; });",
    "process.stdin.on(\"end\", () => {",
    "  process.stdout.write(`stdout:${input}`);",
    "  process.stderr.write(`stderr:${input}`);",
    "  process.exit(23);",
    "});",
    "",
  ].join("\n"));

  const outcome = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      launcher,
      "verify",
      "--cwd",
      repository,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end("preserved input\n");
  });

  assert.deepEqual(outcome, {
    code: 23,
    signal: null,
    stdout: "stdout:preserved input\n",
    stderr: "stderr:preserved input\n",
  });
});

test("delegation preserves Human TTY output through the child process", {
  skip: pythonAvailable ? false : "A local Python 3 PTY is required.",
}, async () => {
  const repository = await projectWithEngine([
    "const tty = [process.stdin.isTTY, process.stdout.isTTY, process.stderr.isTTY];",
    "process.stdout.write(`Human Engine output ${JSON.stringify(tty)}\\n`);",
    "",
  ].join("\n"));
  const ptyRunner = [
    "import errno, os, pty, subprocess, sys",
    "master, slave = pty.openpty()",
    "child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, close_fds=True)",
    "os.close(slave)",
    "chunks = []",
    "while True:",
    "    try:",
    "        chunk = os.read(master, 4096)",
    "    except OSError as error:",
    "        if error.errno == errno.EIO:",
    "            break",
    "        raise",
    "    if not chunk:",
    "        break",
    "    chunks.append(chunk)",
    "os.close(master)",
    "sys.stdout.buffer.write(b''.join(chunks))",
    "raise SystemExit(child.wait())",
  ].join("\n");

  const { stdout } = await execFileAsync("python3", [
    "-c",
    ptyRunner,
    process.execPath,
    launcher,
    "audit",
    "--cwd",
    repository,
  ]);

  assert.match(stdout, /Human Engine output \[true,true,true\]/u);
});

test("a terminating signal preserves the delegated Engine signal exit status", {
  skip: process.platform === "win32",
}, async () => {
  const repository = await projectWithEngine([
    "setTimeout(() => process.exit(99), 2000);",
    "process.stdout.write(\"Engine ready\\n\");",
    "",
  ].join("\n"));

  const outcome = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      launcher,
      "plan",
      "--cwd",
      repository,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("Engine ready\n")) child.kill("SIGTERM");
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout }));
  });

  assert.deepEqual(outcome, {
    code: 143,
    signal: null,
    stdout: "Engine ready\n",
  });
});

test("every repository operation resolves to the project Engine", async () => {
  const repository = await projectWithEngine([
    "const operations = new Set([\"audit\", \"init\", \"plan\", \"providers\", \"verify\"]);",
    "process.stdout.write(process.argv.slice(2).find((value) => operations.has(value)));",
    "",
  ].join("\n"));
  const operations = ["audit", "init", "plan", "providers", "verify"];
  const selected = [];

  for (const operation of operations) {
    selected.push((await execFileAsync(process.execPath, [
      launcher,
      "--cwd",
      repository,
      operation,
    ])).stdout);
  }

  assert.deepEqual(selected, operations);
});

test("older, matching, and newer project pins all outrank the Launcher", async () => {
  const selected = [];
  for (const version of ["0.1.0", "0.2.2", "0.3.0"]) {
    const repository = await projectWithEngine(
      `process.stdout.write(${JSON.stringify(version)});\n`,
      version,
    );
    selected.push((await execFileAsync(process.execPath, [
      launcher,
      "audit",
      "--cwd",
      repository,
    ])).stdout);
  }

  assert.deepEqual(selected, ["0.1.0", "0.2.2", "0.3.0"]);
});

test("version and toolchain status remain Launcher bootstrap operations", async () => {
  const repository = await projectWithEngine(
    "process.stdout.write(\"project Engine must not run\");\n",
    "0.3.0",
  );

  const version = JSON.parse((await execFileAsync(process.execPath, [
    launcher,
    "--version",
    "--json",
    "--cwd",
    repository,
  ])).stdout);
  const status = JSON.parse((await execFileAsync(process.execPath, [
    launcher,
    "toolchain",
    "status",
    "--json",
    "--cwd",
    repository,
  ])).stdout);

  assert.deepEqual({
    version: {
      cli: version.cli_version,
      launcher: version.launcher_version,
      source: version.authority.source,
    },
    status: {
      operation: status.operation,
      engine: status.authority.engine.version,
    },
  }, {
    version: {
      cli: "0.3.0",
      launcher: "0.3.0",
      source: "project_toolchain",
    },
    status: {
      operation: "toolchain_status",
      engine: "0.3.0",
    },
  });
});
