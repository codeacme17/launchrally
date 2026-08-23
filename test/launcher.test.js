import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";

import { computeExecutorDescriptorDigest } from "../packages/contracts/src/index.js";
import { runHandoff } from "../packages/core/src/index.js";
import { sha256 } from "../packages/core/src/local-history.js";
import {
  materializeExactToolchain,
  writeExactToolchain,
} from "./helpers/exact-toolchain.js";

const execFileAsync = promisify(execFile);
const launcher = path.resolve("packages/cli/bin/rally.js");
const engine = path.resolve("packages/cli/bin/engine.js");
const currentVersion = JSON.parse(await readFile("package.json", "utf8")).version;
const pythonAvailable = process.platform !== "win32"
  && spawnSync("python3", ["--version"]).status === 0;
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
const answeringPtyRunner = [
  "import errno, os, pty, select, subprocess, sys",
  "answers = sys.argv[1].splitlines()",
  "master, slave = pty.openpty()",
  "child = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave, close_fds=True)",
  "os.close(slave)",
  "chunks = []",
  "observed = b''",
  "answered = 0",
  "while True:",
  "    ready, _, _ = select.select([master], [], [], 5)",
  "    if not ready:",
  "        child.terminate()",
  "        break",
  "    try:",
  "        chunk = os.read(master, 4096)",
  "    except OSError as error:",
  "        if error.errno == errno.EIO:",
  "            break",
  "        raise",
  "    if not chunk:",
  "        break",
  "    chunks.append(chunk)",
  "    observed += chunk",
  "    prompts = observed.count(b'Choose 1-')",
  "    while answered < min(prompts, len(answers)):",
  "        os.write(master, answers[answered].encode() + b'\\n')",
  "        answered += 1",
  "os.close(master)",
  "sys.stdout.buffer.write(b''.join(chunks))",
  "raise SystemExit(child.wait())",
].join("\n");
const clackPtyRunner = [
  "import errno, fcntl, os, pty, select, struct, subprocess, sys, termios",
  "patterns = [value.encode() for value in sys.argv[1].split('|||')]",
  "master, slave = pty.openpty()",
  "fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))",
  "child = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave, close_fds=True)",
  "os.close(slave)",
  "chunks = []",
  "observed = b''",
  "answered = 0",
  "while True:",
  "    ready, _, _ = select.select([master], [], [], 5)",
  "    if not ready:",
  "        child.terminate()",
  "        break",
  "    try:",
  "        chunk = os.read(master, 4096)",
  "    except OSError as error:",
  "        if error.errno == errno.EIO:",
  "            break",
  "        raise",
  "    if not chunk:",
  "        break",
  "    chunks.append(chunk)",
  "    observed += chunk",
  "    if answered < len(patterns) and patterns[answered] in observed:",
  "        os.write(master, b'\\r')",
  "        answered += 1",
  "os.close(master)",
  "sys.stdout.buffer.write(b''.join(chunks))",
  "raise SystemExit(child.wait())",
].join("\n");
const fixedClock = pathToFileURL(
  path.resolve("test/helpers/fixed-provider-knowledge-clock.js"),
).href;

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
  version = "0.3.2",
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

async function writeHandoffInputs(repository, { available = true } = {}) {
  const fixture = JSON.parse(await readFile(
    path.resolve("test/fixtures/phase-1-contracts/handoff.valid.json"),
    "utf8",
  ));
  const executor = structuredClone(fixture.executor);
  const currentPlatform = `${process.platform}-${process.arch}`;
  if (!executor.platforms.includes(currentPlatform)) {
    executor.platforms.push(currentPlatform);
  }
  executor.prohibited_effects = [
    ...fixture.task_graph.tasks[0].prohibited_effects,
  ];
  executor.trust.digest = computeExecutorDescriptorDigest(executor);
  const source = {
    task_graph: structuredClone(fixture.task_graph),
    executor_descriptors: [executor],
    reviewed_executors: [{
      descriptor_id: executor.descriptor_id,
      descriptor_version: executor.descriptor_version,
      digest: executor.trust.digest,
    }],
    tool_observations: [{
      tool_id: "codex_cli",
      executable: "codex",
      detected_version: available ? "0.147.0" : null,
      state: available ? "available" : "missing",
    }],
  };
  const paths = {};
  for (const [field, file] of [
    ["task_graph", "task-graph.json"],
    ["executor_descriptors", "executors.json"],
    ["tool_observations", "tools.json"],
    ["reviewed_executors", "reviewed-executors.json"],
  ]) {
    paths[field] = path.join(repository, file);
    await writeFile(paths[field], `${JSON.stringify(source[field], null, 2)}\n`);
  }
  return { fixture, paths, source };
}

function handoffArguments(repository, paths) {
  return [
    "handoff",
    "--cwd",
    repository,
    "--task-graph",
    paths.task_graph,
    "--executors",
    paths.executor_descriptors,
    "--tools",
    paths.tool_observations,
    "--reviewed-executors",
    paths.reviewed_executors,
  ];
}

function assertNoHandoffToken(output) {
  assert.doesNotMatch(output, /lrhandoff_[A-Za-z0-9_-]{43}/u);
}

async function deterministicApprovedHandoff(source) {
  let state;
  const dependencies = {
    platform: `${process.platform}-${process.arch}`,
    now: () => "2026-08-13T00:00:00.000Z",
    store_state: async (next) => {
      state = structuredClone(next);
      return "handoff_resume_test";
    },
    load_state: async () => structuredClone(state),
    save_state: async (next) => {
      state = structuredClone(next);
    },
  };
  const discovered = await runHandoff(source, {}, dependencies);
  const preview = await runHandoff({}, {
    resume_token: discovered.resume_token,
    selection: discovered.request.choices[0],
  }, dependencies);
  return runHandoff({}, {
    resume_token: preview.resume_token,
    confirmation: "confirm",
  }, dependencies);
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

test("public rally version renders a concise Human summary through the materialized Project Engine", {
  skip: pythonAvailable ? false : "A local Python 3 PTY is required.",
}, async () => {
  const repository = await projectWithEngine(
    `await import(${JSON.stringify(pathToFileURL(engine).href)});\n`,
    currentVersion,
  );

  const { stdout } = await execFileAsync("python3", [
    "-c",
    ptyRunner,
    process.execPath,
    launcher,
    "version",
    "--cwd",
    repository,
  ]);

  const semanticOutput = stripVTControlCharacters(stdout);
  assert.match(semanticOutput, /LaunchRally Version/u);
  assert.match(semanticOutput, new RegExp(`Launcher: ${currentVersion.replaceAll(".", "\\.")}`, "u"));
  assert.match(semanticOutput, new RegExp(`Project Engine: ${currentVersion.replaceAll(".", "\\.")}`, "u"));
  assert.match(semanticOutput, /Authority: ready \(project_toolchain\)/u);
  assert.match(semanticOutput, /Compatibility: native/u);
  assert.match(semanticOutput, /Materialization: ready/u);
  assert.match(semanticOutput, /Next action: none/u);
  assert.doesNotMatch(semanticOutput, /"contract"\s*:/u);
  assert.doesNotMatch(semanticOutput, /"schema_version"\s*:/u);
  assert.doesNotMatch(semanticOutput, /"authority"\s*:/u);
});

test("public rally version preserves the exact JSON contract through the Project Engine", async () => {
  const repository = await projectWithEngine(
    `await import(${JSON.stringify(pathToFileURL(engine).href)});\n`,
    currentVersion,
  );

  const result = JSON.parse((await execFileAsync(process.execPath, [
    launcher,
    "version",
    "--json",
    "--cwd",
    repository,
  ])).stdout);

  assert.equal(result.contract, "launchrally.dev/cli/v2");
  assert.equal(result.status, "completed");
  assert.equal(result.operation, "version");
  assert.equal(result.cli_version, currentVersion);
  assert.equal(result.launcher_version, currentVersion);
  assert.equal(result.authority.state, "ready");
  assert.equal(result.authority.source, "project_toolchain");
  assert.equal(result.authority.engine.compatibility, "native");
  assert.equal(result.authority.materialization.state, "ready");
});

test("public rally handoff keeps resume tokens internal through receipt review and Verify routing", {
  skip: pythonAvailable ? false : "A local Python 3 PTY is required.",
}, async () => {
  const repository = await projectWithEngine(
    `await import(${JSON.stringify(pathToFileURL(engine).href)});\n`,
    currentVersion,
  );
  const { paths, source } = await writeHandoffInputs(repository);
  const approved = await deterministicApprovedHandoff(source);
  const receiptPath = path.join(repository, "execution-receipt.json");
  await writeFile(receiptPath, `${JSON.stringify({
    schema_version: "launchrally.dev/execution-receipt/v1",
    receipt_id: "receipt_public_human_01",
    handoff: {
      id: approved.handoff_package.handoff_id,
      schema_version: approved.handoff_package.schema_version,
      digest: sha256(approved.handoff_package),
    },
    executor: structuredClone(approved.handoff_package.executor),
    reported_at: "2026-08-13T00:01:00.000Z",
    task_results: [{
      task_id: "task_configure_identity",
      state: "partial",
      claim_codes: ["execution_partial"],
    }],
    classification: {
      claim_only: true,
      machine_evidence: false,
      verification_status: "unverified",
    },
    retention: {
      raw_stdout_retained: false,
      raw_stderr_retained: false,
      response_body_retained: false,
      sensitive_data_retained: false,
    },
  }, null, 2)}\n`);

  const { stdout } = await execFileAsync("python3", [
    "-c",
    answeringPtyRunner,
    "1\n1\n1\n1\n",
    process.execPath,
    launcher,
    ...handoffArguments(repository, paths),
    "--plain",
    "--receipt",
    receiptPath,
  ], {
    env: {
      ...process.env,
      TERM: "xterm-256color",
      NODE_OPTIONS: `--import=${fixedClock}`,
    },
  });

  assert.match(stdout, /LaunchRally External Executor Handoff/u);
  assert.match(stdout, /External Executor Discovery/u);
  assert.match(stdout, /Recommended: batch_executor_provider_config_task_configure_identity/u);
  assert.match(stdout, /Exact External Authority Preview/u);
  assert.match(stdout, /Approved Handoff Package/u);
  assert.match(stdout, /Execution Receipt Review/u);
  assert.match(stdout, /remaining work retry_unfinished_effects/u);
  assert.match(stdout, /Fresh Verify Requires a Separate Command/u);
  assert.match(stdout, /Run this complete Human Verify command:/u);
  assert.match(stdout, new RegExp([
    `npm exec --package=@launchrally/cli@${currentVersion.replaceAll(".", "\\.")} -- rally verify`,
    `--cwd '${repository.replaceAll("'", "'\\\\''")}'`,
    `--report '${path.join(repository, ".launchrally/reports/report_task_graph_01/record.json").replaceAll("'", "'\\\\''")}'`,
    "--scope full",
  ].join(" "), "u"));
  assert.match(stdout, /Handoff does not carry the source Report contents or Check IDs required to start targeted Verify safely/u);
  assert.doesNotMatch(stdout, /Resume token:/u);
  assertNoHandoffToken(stdout);
  assert.doesNotMatch(stdout, /"contract"\s*:/u);
});

test("public rally handoff preserves the complete Agent Mode resume chain", async () => {
  const repository = await projectWithEngine(
    `await import(${JSON.stringify(pathToFileURL(engine).href)});\n`,
    currentVersion,
  );
  const { paths } = await writeHandoffInputs(repository);

  const invokeHandoff = async (arguments_) => JSON.parse((await execFileAsync(process.execPath, [
    launcher,
    ...arguments_,
    "--json",
  ], {
    env: { ...process.env, NODE_OPTIONS: `--import=${fixedClock}` },
  })).stdout);
  const discovered = await invokeHandoff(handoffArguments(repository, paths));

  assert.equal(discovered.contract, "launchrally.dev/handoff-interaction/v1");
  assert.equal(discovered.status, "needs_input");
  assert.equal(discovered.state, "executor_discovery");
  assert.equal(discovered.request.kind, "executor_selection");
  assert.match(discovered.resume_token, /^lrhandoff_[A-Za-z0-9_-]{43}$/u);
  assert.equal(discovered.safety.authority_granted, false);

  const preview = await invokeHandoff([
    "handoff", "--cwd", repository,
    "--resume", discovered.resume_token,
    "--select", discovered.request.choices[0],
  ]);
  assert.equal(preview.status, "needs_confirmation");
  assert.equal(preview.state, "authority_preview");
  assert.equal(preview.resume_token, discovered.resume_token);
  assert.equal(preview.handoff_package.approval.state, "required");

  const approved = await invokeHandoff([
    "handoff", "--cwd", repository,
    "--resume", preview.resume_token,
    "--confirm", "confirm",
  ]);
  assert.equal(approved.status, "resumable");
  assert.equal(approved.state, "receipt_review");
  assert.equal(approved.resume_token, discovered.resume_token);
  assert.equal(approved.handoff_package.approval.state, "approved");

  const receiptPath = path.join(repository, "agent-execution-receipt.json");
  await writeFile(receiptPath, `${JSON.stringify({
    schema_version: "launchrally.dev/execution-receipt/v1",
    receipt_id: "receipt_public_agent_01",
    handoff: {
      id: approved.handoff_package.handoff_id,
      schema_version: approved.handoff_package.schema_version,
      digest: sha256(approved.handoff_package),
    },
    executor: structuredClone(approved.handoff_package.executor),
    reported_at: "2026-08-13T00:01:00.000Z",
    task_results: [{
      task_id: "task_configure_identity",
      state: "reported_succeeded",
      claim_codes: ["configuration_submitted"],
    }],
    classification: {
      claim_only: true,
      machine_evidence: false,
      verification_status: "unverified",
    },
    retention: {
      raw_stdout_retained: false,
      raw_stderr_retained: false,
      response_body_retained: false,
      sensitive_data_retained: false,
    },
  }, null, 2)}\n`);
  const reviewed = await invokeHandoff([
    "handoff", "--cwd", repository,
    "--resume", approved.resume_token,
    "--receipt", receiptPath,
  ]);
  assert.equal(reviewed.status, "partial_completion");
  assert.equal(reviewed.state, "receipt_review");
  assert.equal(reviewed.resume_token, discovered.resume_token);
  assert.equal(reviewed.request.kind, "fresh_verification");
  assert.equal(reviewed.execution_receipt.classification.machine_evidence, false);

  const routed = await invokeHandoff([
    "handoff", "--cwd", repository,
    "--resume", reviewed.resume_token,
    "--choice", "verify",
  ]);
  assert.equal(routed.status, "completed");
  assert.equal(routed.state, "completed");
  assert.equal(routed.resume_token, null);
  assert.equal(routed.next.operation, "verify");
  assert.equal(routed.next.scope, "targeted");
  assert.equal(routed.next.fresh_evidence_required, true);
});

test("default TTY Handoff uses styled safe-default selection and authority denial", {
  skip: pythonAvailable ? false : "A local Python 3 PTY is required.",
}, async () => {
  const repository = await projectWithEngine(
    `await import(${JSON.stringify(pathToFileURL(engine).href)});\n`,
    currentVersion,
  );
  const { paths } = await writeHandoffInputs(repository);
  const styledEnv = {
    ...process.env,
    TERM: "xterm-256color",
    NODE_OPTIONS: `--import=${fixedClock}`,
  };
  delete styledEnv.NO_COLOR;

  const { stdout } = await execFileAsync("python3", [
    "-c",
    clackPtyRunner,
    "Choose how to continue|||Grant only this exact external authority?",
    process.execPath,
    launcher,
    ...handoffArguments(repository, paths),
  ], {
    env: styledEnv,
  });

  assert.match(stdout, /LaunchRally External Executor Handoff/u);
  assert.match(stdout, /Recommended/u);
  assert.match(stdout, /Exact External Authority Preview/u);
  assert.match(stdout, /External Authority Declined/u);
  assert.match(stdout, /\u001B\[/u);
  assert.doesNotMatch(stdout, /Resume token:/u);
  assertNoHandoffToken(stdout);
  assert.doesNotMatch(stdout, /"contract"\s*:/u);
});

test("TTY Handoff presents unavailable recovery instructions and can defer safely", {
  skip: pythonAvailable ? false : "A local Python 3 PTY is required.",
}, async () => {
  const repository = await projectWithEngine(
    `await import(${JSON.stringify(pathToFileURL(engine).href)});\n`,
    currentVersion,
  );
  const { paths } = await writeHandoffInputs(repository, { available: false });

  const { stdout } = await execFileAsync("python3", [
    "-c",
    answeringPtyRunner,
    "1\n2\n",
    process.execPath,
    launcher,
    ...handoffArguments(repository, paths),
    "--plain",
  ], {
    env: { ...process.env, NODE_OPTIONS: `--import=${fixedClock}` },
  });

  assert.match(stdout, /Executor recovery/u);
  assert.match(stdout, /Reason: missing_tool/u);
  assert.match(stdout, /Official manual: https:\/\/developers\.openai\.com\/codex\/cli/u);
  assert.match(stdout, /npm install --global @openai\/codex@0\.147\.0/u);
  assert.match(stdout, /Handoff Deferred/u);
  assert.match(stdout, /No external authority was granted/u);
  assert.doesNotMatch(stdout, /Resume token:/u);
  assertNoHandoffToken(stdout);
});

test("TTY Handoff supports the manual path and cancellation without granting authority", {
  skip: pythonAvailable ? false : "A local Python 3 PTY is required.",
}, async () => {
  const manualRepository = await projectWithEngine(
    `await import(${JSON.stringify(pathToFileURL(engine).href)});\n`,
    currentVersion,
  );
  const manual = await writeHandoffInputs(manualRepository);
  await writeFile(manual.paths.executor_descriptors, "[]\n");
  await writeFile(manual.paths.reviewed_executors, "[]\n");
  await writeFile(manual.paths.tool_observations, "[]\n");
  const manualOutput = (await execFileAsync("python3", [
    "-c",
    answeringPtyRunner,
    "1\n",
    process.execPath,
    launcher,
    ...handoffArguments(manualRepository, manual.paths),
    "--plain",
  ], {
    env: { ...process.env, NODE_OPTIONS: `--import=${fixedClock}` },
  })).stdout;
  assert.match(manualOutput, /Manual or Custom Executor Selected/u);
  assert.match(manualOutput, /No external authority was granted/u);
  assertNoHandoffToken(manualOutput);

  const cancelRepository = await projectWithEngine(
    `await import(${JSON.stringify(pathToFileURL(engine).href)});\n`,
    currentVersion,
  );
  const cancel = await writeHandoffInputs(cancelRepository);
  const cancelOutput = (await execFileAsync("python3", [
    "-c",
    answeringPtyRunner,
    "1\n3\n",
    process.execPath,
    launcher,
    ...handoffArguments(cancelRepository, cancel.paths),
    "--plain",
  ], {
    env: { ...process.env, NODE_OPTIONS: `--import=${fixedClock}` },
  })).stdout;
  assert.match(cancelOutput, /Handoff Cancelled/u);
  assert.match(cancelOutput, /Authority granted before cancellation: no/u);
  assertNoHandoffToken(cancelOutput);
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
    "0.3.2",
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
  const repository = await projectWithEngine("", "0.3.2", { materialized: false });
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
        `--package=@launchrally/cli@${currentVersion}`,
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
  const migrationRepository = await projectWithEngine("", "0.3.2", {
    materialized: false,
  });
  await writeFile(
    path.join(migrationRepository, ".launchrally", "toolchain", "authority.json"),
    `${JSON.stringify({
      contract: "launchrally.dev/execution-authority/v0",
      engine: {
        package: "@launchrally/cli",
        version: "0.3.2",
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
        currentVersion,
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
    launcher_version: currentVersion,
  });
});

test("Launcher termination preserves platform cancellation semantics", async () => {
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

  assert.deepEqual(outcome, process.platform === "win32"
    ? {
      code: null,
      signal: "SIGINT",
      stdout: "Engine ready\n",
      stderr: "",
    }
    : {
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
    "const operations = new Set([\"audit\", \"architect\", \"architecture-package\", \"handoff\", \"init\", \"plan\", \"providers\", \"verify\", \"version\"]);",
    "process.stdout.write(process.argv.slice(2).find((value) => operations.has(value)));",
    "",
  ].join("\n"));
  const operations = [
    "audit",
    "architect",
    "architecture-package",
    "handoff",
    "init",
    "plan",
    "providers",
    "verify",
    "version",
  ];
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
  for (const version of ["0.1.0", "0.2.2", "0.3.2", currentVersion]) {
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

  assert.deepEqual(selected, ["0.1.0", "0.2.2", "0.3.2", currentVersion]);
});

test("version delegates to the project Engine while toolchain status remains a Launcher operation", async () => {
  const repository = await projectWithEngine(
    "process.stdout.write(JSON.stringify({ delegated: process.argv.includes(\"--version\") }));\n",
    "0.3.2",
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
      delegated: version.delegated,
    },
    status: {
      operation: status.operation,
      engine: status.authority.engine.version,
    },
  }, {
    version: {
      delegated: true,
    },
    status: {
      operation: "toolchain_status",
      engine: "0.3.2",
    },
  });
});
