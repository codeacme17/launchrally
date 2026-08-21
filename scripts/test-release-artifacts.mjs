import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { createServer } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { hasClaudeInstalledPlugin } from "./native-plugin-state.mjs";
import { createIsolatedNativeEnvironment } from "./native-environment.mjs";
import { assertNoConsumerInstallScripts } from "./release-artifact-policy.mjs";

import {
  exactToolchainLock,
  exactToolchainPackage,
} from "../test/helpers/exact-toolchain.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const consumerRuntimePackages = Object.freeze({
  "@clack/core": "1.4.3",
  "@clack/prompts": "1.7.0",
  "fast-string-truncated-width": "3.0.3",
  "fast-string-width": "3.0.2",
  "fast-wrap-ansi": "0.2.2",
  sisteransi: "1.0.5",
});
const P1_PRODUCT_JOURNEYS = Object.freeze([
  "astro-hosted-web",
  "custom-self-hosted",
  "fastapi-container",
  "pnpm-edge-monorepo",
  "react-go-split",
]);
const P1_INTEGRATION_FAMILIES = Object.freeze([
  "backup_to_restore",
  "email_to_domain_delivery",
  "identity_to_application_data",
  "payment_to_entitlement",
  "queue_background_work",
  "release_to_observability",
  "source_to_ci_cd_to_deployment",
  "storage_to_metadata_access",
]);
const P1_SCENARIOS = Object.freeze([
  "cancellation",
  "cross_host_resume",
  "denied_write",
  "environment_isolation",
  "incomplete_semantic_coverage",
  "missing_executor",
  "no_prd",
  "p0_to_p1_migration",
  "partial_receipt",
  "stale_architecture",
  "unknown_provider",
]);
const P1_MATRIX_TARGETS = Object.freeze({
  "linux-node20-posix": { platform: "linux", node_major: 20, shell: "posix" },
  "linux-node22-posix": { platform: "linux", node_major: 22, shell: "posix" },
  "linux-node24-posix": { platform: "linux", node_major: 24, shell: "posix" },
  "macos-node22-posix": { platform: "darwin", node_major: 22, shell: "posix" },
  "windows-node22-powershell": { platform: "win32", node_major: 22, shell: "powershell" },
});

function assertP1MatrixTarget() {
  const option = process.argv.indexOf("--matrix-target");
  if (option === -1) return;
  const id = process.argv[option + 1];
  const expected = P1_MATRIX_TARGETS[id];
  const actual = {
    platform: process.platform,
    node_major: Number(process.versions.node.split(".")[0]),
    shell: process.platform === "win32" ? "powershell" : "posix",
  };
  if (!expected || JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(
      `p1_artifact_matrix_target_mismatch: ${id ?? "missing"} does not match ${JSON.stringify(actual)}`,
    );
  }
}

async function json(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function run(command, arguments_, options = {}) {
  return execFileAsync(command, arguments_, {
    maxBuffer: 1024 * 1024 * 8,
    ...options,
  });
}

async function runNpm(arguments_, options = {}) {
  return process.platform === "win32"
    ? run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm", ...arguments_], options)
    : run("npm", arguments_, options);
}

async function createArtifactNpmStub(
  temporaryRoot,
  cleanProject,
  version,
  {
    launcherVersion = version,
    legacyLayout = false,
    offlineAvailable = true,
    preparedToolchain = null,
  } = {},
) {
  const directory = path.join(
    temporaryRoot,
    preparedToolchain
      ? "artifact-npm-public-legacy-stub"
      : legacyLayout
      ? "artifact-npm-legacy-stub"
      : offlineAvailable
        ? "artifact-npm-stub"
        : "artifact-npm-cache-miss-stub",
  );
  await mkdir(directory, { recursive: true });
  const script = path.join(directory, "npm-stub.cjs");
  const sourceRoot = preparedToolchain ?? cleanProject;
  const lock = preparedToolchain
    ? await json(path.join(preparedToolchain, "package-lock.json"))
    : exactToolchainLock(version);
  await writeFile(script, [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `const sourceRoot = ${JSON.stringify(sourceRoot)};`,
    `const lock = ${JSON.stringify(lock)};`,
    ...(!offlineAvailable ? [
      'if (process.argv.includes("--offline")) {',
      '  process.stderr.write("ENOTCACHED: package is not in the offline cache\\n");',
      "  process.exit(1);",
      "}",
    ] : []),
    'fs.writeFileSync(path.join(process.cwd(), "package-lock.json"), `${JSON.stringify(lock)}\\n`);',
    "for (const lockedPath of Object.keys(lock.packages)) {",
    '  if (!lockedPath.startsWith("node_modules/")) continue;',
    '  const name = lockedPath.slice("node_modules/".length);',
    "  fs.cpSync(",
    '    path.join(sourceRoot, "node_modules", ...name.split("/")),',
    "    path.join(process.cwd(), lockedPath),",
    "    { recursive: true },",
    "  );",
    "}",
    ...(!legacyLayout ? [] : [
      "for (const [lockedPath, entry] of Object.entries(lock.packages)) {",
      '  if (!lockedPath.startsWith("node_modules/")) continue;',
      '  const name = lockedPath.slice("node_modules/".length);',
      '  const packagePath = path.join(process.cwd(), lockedPath, "package.json");',
      '  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));',
      "  packageJson.version = entry.version;",
      "  if (entry.dependencies) packageJson.dependencies = entry.dependencies;",
      "  else delete packageJson.dependencies;",
      '  if (name === "@launchrally/cli") {',
      '    packageJson.bin = { rally: "bin/rally.js" };',
      "    delete packageJson.launchrally;",
      "  }",
      '  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\\n`);',
      "}",
      'const legacyEntrypoint = path.join(process.cwd(), "node_modules/@launchrally/cli/bin/rally.js");',
      "fs.writeFileSync(legacyEntrypoint, [",
      '  "const result = {",',
      '  `  contract: "launchrally.dev/cli/v2",`,',
      '  `  status: "completed",`,',
      '  `  operation: "version",`,',
      `  ${JSON.stringify(`  cli_version: "${version}",`)},`,
      `  ${JSON.stringify(`  launcher_version: "${launcherVersion}",`)},`,
      '  `  authority: {`,',
      '  `    schema_version: "launchrally.dev/execution-authority/v1",`,',
      '  `    state: "ready",`,',
      '  `    source: "project_toolchain",`,',
      `  ${JSON.stringify(`    engine: { package: "@launchrally/cli", version: "${version}", compatibility: "legacy_adapter" },`)},`,
      '  `  },`,',
      '  `};`,',
      '  `process.stdout.write(JSON.stringify(result));`,',
      '].join("\\n"));',
    ]),
  ].join("\n"));
  if (process.platform === "win32") {
    await writeFile(
      path.join(directory, "npm.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0npm-stub.cjs" %*\r\n`,
    );
  } else {
    const executable = path.join(directory, "npm");
    await writeFile(executable, `#!/usr/bin/env node\n${await readFile(script, "utf8")}`);
    await chmod(executable, 0o755);
  }
  return directory;
}

function assertEqual(actual, expected, code, detail) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${code}: ${detail}`);
  }
}

function sha256Text(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function withDeniedProcessEffects(observations, action) {
  const replacements = [];
  const replace = (owner, method, effect) => {
    const original = owner[method];
    if (typeof original !== "function") return;
    owner[method] = (...arguments_) => {
      observations.denied_process_effects.push({ effect, method });
      const error = new Error(`packed_host_unauthorized_effect:${effect}:${method}`);
      error.code = "packed_host_unauthorized_effect";
      throw error;
    };
    replacements.push(() => { owner[method] = original; });
  };
  const childProcess = require("node:child_process");
  const dns = require("node:dns");
  const dgram = require("node:dgram");
  const fs = require("node:fs");
  const http = require("node:http");
  const http2 = require("node:http2");
  const https = require("node:https");
  const net = require("node:net");
  const tls = require("node:tls");
  const workerThreads = require("node:worker_threads");
  const fsPromises = fs.promises;
  for (const method of [
    "exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync",
  ]) {
    replace(childProcess, method, "process_execution");
  }
  for (const method of ["get", "request"]) {
    replace(http, method, "network_access");
    replace(https, method, "network_access");
  }
  for (const method of ["connect", "createConnection"]) {
    replace(net, method, "network_access");
  }
  replace(tls, "connect", "network_access");
  replace(http2, "connect", "network_access");
  replace(dgram, "createSocket", "network_access");
  for (const method of [
    "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname",
    "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv",
    "resolveTxt", "reverse",
  ]) replace(dns, method, "network_access");
  for (const method of [
    "appendFile",
    "chmod",
    "chown",
    "copyFile",
    "cp",
    "link",
    "mkdir",
    "mkdtemp",
    "rename",
    "rm",
    "rmdir",
    "symlink",
    "truncate",
    "unlink",
    "writeFile",
  ]) replace(fsPromises, method, "filesystem_write");
  for (const method of [
    "appendFileSync",
    "chmodSync",
    "chownSync",
    "copyFileSync",
    "cpSync",
    "linkSync",
    "mkdirSync",
    "renameSync",
    "rmSync",
    "rmdirSync",
    "symlinkSync",
    "truncateSync",
    "unlinkSync",
    "writeFileSync",
  ]) replace(fs, method, "filesystem_write");
  replace(process, "dlopen", "native_addon_load");
  replace(workerThreads, "Worker", "worker_creation");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...arguments_) => {
    observations.denied_process_effects.push({ effect: "network_access", method: "fetch" });
    const error = new Error("packed_host_unauthorized_effect:network_access:fetch");
    error.code = "packed_host_unauthorized_effect";
    throw error;
  };
  syncBuiltinESMExports();
  observations.guarded_process_sections += 1;
  try {
    return await action();
  } finally {
    for (const restore of replacements.reverse()) restore();
    globalThis.fetch = originalFetch;
    syncBuiltinESMExports();
  }
}

function assertEnvironmentBoundEvidence(
  result,
  environment,
  expectedCheckStatus,
  { evidenceKind = null, target = null } = {},
) {
  const entries = result.evidence_index?.entries ?? [];
  const qualifying = entries.filter((entry) =>
    entry.current === true
    && entry.environment === environment
    && (evidenceKind === null || entry.evidence_kind === evidenceKind)
    && (target === null || entry.target === target));
  const binding = qualifying.find((entry) => result.report?.results?.checks?.some((check) =>
    check.environment === environment
    && check.status === expectedCheckStatus
    && check.evidence.some(({ digest }) => digest === entry.digest)));
  if (!binding) {
    throw new Error(
      `p1_environment_bound_evidence_missing:${environment}:${expectedCheckStatus}:${JSON.stringify({
        qualifying: qualifying.map(({ digest, evidence_kind: kind, target: observedTarget }) => ({
          digest,
          kind,
          target: observedTarget,
        })),
        checks: (result.report?.results?.checks ?? []).filter(
          ({ environment: observed, status }) =>
            observed === environment && status === expectedCheckStatus,
        ).map(({ check_id: id, evidence }) => ({
          id,
          evidence: evidence.map(({ digest }) => digest),
        })),
      })}`,
    );
  }
  if (evidenceKind === "authenticated_journey_machine_evidence") {
    const artifact = binding.normalized_artifact;
    if (
      artifact?.kind !== evidenceKind
      || artifact.provenance?.collector !== "host-agent-authenticated-journey/v1"
      || artifact.provenance?.exact_target !== binding.target
      || artifact.provenance?.permission_id !== "authenticated_journey_verification"
      || artifact.provenance?.collected_at !== binding.collected_at
    ) throw new Error("p1_authenticated_evidence_provenance_drift");
  }
  return binding;
}

function shellCommand(command, replacements) {
  let rendered = command;
  for (const [source, target] of replacements) rendered = rendered.replaceAll(source, target);
  return rendered;
}

function shellQuote(value) {
  return process.platform === "win32"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function runDocumentedShell(command, options) {
  if (process.platform === "win32") {
    const windowsPowerShell = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    return run(windowsPowerShell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command,
    ], options);
  }
  return run("/bin/bash", ["--noprofile", "--norc", "-c", command], options);
}

async function packArtifacts(temporaryRoot, release) {
  const packDirectory = path.join(temporaryRoot, "packs");
  const cacheDirectory = path.join(temporaryRoot, "npm-cache");
  await mkdir(packDirectory, { recursive: true });
  const tarballs = [];
  const packageTarballs = {};

  for (const artifact of release.packages) {
    const { stdout } = await runNpm([
      "pack",
      "--json",
      "--pack-destination",
      packDirectory,
      "--cache",
      cacheDirectory,
    ], { cwd: path.join(root, artifact.path) });
    const [packed] = JSON.parse(stdout);
    if (packed.name !== artifact.name) {
      throw new Error(`artifact_name_drift: ${artifact.path} packed as ${packed.name}`);
    }
    const actualFiles = packed.files.map((file) => file.path).sort();
    const expectedFiles = [...artifact.files].sort();
    assertEqual(
      actualFiles,
      expectedFiles,
      "undeclared_artifact_file",
      `${artifact.name} packed files differ from release/artifacts.json`,
    );
    const tarball = path.join(packDirectory, packed.filename);
    tarballs.push(tarball);
    packageTarballs[artifact.name] = tarball;
  }

  for (const [packageName, version] of Object.entries(consumerRuntimePackages)) {
    const packageDirectory = path.join(root, "node_modules", ...packageName.split("/"));
    const { stdout } = await runNpm([
      "pack",
      "--json",
      "--pack-destination",
      packDirectory,
      "--cache",
      cacheDirectory,
      packageDirectory,
    ], { cwd: root });
    const [packed] = JSON.parse(stdout);
    if (packed.name !== packageName || packed.version !== version) {
      throw new Error(
        `consumer_runtime_dependency_drift: ${packageName} packed as ${packed.name}@${packed.version}; expected ${version}`,
      );
    }
    const tarball = path.join(packDirectory, packed.filename);
    tarballs.push(tarball);
    packageTarballs[packageName] = tarball;
  }

  return { cacheDirectory, packageTarballs, tarballs };
}

async function installPublicLegacyToolchain(temporaryRoot) {
  const toolchain = path.join(temporaryRoot, "public-legacy-0.2.2-toolchain");
  await mkdir(toolchain);
  await writeFile(
    path.join(toolchain, "package.json"),
    `${JSON.stringify(exactToolchainPackage("0.2.2"), null, 2)}\n`,
  );
  await runNpm([
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--save-exact",
  ], { cwd: toolchain });
  const installed = await json(path.join(
    toolchain,
    "node_modules",
    "@launchrally",
    "cli",
    "package.json",
  ));
  if (installed.version !== "0.2.2") {
    throw new Error(`public_legacy_version_drift: ${installed.version}`);
  }
  assertNoConsumerInstallScripts(await json(path.join(toolchain, "package-lock.json")));
  return toolchain;
}

function prefixExecutable(prefix) {
  return process.platform === "win32"
    ? path.join(prefix, "rally.cmd")
    : path.join(prefix, "bin", "rally");
}

async function invokeLauncher(executable, arguments_, options) {
  return process.platform === "win32"
    ? run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", executable, ...arguments_], options)
    : run(executable, arguments_, options);
}

function findFixtureInvocation(journey, id) {
  const invocation = [...journey.invocations, ...journey.lifecycle_invocations]
    .find((candidate) => candidate.id === id);
  if (!invocation) throw new Error(`missing_reference_journey_invocation: ${id}`);
  return invocation;
}

function fixtureArguments(journey, id, replacements = {}) {
  const invocation = findFixtureInvocation(journey, id);
  return invocation.arguments.map((argument) => replacements[argument] ?? argument);
}

function assertFixtureResult(journey, invocation, result, exitCode) {
  const expected = invocation.expect;
  const expectedContract = expected.contract ?? journey.cli.contract;
  if (result.contract !== expectedContract || result.operation !== expected.operation) {
    throw new Error(`reference_journey_contract_drift: ${invocation.id}`);
  }
  const expectedStatuses = Array.isArray(expected.status) ? expected.status : [expected.status];
  if (!expectedStatuses.includes(result.status)) {
    throw new Error(`reference_journey_status_drift: ${invocation.id}: ${result.status}`);
  }
  if (expected.schema_version && result.schema_version !== expected.schema_version) {
    throw new Error(`reference_journey_schema_drift: ${invocation.id}`);
  }
  if (
    expected.interaction_schema
    && result.interaction?.schema_version !== expected.interaction_schema
  ) throw new Error(`reference_journey_interaction_drift: ${invocation.id}`);
  if (expected.authority_schema) {
    if (
      result.authority?.schema_version !== expected.authority_schema
      || result.authority?.state !== expected.authority_state
    ) throw new Error(`reference_journey_authority_drift: ${invocation.id}`);
    const expectedSources = expected.authority_sources ?? [expected.authority_source];
    if (!expectedSources.includes(result.authority?.source)) {
      throw new Error(`reference_journey_authority_source_drift: ${invocation.id}`);
    }
  }
  const expectsFailureExit = ["execution_error", "unavailable"].includes(result.status);
  if ((exitCode !== 0) !== expectsFailureExit) {
    throw new Error(`reference_journey_exit_drift: ${invocation.id}: ${exitCode}`);
  }
}

async function assertMissing(filePath, code) {
  try {
    await access(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${code}: ${filePath} exists unexpectedly`);
}

async function snapshotTree(directory, relative = "", excludedRoots = new Set()) {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const snapshot = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (relative === "" && excludedRoots.has(entry.name)) continue;
    const entryRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      snapshot.push(...await snapshotTree(directory, entryRelative, excludedRoots));
    } else {
      snapshot.push([
        entryRelative.split(path.sep).join("/"),
        await readFile(path.join(directory, entryRelative), "utf8"),
      ]);
    }
  }
  return snapshot;
}

async function runInstallationJourneys({
  temporaryRoot,
  cleanProject,
  version,
  cacheDirectory,
  packageTarballs,
  publicLegacy,
  publicRelease,
}) {
  const effectObservations = {
    package_manager: [],
    authenticated_network: [],
    denied_process_effects: [],
    file_boundaries: [],
    guarded_process_sections: 0,
    normalized_outputs: [],
  };
  const runAuthorizedNpm = (arguments_, options, authority) => {
    effectObservations.package_manager.push({
      executable: "npm",
      arguments: [...arguments_],
      authority,
      authorized: true,
    });
    return runNpm(arguments_, options);
  };
  const prefix = path.join(temporaryRoot, "user-npm-prefix");
  const launcher = prefixExecutable(prefix);
  await assertMissing(launcher, "isolated_prefix_not_clean");

  const cliTarballs = [
    packageTarballs?.["@launchrally/contracts"],
    packageTarballs?.["@launchrally/core"],
    packageTarballs?.["@launchrally/cli"],
    ...Object.keys(consumerRuntimePackages).map((name) => packageTarballs?.[name]),
  ].filter(Boolean);
  const npmExecArguments = publicRelease
    ? ["exec", `--package=@launchrally/cli@${version}`, "--", "rally"]
    : [
      "exec",
      "--offline",
      "--cache",
      cacheDirectory,
      ...cliTarballs.map((tarball) => `--package=${tarball}`),
      "--",
      "rally",
    ];
  const npmExecVersion = JSON.parse((await runAuthorizedNpm(
    [...npmExecArguments, "--version", "--json"],
    { cwd: temporaryRoot },
    "exact_public_or_packed_execution",
  )).stdout);
  if (npmExecVersion.cli_version !== version) {
    throw new Error("npm_exec_artifact_version_drift");
  }

  const globalPackageSpecs = publicRelease
    ? [`@launchrally/cli@${version}`]
    : cliTarballs;
  const globalInstallArguments = [
    "install",
    "--global",
    "--prefix",
    prefix,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    ...(publicRelease ? [] : ["--offline", "--cache", cacheDirectory]),
    ...globalPackageSpecs,
  ];
  await runAuthorizedNpm(
    globalInstallArguments,
    { cwd: temporaryRoot },
    "explicit_user_prefix_install",
  );
  await access(launcher);
  const installedPrefixSnapshot = await snapshotTree(prefix);

  const packagedJourneyPath = path.join(
    cleanProject,
    "node_modules",
    "@launchrally",
    "codex-plugin",
    "skills",
    "launchrally",
    "references",
    "reference-journey.json",
  );
  const claudeJourneyPath = path.join(
    cleanProject,
    "node_modules",
    "@launchrally",
    "claude-plugin",
    "skills",
    "launchrally",
    "references",
    "reference-journey.json",
  );
  const codexPhase1CommandsPath = path.join(
    cleanProject,
    "node_modules",
    "@launchrally",
    "codex-plugin",
    "skills",
    "launchrally",
    "references",
    "phase-1-command-examples.json",
  );
  const claudePhase1CommandsPath = path.join(
    cleanProject,
    "node_modules",
    "@launchrally",
    "claude-plugin",
    "skills",
    "launchrally",
    "references",
    "phase-1-command-examples.json",
  );
  const [journey, claudeJourney, phase1Commands, claudePhase1Commands] = await Promise.all([
    json(packagedJourneyPath),
    json(claudeJourneyPath),
    json(codexPhase1CommandsPath),
    json(claudePhase1CommandsPath),
  ]);
  const installedAdapterProjectSnapshot = await snapshotTree(
    cleanProject,
    "",
    new Set(["node_modules"]),
  );
  const {
    applyReferenceJourneyState,
    buildCapabilityGraph,
    createCapabilityCatalog,
    createArchitecturePackageBundle,
    createIntegrationContract,
    createReferenceCoverageMatrix,
    qualifyReferenceVerificationEvidence,
    referenceExecutorDescriptors,
    referenceIntegrationPacks,
    runArchitectureJourney,
    runHandoff,
    runReferenceOutcomeJourney,
  } = await import(pathToFileURL(path.join(
    cleanProject,
    "node_modules",
    "@launchrally",
    "core",
    "src",
    "index.js",
  )).href);
  const p1IntegrationFamilies = new Set();
  const integrationVerificationRequests = new Map();
  const integrationFreshVerify = {};
  const p1HostJourneys = new Set();
  const p1Scenarios = new Set();
  let successfulDownstreamEvidence = false;
  let unsuccessfulDownstreamEvidence = false;
  let receiptClaimsRequireVerification = false;
  let hostProductIntentModules;
  const referenceCoverage = createReferenceCoverageMatrix();
  if (
    referenceIntegrationPacks.length !== 8
    || referenceCoverage.cells.length !== 40
    || referenceExecutorDescriptors.length !== 2
    || referenceExecutorDescriptors[0].tools[0].exact_version !== "0.147.0"
    || referenceExecutorDescriptors[1].tools[0].exact_version !== "2.1.231"
  ) throw new Error("packed_reference_integration_roster_drift");
  await withDeniedProcessEffects(effectObservations, async () => {
    for (const host of ["codex", "claude"]) {
      const module = await import(pathToFileURL(path.join(
        cleanProject,
        "node_modules",
        "@launchrally",
        `${host}-plugin`,
        "host-adapter",
        "reference-journey.js",
      )).href);
      const runReferenceJourney = host === "codex"
        ? module.runCodexReferenceJourney
        : module.runClaudeReferenceJourney;
      for (const pack of referenceIntegrationPacks) {
        p1IntegrationFamilies.add(pack.family);
        const managed = pack.implementations.filter(({ kind }) => kind === "managed");
        for (const implementation of managed) {
          for (const outcome of [
            "complete", "partial", "denied", "unknown", "stale", "successful", "failed",
            "cleanup_failed",
          ]) {
            const referenceResult = await runReferenceJourney({
              pack_id: pack.pack_id,
              implementation_id: implementation.implementation_id,
              outcome,
              environment: "production",
              assessment_time: "2026-08-14T12:00:00.000Z",
            });
            effectObservations.normalized_outputs.push(JSON.stringify(referenceResult));
            const requiresFreshVerification = [
              "complete", "partial", "successful", "failed", "cleanup_failed",
            ].includes(outcome);
            const evidenceTarget = referenceResult.fresh_verification_request
              ?.task_requests?.[0]?.evidence_targets?.[0] ?? "";
            if (
              referenceResult.outcome !== outcome
              || referenceResult.machine_evidence !== false
              || referenceResult.assurance_change !== false
              || (requiresFreshVerification
                && (referenceResult.receipt_claim_only !== true
                  || referenceResult.fresh_verification_request?.operation !== "verify"
                  || referenceResult.fresh_verification_request?.fresh_evidence_required !== true
                  || !evidenceTarget.includes(pack.pack_digest.slice(7))
                  || !evidenceTarget.includes(implementation.implementation_id)))
            ) {
              throw new Error(
                `packed_${host}_reference_journey_drift:${pack.family}:${implementation.implementation_id}:${outcome}`,
              );
            }
            if (requiresFreshVerification) receiptClaimsRequireVerification = true;
            if (outcome === "complete" && !integrationVerificationRequests.has(pack.family)) {
              integrationVerificationRequests.set(pack.family, {
                pack_digest: pack.pack_digest,
                implementation_id: implementation.implementation_id,
                request: structuredClone(referenceResult.fresh_verification_request),
                verification_subject: structuredClone(referenceResult.verification_subject),
              });
            }
            if (outcome === "partial") p1Scenarios.add("partial_receipt");
            if (outcome === "denied") p1Scenarios.add("denied_write");
            if (outcome === "unknown") p1Scenarios.add("missing_executor");
          }
        }
        const unknown = pack.implementations.find(({ kind }) => kind === "unknown");
        const unknownProvider = await runReferenceJourney({
          pack_id: pack.pack_id,
          implementation_id: unknown.implementation_id,
          outcome: "unknown",
          environment: "production",
          assessment_time: "2026-08-14T12:00:00.000Z",
        });
        effectObservations.normalized_outputs.push(JSON.stringify(unknownProvider));
        if (
          unknownProvider.status !== "verification_gap"
          || unknownProvider.reason_code !== "unsupported_reference_executor"
          || unknownProvider.machine_evidence !== false
        ) throw new Error(`packed_${host}_unknown_provider_not_transparent:${pack.family}`);
        p1Scenarios.add("unknown_provider");
      }
      p1HostJourneys.add(host);
    }
  });
  const cancellationPack = referenceIntegrationPacks[0];
  const cancellationImplementation = cancellationPack.implementations.find(
    ({ kind }) => kind === "managed",
  );
  const cancelled = applyReferenceJourneyState(runReferenceOutcomeJourney(
    cancellationPack,
    cancellationImplementation.implementation_id,
    "complete",
    "2026-08-14T12:00:00.000Z",
  ), "cancel");
  if (
    cancelled.status !== "cancelled"
    || cancelled.machine_evidence !== false
    || cancelled.assurance_change !== false
  ) throw new Error("packed_reference_cancellation_drift");
  p1Scenarios.add("cancellation");
  assertEqual(
    claudeJourney,
    journey,
    "packaged_skill_journey_drift",
    "Codex and Claude packaged Skills must ship the same reference journey",
  );
  assertEqual(
    claudePhase1Commands,
    phase1Commands,
    "packaged_phase_1_command_examples_drift",
    "Codex and Claude packaged Skills must ship the same Phase 1 command vectors",
  );
  assertEqual(
    journey.launcher_prerequisite,
    {
      executable: "rally",
      installation: {
        owner: "user",
        executable: "npm",
        arguments: ["install", "--global", `@launchrally/cli@${version}`],
      },
      verification: {
        arguments: ["--version", "--json", "--cwd", "{repository_root}"],
      },
      missing_action: "stop_before_audit",
    },
    "packaged_skill_launcher_prerequisite_drift",
    "Packaged Skills must stop before Audit and render the exact user-managed Launcher prerequisite",
  );

  const npmExecRepository = path.join(temporaryRoot, "npm exec journey ü space");
  await cp(
    path.join(root, "fixtures", "coverage", "typescript-astro"),
    npmExecRepository,
    { recursive: true },
  );
  const invokeNpmExecFixture = async (id, replacements = {}) => {
    const invocation = findFixtureInvocation(journey, id);
    const execution = await runAuthorizedNpm([
      ...npmExecArguments,
      ...fixtureArguments(journey, id, replacements),
    ], { cwd: temporaryRoot }, "exact_npm_exec_journey");
    const result = JSON.parse(execution.stdout);
    assertFixtureResult(journey, invocation, result, 0);
    return result;
  };
  const npmExecInput = await invokeNpmExecFixture("audit_input", {
    "{repository_root}": npmExecRepository,
  });
  const npmExecConfirmation = await invokeNpmExecFixture("audit_confirmation", {
    "{repository_root}": npmExecRepository,
    "{audit_resume}": npmExecInput.interaction.resume_token,
    "{answers_json}": JSON.stringify({
      intended_environment: "production",
      production_targets: ["https://example.com"],
      core_journeys: [{ method: "GET", path: "/", purpose: "npm-exec follow-up" }],
      provider_roles: [],
      support_layers: [],
    }),
  });
  if (
    npmExecInput.status !== "needs_input"
    || npmExecConfirmation.status !== "needs_confirmation"
  ) throw new Error("npm_exec_artifact_follow_up_failed");

  const repository = path.join(temporaryRoot, "installation journey ü space");
  await cp(
    path.join(root, "fixtures", "coverage", "typescript-astro"),
    repository,
    { recursive: true },
  );
  const npmStub = await createArtifactNpmStub(temporaryRoot, cleanProject, version);
  const launcherEnvironment = {
    ...process.env,
    PATH: [npmStub, path.dirname(launcher), process.env.PATH ?? ""].join(path.delimiter),
  };
  const exercisePackedHumanAuthenticatedJourneyPlatformBoundary = async () => {
    const humanRepository = path.join(temporaryRoot, "packed human authenticated journey");
    await cp(
      path.join(root, "fixtures", "coverage", "typescript-astro"),
      humanRepository,
      { recursive: true },
    );
    const [
      { runHumanAudit },
      { renderHumanInitCompletion, runHumanInit },
      { runHumanVerify },
      packedCore,
    ] = await Promise.all([
      import(pathToFileURL(path.join(
        cleanProject,
        "node_modules",
        "@launchrally",
        "cli",
        "bin",
        "human-audit.js",
      )).href),
      import(pathToFileURL(path.join(
        cleanProject,
        "node_modules",
        "@launchrally",
        "cli",
        "bin",
        "human-init.js",
      )).href),
      import(pathToFileURL(path.join(
        cleanProject,
        "node_modules",
        "@launchrally",
        "cli",
        "bin",
        "human-verify.js",
      )).href),
      import(pathToFileURL(path.join(
        cleanProject,
        "node_modules",
        "@launchrally",
        "core",
        "src",
        "index.js",
      )).href),
    ]);
    const authenticationRoot = await mkdtemp(
      path.join(os.tmpdir(), "launchrally-packed-human-auth-"),
    );
    const authorizationFile = path.join(authenticationRoot, "authorization");
    const cookieFile = path.join(authenticationRoot, "cookie");
    const authorizationSentinel = "Bearer packed-human-authorization-secret";
    const sessionSentinel = "packed-human-session-secret";
    const accountSentinel = "packed-human-account-identifier";
    const responseSentinel = "packed-human-response-body-secret";
    await writeFile(authorizationFile, authorizationSentinel, { mode: 0o600 });
    await writeFile(
      cookieFile,
      `session=${sessionSentinel}; account_id=${accountSentinel}`,
      { mode: 0o600 },
    );
    let authenticatedRequestObserved = false;
    const server = createServer({
      key: await readFile(path.join(root, "test", "fixtures", "self-signed-key.pem")),
      cert: await readFile(path.join(root, "test", "fixtures", "self-signed-cert.pem")),
    }, (request, response) => {
      authenticatedRequestObserved = request.headers.authorization === authorizationSentinel
        && request.headers.cookie?.includes(sessionSentinel)
        && request.headers.cookie?.includes(accountSentinel);
      effectObservations.authenticated_network.push({
        effect: "authenticated_network_read",
        method: request.method,
        destination: "loopback_fixture",
        authentication_source: "owner_private_reference",
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        body_secret: responseSentinel,
        account_id: accountSentinel,
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const authenticatedOrigin = `https://localhost:${server.address().port}`;
    const previousOrigin = process.env.LAUNCHRALLY_AUTHENTICATED_ORIGIN;
    const previousAuthorization = process.env.LAUNCHRALLY_HOST_AUTHORIZATION_FILE;
    const previousCookie = process.env.LAUNCHRALLY_HOST_COOKIE_FILE;
    const previousCa = process.env.LAUNCHRALLY_HOST_CA_FILE;
    const previousPath = process.env.PATH;
    process.env.LAUNCHRALLY_AUTHENTICATED_ORIGIN = authenticatedOrigin;
    process.env.LAUNCHRALLY_HOST_AUTHORIZATION_FILE = authorizationFile;
    process.env.LAUNCHRALLY_HOST_COOKIE_FILE = cookieFile;
    process.env.LAUNCHRALLY_HOST_CA_FILE = path.join(
      root,
      "test",
      "fixtures",
      "self-signed-cert.pem",
    );
    process.env.PATH = launcherEnvironment.PATH;
    const promptRequests = [];
    try {
      const outcome = await runHumanAudit({
        cwd: humanRepository,
        version,
        prompt: {
          async start() {},
          async respond(result) {
            promptRequests.push(result.request?.type ?? result.status);
            if (result.status === "needs_input") {
              return {
                answers: {
                  intended_environment: "staging",
                  production_targets: [authenticatedOrigin],
                  core_journeys: [{
                    schema_version: "launchrally.dev/protected-journey/v1",
                    method: "GET",
                    path: "/control",
                    purpose: "authenticated Core Journey",
                    access: {
                      authentication_class: "staff",
                      anonymous_status_codes: [401, 403, 404],
                      authenticated_status_codes: [200],
                    },
                  }],
                  provider_roles: [],
                  support_layers: [],
                },
              };
            }
            if (result.status === "needs_confirmation") return { confirmation: "confirm" };
            if (result.status === "needs_permission") {
              return {
                permission_decisions: {
                  public_verification: "denied",
                  authenticated_journey_verification: "approved",
                },
              };
            }
            return {};
          },
          async close() {},
        },
        runAudit: packedCore.runAudit,
        resumeAuthenticatedJourney: (options) =>
          packedCore.resumeAuthenticatedJourneyFromHost({ ...options, host: "cli" }),
      });
      const serialized = JSON.stringify(outcome.result);
      const sensitiveSentinels = new RegExp([
        authorizationSentinel.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
        sessionSentinel,
        accountSentinel,
        responseSentinel,
      ].join("|"), "iu");
      const supportedPrivateReferences = process.platform !== "win32";
      const authenticatedResults = outcome.result.report?.results;
      if (
        outcome.exitCode !== 0
        || outcome.result?.status !== "completed"
        || (supportedPrivateReferences
          ? authenticatedResults?.authenticated_journey_evidence_refs?.length !== 1
            || authenticatedResults?.authenticated_journey_gaps?.length !== 0
            || !authenticatedRequestObserved
          : !authenticatedResults?.authenticated_journey_gaps?.some(
            ({ outcome: gapOutcome }) => gapOutcome === "runner_unavailable",
          ))
        || promptRequests.includes("authenticated_journey_results")
        || sensitiveSentinels.test(serialized)
        || /bearer\s|"cookie"\s*:|"headers"\s*:|response_body|account_id/iu.test(serialized)
        || sensitiveSentinels.test(JSON.stringify(effectObservations.package_manager))
      ) throw new Error("packed_human_authenticated_journey_failed");
      effectObservations.normalized_outputs.push(serialized);

      const initPromptRequests = [];
      const initOutcome = await runHumanInit({
        cwd: humanRepository,
        version,
        reportPackage: outcome.result,
        prompt: {
          async start() {},
          async respondInit(result) {
            initPromptRequests.push(result.status);
            if (result.status === "needs_permission") {
              return {
                permission_decisions: Object.fromEntries(
                  result.request.permissions.map(({ id }) => [id, "approved"]),
                ),
              };
            }
            return result.status === "needs_confirmation"
              ? { confirmation: "confirm" }
              : {};
          },
          async close() {},
        },
        runInit: packedCore.runInit,
      });
      const humanInitCompletion = renderHumanInitCompletion(initOutcome.result, {
        root: humanRepository,
        version,
        invocationContext: {
          schema_version: "launchrally.dev/invocation-context/v1",
          source: "user_path",
          launcher_version: version,
        },
        presentation: initOutcome.presentation,
        styled: false,
      });
      const humanInitAuthority = JSON.parse((await invokeLauncher("rally", [
        "--version",
        "--json",
        "--cwd",
        humanRepository,
      ], { cwd: temporaryRoot, env: launcherEnvironment })).stdout);
      const humanInitAuthorityCommand = process.platform === "win32"
        ? /^& 'rally' '--version' '--json' '--cwd' '.+'$/mu
        : /^rally --version --json --cwd .+$/mu;
      if (
        initOutcome.exitCode !== 0
        || initOutcome.result?.status !== "completed"
        || initPromptRequests.at(-1) !== "needs_confirmation"
        || !/^LaunchRally Initialization Complete$/mu.test(humanInitCompletion)
        || !/^Outcome: initialized$/mu.test(humanInitCompletion)
        || !/^Manifest action: created$/mu.test(humanInitCompletion)
        || !/^Manifest source Report: report_/mu.test(humanInitCompletion)
        || !new RegExp(`^Project Toolchain: @launchrally/cli@${version}$`, "mu")
          .test(humanInitCompletion)
        || !/^Applied changes: [1-9][0-9]*$/mu.test(humanInitCompletion)
        || !humanInitAuthorityCommand.test(humanInitCompletion)
        || !/authority\.state: "ready"/u.test(humanInitCompletion)
        || !/authority\.source: "project_toolchain"/u.test(humanInitCompletion)
        || /"changes_applied"/u.test(humanInitCompletion)
        || humanInitAuthority.authority?.state !== "ready"
        || humanInitAuthority.authority?.source !== "project_toolchain"
      ) throw new Error("packed_human_init_authority_handoff_failed");
      const verifyPromptRequests = [];
      const verifyOutcome = await runHumanVerify({
        cwd: humanRepository,
        version,
        reportPackage: outcome.result,
        scope: "full",
        prompt: {
          async start() {},
          async respondVerify(result) {
            verifyPromptRequests.push(result.status);
            return {
              permission_decisions: Object.fromEntries(
                result.request.permissions.map(({ permission_id: permissionId }) => [
                  permissionId,
                  permissionId === "authenticated_journey_verification"
                    ? "approved"
                    : "denied",
                ]),
              ),
            };
          },
          async close() {},
        },
        runVerify: packedCore.runVerify,
        resumeAuthenticatedJourney: (options) =>
          packedCore.resumeAuthenticatedJourneyFromHost({ ...options, host: "cli" }),
      });
      const serializedVerify = JSON.stringify(verifyOutcome.result);
      const verifyRecord = JSON.stringify(JSON.parse(await readFile(path.join(
        humanRepository,
        ".launchrally",
        "reports",
        verifyOutcome.result.report?.report_id ?? "missing",
        "record.json",
      ), "utf8")));
      const verifyHistory = JSON.stringify(await snapshotTree(path.join(
        humanRepository,
        ".launchrally",
      ), "", new Set(["toolchain"])));
      if (
        verifyOutcome.exitCode !== 0
        || verifyOutcome.result?.status !== "completed"
        || verifyPromptRequests.length !== 1
        || verifyPromptRequests[0] !== "needs_permission"
        || (supportedPrivateReferences
          ? verifyOutcome.result.report?.results.authenticated_journey_evidence_refs?.length !== 1
            || verifyOutcome.result.report?.results.authenticated_journey_gaps?.length !== 0
          : !verifyOutcome.result.report?.results.authenticated_journey_gaps?.some(
            ({ outcome: gapOutcome }) => gapOutcome === "runner_unavailable",
          ))
        || sensitiveSentinels.test(serializedVerify)
        || sensitiveSentinels.test(verifyRecord)
        || sensitiveSentinels.test(verifyHistory)
        || /bearer\s|"cookie"\s*:|"headers"\s*:|response_body|account_id|resume_token/iu.test(
          verifyHistory,
        )
      ) throw new Error("packed_human_verify_authenticated_journey_failed");
      effectObservations.normalized_outputs.push(serializedVerify);
    } finally {
      if (previousOrigin === undefined) delete process.env.LAUNCHRALLY_AUTHENTICATED_ORIGIN;
      else process.env.LAUNCHRALLY_AUTHENTICATED_ORIGIN = previousOrigin;
      if (previousAuthorization === undefined) {
        delete process.env.LAUNCHRALLY_HOST_AUTHORIZATION_FILE;
      } else {
        process.env.LAUNCHRALLY_HOST_AUTHORIZATION_FILE = previousAuthorization;
      }
      if (previousCookie === undefined) delete process.env.LAUNCHRALLY_HOST_COOKIE_FILE;
      else process.env.LAUNCHRALLY_HOST_COOKIE_FILE = previousCookie;
      if (previousCa === undefined) delete process.env.LAUNCHRALLY_HOST_CA_FILE;
      else process.env.LAUNCHRALLY_HOST_CA_FILE = previousCa;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(authenticationRoot, { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
    }
  };
  await exercisePackedHumanAuthenticatedJourneyPlatformBoundary();
  const runProtectedSkillJourney = async (skillJourney, host) => {
    assertEqual(
      skillJourney.protected_journeys,
      {
        declaration_schema: "launchrally.dev/protected-journey/v1",
        permission_id: "authenticated_journey_verification",
        permission_boundary: "authenticated_network_read",
        plan_schema: "launchrally.dev/authenticated-journey-plan/v1",
        adapter_version: "host-agent-authenticated-journey/v1",
        result_schema: "launchrally.dev/authenticated-journey-results/v1",
        attestation_schema: "launchrally.dev/authenticated-journey-attestation/v1",
        attestation_authority: "external_host_adapter",
        evidence_schema: "launchrally.dev/authenticated-journey-evidence/v1",
        qualifying_statuses: ["passed", "failed"],
        unverified_result: "verification_gap_without_evidence",
        resume_argument: "--journey-results",
        retained_fields: ["journey_id", "status", "outcome", "status_code", "collected_at"],
        raw_auth_material: "excluded",
      },
      `packaged_${host}_protected_journey_contract_drift`,
      `${host} must ship the complete protected journey host contract`,
    );
    const { resumeAuthenticatedJourney } = await import(
      pathToFileURL(path.join(
        cleanProject,
        "node_modules",
        "@launchrally",
        `${host}-plugin`,
        "host-adapter",
        "authenticated-journey.js",
      )).href
    );
    const exercisePackagedHostRunner = async (statusCode, expected) => {
      const expectedOutcome = process.platform === "win32" && expected.authenticated
        ? "runner_unavailable"
        : expected.outcome;
      const expectedEvidence = process.platform === "win32"
        ? false
        : expected.evidence;
      const server = createServer({
        key: await readFile(path.join(root, "test", "fixtures", "self-signed-key.pem")),
        cert: await readFile(path.join(root, "test", "fixtures", "self-signed-cert.pem")),
      }, (request, response) => {
        effectObservations.authenticated_network.push({
          effect: "authenticated_network_read",
          method: request.method,
          destination: "loopback_fixture",
          authentication_source: "owner_private_reference",
        });
        response.writeHead(statusCode);
        response.end();
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const target = `https://localhost:${server.address().port}`;
      const bridgeRepository = path.join(
        temporaryRoot,
        `${host} packaged host ${expected.outcome}`,
      );
      await cp(
        path.join(root, "fixtures", "coverage", "typescript-astro"),
        bridgeRepository,
        { recursive: true },
      );
      const previousOrigin = process.env.LAUNCHRALLY_AUTHENTICATED_ORIGIN;
      const previousAuthorization = process.env.LAUNCHRALLY_HOST_AUTHORIZATION_FILE;
      const previousCa = process.env.LAUNCHRALLY_HOST_CA_FILE;
      const authorizationRoot = await mkdtemp(
        path.join(os.tmpdir(), "launchrally-packaged-host-auth-"),
      );
      const authorizationFile = path.join(authorizationRoot, "authorization");
      process.env.LAUNCHRALLY_AUTHENTICATED_ORIGIN = target;
      process.env.LAUNCHRALLY_HOST_CA_FILE = path.join(
        root,
        "test",
        "fixtures",
        "self-signed-cert.pem",
      );
      if (expected.authenticated) {
        await writeFile(authorizationFile, "Bearer packaged-host-secret", { mode: 0o600 });
        process.env.LAUNCHRALLY_HOST_AUTHORIZATION_FILE = authorizationFile;
      } else {
        delete process.env.LAUNCHRALLY_HOST_AUTHORIZATION_FILE;
      }
      try {
        const invoke = async (...arguments_) => JSON.parse((await invokeLauncher(
          "rally",
          [...arguments_, "--json", "--cwd", bridgeRepository],
          { cwd: temporaryRoot, env: launcherEnvironment },
        )).stdout);
        const initial = await invoke("audit");
        const confirmation = await invoke(
          "audit", "--resume", initial.interaction.resume_token,
          "--answers", JSON.stringify({
            intended_environment: "staging",
            production_targets: [target],
            core_journeys: [{
              schema_version: skillJourney.protected_journeys.declaration_schema,
              method: "GET",
              path: "/control",
              purpose: `${host} packaged protected Control Room loads`,
              access: {
                authentication_class: "staff",
                authenticated_status_codes: [200],
              },
            }],
            provider_roles: [],
            support_layers: [],
          }),
        );
        const permission = await invoke(
          "audit", "--resume", confirmation.interaction.resume_token,
          "--confirm", "confirm",
        );
        const input = await invoke(
          "audit", "--resume", permission.interaction.resume_token,
          "--permissions", JSON.stringify({
            public_verification: "denied",
            authenticated_journey_verification: "approved",
          }),
        );
        const result = await resumeAuthenticatedJourney({
          cwd: bridgeRepository,
          operation: "audit",
          resume_token: input.interaction.resume_token,
          request: input.request,
        });
        if (
          result.status !== "completed"
          || result.evidence_index.entries.some(
            ({ evidence_kind: kind }) => kind === "authenticated_journey_machine_evidence",
          ) !== expectedEvidence
          || (expectedEvidence && expected.assessment
            && result.report.assessment !== expected.assessment)
          || (!expectedEvidence && !result.report.results.verification_gaps.some(
            ({ reason_code: reasonCode }) => reasonCode === expectedOutcome,
          ))
          || /packaged-host-secret|bearer\s|"cookie"|"headers"|response_body/iu.test(
            JSON.stringify(result),
          )
        ) throw new Error(`packaged_${host}_${expectedOutcome}_host_runner_failed`);
        effectObservations.normalized_outputs.push(JSON.stringify(result));
        if (expectedEvidence) {
          assertEnvironmentBoundEvidence(
            result,
            "staging",
            expected.outcome === "completed" ? "passed" : "failed",
            {
              evidenceKind: "authenticated_journey_machine_evidence",
              target: `${target}/control`,
            },
          );
          if (expected.outcome === "completed") successfulDownstreamEvidence = true;
          else unsuccessfulDownstreamEvidence = true;
          p1Scenarios.add("environment_isolation");
        }
        return result;
      } finally {
        if (previousOrigin === undefined) delete process.env.LAUNCHRALLY_AUTHENTICATED_ORIGIN;
        else process.env.LAUNCHRALLY_AUTHENTICATED_ORIGIN = previousOrigin;
        if (previousAuthorization === undefined) {
          delete process.env.LAUNCHRALLY_HOST_AUTHORIZATION_FILE;
        } else {
          process.env.LAUNCHRALLY_HOST_AUTHORIZATION_FILE = previousAuthorization;
        }
        if (previousCa === undefined) delete process.env.LAUNCHRALLY_HOST_CA_FILE;
        else process.env.LAUNCHRALLY_HOST_CA_FILE = previousCa;
        await rm(authorizationRoot, { recursive: true, force: true });
        await new Promise((resolve) => server.close(resolve));
      }
    };
    const supportedSuccess = await exercisePackagedHostRunner(200, {
      outcome: "completed", authenticated: true, evidence: true,
    });
    const supportedFailure = await exercisePackagedHostRunner(403, {
      outcome: "unexpected_denial", authenticated: true, evidence: true, assessment: "no_go",
    });
    await exercisePackagedHostRunner(401, {
      outcome: "expired_authentication", authenticated: true, evidence: false,
    });
    await exercisePackagedHostRunner(200, {
      outcome: "missing_authentication", authenticated: false, evidence: false,
    });
    if (process.platform === "win32") {
      const environmentGapObserved = [supportedSuccess, supportedFailure].every((result) =>
        result.report?.scope?.release_intent?.intended_environment === "staging"
        && !result.evidence_index.entries.some(
          ({ evidence_kind: kind }) => kind === "authenticated_journey_machine_evidence",
        )
        && result.report.results.verification_gaps.some(
          ({ reason_code: reasonCode }) => reasonCode === "runner_unavailable",
        ));
      if (!environmentGapObserved) {
        throw new Error(`packaged_${host}_windows_environment_isolation_gap_missing`);
      }
      p1Scenarios.add("environment_isolation");
    }
    const protectedRepository = path.join(temporaryRoot, `${host} protected journey`);
    await cp(
      path.join(root, "fixtures", "coverage", "typescript-astro"),
      protectedRepository,
      { recursive: true },
    );
    const applicationSnapshot = (await snapshotTree(protectedRepository)).filter(
      ([relativePath]) => !relativePath.startsWith(".launchrally/"),
    );
    const run = async (...arguments_) => {
      try {
        return JSON.parse((await invokeLauncher(
          "rally",
          [...arguments_, "--json", "--cwd", protectedRepository],
          { cwd: temporaryRoot, env: launcherEnvironment },
        )).stdout);
      } catch (error) {
        if (typeof error.stdout !== "string" || error.stdout.trim() === "") throw error;
        return JSON.parse(error.stdout);
      }
    };
    const fixtureHostEffects = [];
    const executeFixtureAuthenticatedRead = (plan) => {
      if (
        plan.operation !== "read_only"
        || typeof plan.collection_not_before !== "string"
        || plan.requested_fields.join(",")
          !== "journey_id,status,outcome,status_code,collected_at"
      ) throw new Error(`packaged_${host}_authenticated_runner_contract_failed`);
      const fixtureSession = Object.freeze({
        authentication_class: "staff",
        capability: "control:read",
        target: "https://example.com/control",
      });
      const results = plan.journeys.map((journey) => {
        if (
          journey.authentication_class !== fixtureSession.authentication_class
          || journey.target !== fixtureSession.target
          || journey.method !== "GET"
        ) throw new Error(`packaged_${host}_authenticated_fixture_scope_failed`);
        fixtureHostEffects.push({
          effect: "authenticated_network_read",
          target: journey.target,
          capability: fixtureSession.capability,
        });
        return {
          journey_id: journey.journey_id,
          status: "passed",
          outcome: "completed",
          status_code: journey.expected_status_codes[0],
          collected_at: new Date(Math.max(
            Date.now(),
            new Date(plan.collection_not_before).valueOf() + 1,
          )).toISOString(),
        };
      });
      return JSON.stringify({
        schema_version: skillJourney.protected_journeys.result_schema,
        adapter_version: skillJourney.protected_journeys.adapter_version,
        results,
      });
    };
    const input = await run("audit");
    const confirmation = await run(
      "audit",
      "--resume",
      input.interaction.resume_token,
      "--answers",
      JSON.stringify({
        intended_environment: "staging",
        production_targets: ["https://example.com"],
        core_journeys: [{
          schema_version: skillJourney.protected_journeys.declaration_schema,
          method: "GET",
          path: "/control",
          purpose: `${host} protected Control Room loads`,
          access: {
            authentication_class: "staff",
            authenticated_status_codes: [200],
          },
        }],
        provider_roles: [],
        support_layers: [],
      }),
    );
    const permission = await run(
      "audit",
      "--resume",
      confirmation.interaction.resume_token,
      "--confirm",
      "confirm",
    );
    const resultInput = await run(
      "audit",
      "--resume",
      permission.interaction.resume_token,
      "--permissions",
      JSON.stringify({
        public_verification: "denied",
        authenticated_journey_verification: "approved",
      }),
    );
    if (
      resultInput.status !== "needs_input"
      || resultInput.request?.result_schema !== skillJourney.protected_journeys.result_schema
      || resultInput.request?.plan?.schema_version !== skillJourney.protected_journeys.plan_schema
    ) throw new Error(`packaged_${host}_protected_audit_input_failed`);
    const normalizedResults = executeFixtureAuthenticatedRead(resultInput.request.plan);
    const audit = await run(
      "audit",
      "--resume",
      resultInput.interaction.resume_token,
      skillJourney.protected_journeys.resume_argument,
      normalizedResults,
    );
    if (
      audit.status !== "completed"
      || audit.evidence_index.entries.some(
        ({ evidence_kind: kind }) => kind === "authenticated_journey_machine_evidence",
      )
      || !audit.report.results.verification_gaps.some(
        ({ reason_code: reasonCode }) => reasonCode === "unsupported_adapter",
      )
    ) throw new Error(`packaged_${host}_unattested_audit_not_gap`);
    const reportPath = path.join(temporaryRoot, `${host}-protected-audit.json`);
    await writeFile(reportPath, JSON.stringify(audit));
    const initPreview = await run("init", "--report", reportPath);
    if (initPreview.status !== "needs_confirmation") {
      throw new Error(
        `packaged_${host}_protected_init_preview_failed: ${JSON.stringify(initPreview)}`,
      );
    }
    const initialized = await run(
      "init",
      "--resume",
      initPreview.interaction.resume_token,
      "--confirm",
      "confirm",
    );
    if (initialized.status !== "completed") {
      throw new Error(`packaged_${host}_protected_init_failed`);
    }
    const verifyPermission = await run(
      "verify",
      "--report",
      reportPath,
      "--scope",
      "full",
    );
    const verifyInput = await run(
      "verify",
      "--resume",
      verifyPermission.interaction.resume_token,
      "--permissions",
      JSON.stringify({
        public_verification: "denied",
        authenticated_journey_verification: "approved",
      }),
    );
    const verify = await run(
      "verify",
      "--resume",
      verifyInput.interaction.resume_token,
      skillJourney.protected_journeys.resume_argument,
      executeFixtureAuthenticatedRead(verifyInput.request.plan),
    );
    if (
      verify.status !== "completed"
      || verify.evidence_index.entries.some(
        ({ evidence_kind: kind }) => kind === "authenticated_journey_machine_evidence",
      )
      || !verify.report.results.verification_gaps.some(
        ({ reason_code: reasonCode }) => reasonCode === "unsupported_adapter",
      )
    ) throw new Error(`packaged_${host}_unattested_verify_not_gap`);
    if (/session=|bearer\s|"cookie"|"headers"/iu.test(JSON.stringify(verify))) {
      throw new Error(`packaged_${host}_protected_auth_material_retained`);
    }
    if (
      fixtureHostEffects.length !== 2
      || fixtureHostEffects.some(({ effect }) => effect !== "authenticated_network_read")
    ) throw new Error(`packaged_${host}_protected_forbidden_host_effect`);
    assertEqual(
      (await snapshotTree(protectedRepository)).filter(
        ([relativePath]) => !relativePath.startsWith(".launchrally/"),
      ),
      applicationSnapshot,
      `packaged_${host}_protected_journey_mutated_application`,
      `${host} must not perform login, capability grants, deployment, or application writes`,
    );
    effectObservations.file_boundaries.push({
      boundary: `${host}_protected_application`,
      preserved: true,
    });
  };
  await runProtectedSkillJourney(journey, "codex");
  await runProtectedSkillJourney(claudeJourney, "claude");
  let activeRepository = repository;
  const invoke = async (id, replacements = {}, options = {}) => {
    const invocation = findFixtureInvocation(journey, id);
    const arguments_ = fixtureArguments(journey, id, {
      "{repository_root}": activeRepository,
      ...replacements,
    });
    let result;
    let exitCode = 0;
    try {
      const execution = await invokeLauncher("rally", arguments_, {
        cwd: temporaryRoot,
        env: options.environment ?? launcherEnvironment,
      });
      result = JSON.parse(execution.stdout);
    } catch (error) {
      if (typeof error.stdout !== "string" || error.stdout.trim() === "") throw error;
      result = JSON.parse(error.stdout);
      exitCode = Number.isInteger(error.code) ? error.code : 1;
    }
    if (options.validate !== false) {
      assertFixtureResult(journey, invocation, result, exitCode);
    }
    return options.includeExitCode ? { exitCode, result } : result;
  };
  const fixtureInvocations = [];
  const invokeFixture = async (id, replacements, options) => {
    const result = await invoke(id, replacements, options);
    fixtureInvocations.push(id);
    return result;
  };

  const versionResult = await invokeFixture("version");
  if (
    versionResult.status !== "completed"
    || versionResult.cli_version !== version
    || versionResult.authority?.source !== "launcher"
  ) throw new Error("isolated_prefix_version_verification_failed");

  const auditInput = await invokeFixture("audit_input");
  const answers = JSON.stringify({
    intended_environment: "production",
    production_targets: ["https://example.com"],
    core_journeys: [{ method: "GET", path: "/", purpose: "artifact journey" }],
    provider_roles: [],
    support_layers: [],
  });
  const auditConfirmation = await invokeFixture("audit_confirmation", {
    "{audit_resume}": auditInput.interaction.resume_token,
    "{answers_json}": answers,
  });
  const auditPermission = await invokeFixture("audit_permission", {
    "{audit_resume}": auditConfirmation.interaction.resume_token,
  });
  const permissions = JSON.stringify({ public_verification: "denied" });
  const auditCompleted = await invokeFixture("audit_completed", {
    "{audit_resume}": auditPermission.interaction.resume_token,
    "{permissions_json}": permissions,
  });
  if (auditCompleted.status !== "completed" || !auditCompleted.report) {
    throw new Error("installation_journey_audit_failed");
  }
  const reportPath = path.join(temporaryRoot, "installation-journey-report.json");
  await writeFile(reportPath, JSON.stringify(auditCompleted));

  let intentCompleted;
  await withDeniedProcessEffects(effectObservations, async () => {
    hostProductIntentModules = await Promise.all(["codex", "claude"].map(async (host) => ({
      host,
      module: await import(pathToFileURL(path.join(
        cleanProject,
        "node_modules",
        "@launchrally",
        `${host}-plugin`,
        "host-adapter",
        "product-intent.js",
      )).href),
    })));
    for (const { host, module } of hostProductIntentModules) {
      const runProductIntentDiscovery = host === "codex"
        ? module.runCodexProductIntentDiscovery
        : module.runClaudeProductIntentDiscovery;
      const intentInput = await runProductIntentDiscovery(activeRepository);
      const confirmedBehaviors = intentInput.candidates.behaviors.length > 0
        ? intentInput.candidates.behaviors.map(({ behavior_id: id }) => id)
        : ["teams_collaborate_in_realtime"];
      const intentPreview = await runProductIntentDiscovery(activeRepository, {
        resume_token: intentInput.resume_token,
        answers: {
          intended_environment: "production",
          confirmed_behaviors: confirmedBehaviors,
          hard_constraints: [],
          preferences: [],
        },
      });
      const completed = await runProductIntentDiscovery(activeRepository, {
        resume_token: intentPreview.resume_token,
        confirmation: "confirm",
      });
      if (completed.status !== "completed") {
        throw new Error(`packed_${host}_phase_1_intent_discovery_failed`);
      }
      intentCompleted ??= completed;
      assertEqual(
        { ...completed.profile, created_at: null },
        { ...intentCompleted.profile, created_at: null },
        `packed_${host}_phase_1_intent_drift`,
        "Codex and Claude must expose the same typed no-PRD Product Intent result",
      );
    }
  });
  p1Scenarios.add("no_prd");
  const unsupportedMaterial = path.join(activeRepository, "unsupported-product-material.pdf");
  await writeFile(unsupportedMaterial, "synthetic unsupported product material\n");
  const semanticPartial = await withDeniedProcessEffects(effectObservations, async () => {
    const semanticInput = await hostProductIntentModules[0].module
      .runCodexProductIntentDiscovery(
        activeRepository,
        { selected_materials: [path.basename(unsupportedMaterial)] },
      );
    return hostProductIntentModules[0].module.runCodexProductIntentDiscovery(
      activeRepository,
      {
        resume_token: semanticInput.resume_token,
        permission_decision: "approved",
      },
    );
  });
  await rm(unsupportedMaterial);
  if (
    semanticPartial.status !== "needs_input"
    || semanticPartial.coverage.state !== "partial"
    || semanticPartial.coverage.negative_findings_allowed !== false
  ) throw new Error("packed_incomplete_semantic_coverage_drift");
  p1Scenarios.add("incomplete_semantic_coverage");
  const catalog = createCapabilityCatalog({ reviewed_at: "2026-08-14T00:00:00.000Z" });
  const graph = buildCapabilityGraph(intentCompleted.profile, catalog, {
    graph_id: "graph_packed_phase_1_docs",
  });
  const integrationContracts = [createIntegrationContract({
    contract_id: "integration_packed_identity_data",
    environment: "production",
    source_capability_id: "identity_authentication",
    target_capability_id: "application_data",
    mode: "asynchronous",
    provider_binding: { kind: "unknown", provider_id: null },
    semantics: {
      authentication: "signed_or_equivalent",
      ordering: "per_subject",
      duplication: "possible",
      retry: "bounded_backoff",
      replay: "supported",
      idempotency: "required",
      eventual_consistency: "expected",
      failure_visibility: "operator_visible",
      privacy: "normalized_identifiers_only",
      success_evidence: ["state_transition_observed"],
      invalidation_dependencies: ["identity_event_shape", "application_data_projection"],
    },
  })];
  await Promise.all([
    writeFile(path.join(temporaryRoot, "launchrally-current-report.json"), JSON.stringify(auditCompleted)),
    writeFile(path.join(temporaryRoot, "product-intent.json"), JSON.stringify(intentCompleted.profile)),
    writeFile(path.join(temporaryRoot, "capability-catalog.json"), JSON.stringify(catalog)),
    writeFile(path.join(temporaryRoot, "capability-graph.json"), JSON.stringify(graph)),
    writeFile(path.join(temporaryRoot, "integration-contracts.json"), JSON.stringify(integrationContracts)),
  ]);
  const invokeDocumentedPhase1Command = async (example) => {
    const rendered = process.platform === "win32" ? example.powershell : example.posix;
    const substitutions = [["./app", shellQuote(activeRepository)]];
    for (const argument of example.argv) {
      if (!argument.startsWith("./") || argument === "./app") continue;
      substitutions.push([
        argument,
        shellQuote(path.join(temporaryRoot, path.basename(argument))),
      ]);
    }
    const execution = await runDocumentedShell(shellCommand(rendered, substitutions), {
      cwd: temporaryRoot,
      env: launcherEnvironment,
    });
    const result = JSON.parse(execution.stdout);
    if (
      result.contract !== example.expected.contract
      || result.operation !== example.operation
      || result.status !== example.expected.status
      || (example.expected.state !== null && result.state !== example.expected.state)
    ) throw new Error(`packed_phase_1_shell_command_failed:${example.operation}`);
    return result;
  };
  const architectExample = phase1Commands.commands.find(
    ({ operation }) => operation === "architect",
  );
  const architectPreview = await invokeDocumentedPhase1Command(architectExample);
  const sourceArchitecture = createArchitecturePackageBundle({
    blueprint: architectPreview.blueprint,
    product_intent: intentCompleted.profile,
    catalog,
    capability_graph: graph,
    integration_contracts: integrationContracts,
    provider_knowledge_refs: [],
    decision_results: architectPreview.blueprint.decisions.map(({ decision_id: id }) => ({
      decision_id: id,
      response: "confirm",
    })),
    task_graph: null,
    dependencies: architectPreview.blueprint.decisions.map(({ decision_id: id }) => ({
      source_id: id,
      dependent_semantics: ["architecture_record"],
      evidence_ids: [],
    })),
    interaction_id: "interaction_architecture_decision_engine",
  }, { now: "2026-08-14T00:00:00.000Z" });
  const architectureCompleted = {
    status: "completed",
    architecture_package: sourceArchitecture,
  };
  if (architectureCompleted.status !== "completed") {
    throw new Error("packed_phase_1_architecture_completion_failed");
  }
  await writeFile(
    path.join(temporaryRoot, "architecture-package.json"),
    JSON.stringify(architectureCompleted.architecture_package),
  );
  const planExample = phase1Commands.commands.find(({ operation }) => operation === "plan");
  const phase1Plan = await invokeDocumentedPhase1Command(planExample);
  await writeFile(path.join(temporaryRoot, "task-graph.json"), JSON.stringify(phase1Plan.task_graph));
  const staleArchitecture = structuredClone(sourceArchitecture);
  staleArchitecture.package.currentness = {
    state: "needs_reassessment",
    invalidated_record_ids: [staleArchitecture.architecture_record.record_id],
    reasons: ["source_report_changed"],
  };
  await writeFile(
    path.join(temporaryRoot, "architecture-package.json"),
    JSON.stringify(staleArchitecture),
  );
  const staleArchitecturePlan = await invokeDocumentedPhase1Command(planExample);
  if (
    staleArchitecturePlan.status !== "completed"
    || staleArchitecturePlan.task_graph?.currentness?.state !== "stale"
    || staleArchitecturePlan.task_graph?.ready_frontier?.length !== 0
  ) throw new Error("packed_stale_architecture_not_blocked");
  p1Scenarios.add("stale_architecture");
  await writeFile(
    path.join(temporaryRoot, "architecture-package.json"),
    JSON.stringify(sourceArchitecture),
  );
  const descriptor = referenceExecutorDescriptors[0];
  await Promise.all([
    writeFile(path.join(temporaryRoot, "executor-descriptors.json"), JSON.stringify([descriptor])),
    writeFile(path.join(temporaryRoot, "tool-observations.json"), JSON.stringify([{
      tool_id: descriptor.tools[0].tool_id,
      executable: descriptor.tools[0].executable,
      detected_version: descriptor.tools[0].exact_version,
      state: "available",
    }])),
    writeFile(path.join(temporaryRoot, "reviewed-executors.json"), JSON.stringify([{
      descriptor_id: descriptor.descriptor_id,
      descriptor_version: descriptor.descriptor_version,
      digest: descriptor.trust.digest,
    }])),
  ]);
  const handoffExample = phase1Commands.commands.find(({ operation }) => operation === "handoff");
  const handoffDiscovery = await invokeDocumentedPhase1Command(handoffExample);
  const portableTaskTarget = "repository:packed-cross-host-handoff";
  const portableTaskGraph = {
    schema_version: "launchrally.dev/task-graph/v1",
    graph_id: "task_graph_packed_cross_host_handoff",
    revision: 1,
    environment: "development",
    source_report: {
      id: "report_packed_cross_host_handoff",
      schema_version: "launchrally.dev/report/v2",
      digest: `sha256:${"1".repeat(64)}`,
    },
    architecture_record: {
      id: "architecture_packed_cross_host_handoff",
      schema_version: "launchrally.dev/architecture-record/v1",
      digest: `sha256:${"2".repeat(64)}`,
    },
    currentness: { state: "current", reasons: [] },
    tasks: [{
      task_id: "task_packed_cross_host_handoff",
      task_type: "implement_architecture_decision",
      source: "implementation_work",
      source_id: "work_packed_cross_host_handoff",
      environment: "development",
      prerequisites: [],
      effect_class: "local_source",
      expected_target: portableTaskTarget,
      allowed_effects: ["source_write"],
      prohibited_effects: [
        "credential_persistence",
        "deployment_write",
        "production_data_write",
        "provider_configuration_write",
      ],
      recovery_notes: ["Preserve typed state and retry only after explicit approval."],
      minimum_executor_capability: "local_source_write_v1",
      structured_result_schema: "launchrally.dev/execution-receipt/v1",
      evidence_targets: [portableTaskTarget],
      follow_up_verify: {
        operation: "verify",
        scope: "local_source",
        fresh_evidence_required: true,
      },
      cancellation_behavior: "stop_before_next_effect",
      status: "not_started",
    }],
    ready_frontier: ["task_packed_cross_host_handoff"],
  };
  const portableHandoff = await runHandoff({
    task_graph: portableTaskGraph,
    executor_descriptors: [descriptor],
    tool_observations: [{
      tool_id: descriptor.tools[0].tool_id,
      executable: descriptor.tools[0].executable,
      detected_version: descriptor.tools[0].exact_version,
      state: "available",
    }],
    reviewed_executors: [{
      descriptor_id: descriptor.descriptor_id,
      descriptor_version: descriptor.descriptor_version,
      digest: descriptor.trust.digest,
    }],
  }, {}, {
    platform: `${process.platform}-${process.arch}`,
    now: "2026-08-14T12:00:00.000Z",
  });
  if (
    handoffDiscovery.status !== "needs_input"
    || portableHandoff.status !== "needs_input"
    || portableHandoff.state !== "executor_discovery"
    || portableHandoff.request?.kind !== "executor_selection"
  ) throw new Error("packed_handoff_cli_core_drift");
  const [codexResume, claudeResume] = await Promise.all(["codex", "claude"].map((host) =>
    import(pathToFileURL(path.join(
      cleanProject,
      "node_modules",
      "@launchrally",
      `${host}-plugin`,
      "host-adapter",
      "resume.js",
    )).href)));
  if (process.platform === "win32") {
    await claudeResume.saveResumeArtifact(
      path.join(temporaryRoot, "handoff-cross-host-resume.json"),
      portableHandoff.interaction,
      activeRepository,
    ).then(
      () => { throw new Error("packed_windows_handoff_cross_host_resume_not_denied"); },
      (error) => {
        if (error?.code !== "host_resume_unavailable") throw error;
      },
    );
  } else {
    const handoffArtifact = path.join(temporaryRoot, "handoff-cross-host-resume.json");
    try {
      await claudeResume.saveResumeArtifact(
        handoffArtifact,
        portableHandoff.interaction,
        activeRepository,
      );
    } catch (error) {
      throw new Error(`packed_handoff_artifact_save_failed:${error?.code}:${error?.message}`);
    }
    const handoffResumed = await codexResume.resumeArtifactFile({
      cwd: activeRepository,
      artifact_path: handoffArtifact,
      options: {
        selection: portableHandoff.request.choices[0],
        now: "2026-08-14T12:00:00.000Z",
      },
    });
    if (
      handoffResumed.status !== "needs_confirmation"
      || handoffResumed.state !== "authority_preview"
      || handoffResumed.handoff_package?.approval?.state !== "required"
    ) throw new Error("packed_handoff_cross_host_resume_failed");
  }

  const initPreview = await invokeFixture("init_preview", {
    "{manifest_source_report_path}": reportPath,
  });
  if (initPreview.status !== "needs_confirmation") {
    throw new Error(`installation_journey_init_preview_failed: ${initPreview.status}`);
  }
  const initialized = await invokeFixture("init_completed", {
    "{init_resume}": initPreview.interaction.resume_token,
  });
  if (initialized.status !== "completed") {
    throw new Error("installation_journey_init_failed");
  }
  const invokePackedAudit = async (...arguments_) => JSON.parse((await invokeLauncher(
    "rally",
    [...arguments_, "--json", "--cwd", activeRepository],
    { cwd: temporaryRoot, env: launcherEnvironment },
  )).stdout);
  const currentAuditInput = await invokePackedAudit("audit");
  const currentAuditConfirmation = await invokePackedAudit(
    "audit", "--resume", currentAuditInput.interaction.resume_token,
    "--answers", answers,
  );
  const currentAuditPermission = await invokePackedAudit(
    "audit", "--resume", currentAuditConfirmation.interaction.resume_token,
    "--confirm", "confirm",
  );
  const currentArchitectureReport = await invokePackedAudit(
    "audit", "--resume", currentAuditPermission.interaction.resume_token,
    "--permissions", JSON.stringify({ public_verification: "denied" }),
  );
  if (
    currentArchitectureReport.status !== "completed"
    || !currentArchitectureReport.report
  ) throw new Error("packed_p0_to_p1_current_report_failed");
  await writeFile(
    path.join(temporaryRoot, "launchrally-current-report.json"),
    JSON.stringify(currentArchitectureReport),
  );
  await writeFile(
    path.join(temporaryRoot, "launchrally-manifest-source-report.json"),
    JSON.stringify(auditCompleted),
  );
  const verifyExample = phase1Commands.commands.find(({ operation }) => operation === "verify");
  const phase1VerifyPermission = await invokeDocumentedPhase1Command(verifyExample);
  const verifyContinuation = verifyExample.success_continuation;
  const completedVerifyCommand = shellCommand(
    process.platform === "win32"
      ? verifyContinuation.powershell
      : verifyContinuation.posix,
    [
      ["./app", shellQuote(activeRepository)],
      ["<verify-token>", phase1VerifyPermission.interaction.resume_token],
    ],
  );
  const phase1Verify = JSON.parse((await runDocumentedShell(completedVerifyCommand, {
    cwd: temporaryRoot,
    env: launcherEnvironment,
  })).stdout);
  if (
    phase1Verify.contract !== verifyContinuation.expected.contract
    || phase1Verify.operation !== "verify"
    || phase1Verify.status !== verifyContinuation.expected.status
    || !phase1Verify.report
    || !phase1Verify.evidence_index
  ) throw new Error(`packed_phase_1_verify_continuation_failed:${phase1Verify.status}`);
  const executeIntegrationFreshVerify = async () => {
    let integrationSource = phase1Verify;
    const integrationReportPath = path.join(
      temporaryRoot,
      "integration-fresh-verify-source.json",
    );
    for (const family of P1_INTEGRATION_FAMILIES) {
      const binding = integrationVerificationRequests.get(family);
      const evidenceTargets = binding?.request?.task_requests?.[0]?.evidence_targets ?? [];
      const exactTarget = evidenceTargets[0] ?? "";
      if (
        !binding
        || evidenceTargets.length !== 1
        || !exactTarget.startsWith("repository:.env.reference_")
        || !exactTarget.endsWith(".example")
        || !exactTarget.includes(binding.pack_digest.slice(7))
        || !exactTarget.includes(binding.implementation_id)
        || binding.verification_subject?.target !== exactTarget
        || binding.verification_subject?.environment !== "production"
        || binding.verification_subject?.payload?.pack_ref?.digest !== binding.pack_digest
        || binding.verification_subject?.payload?.implementation?.id
          !== binding.implementation_id
      ) throw new Error(`packed_integration_verify_request_unbound:${family}`);
      await writeFile(integrationReportPath, JSON.stringify(integrationSource));
      const marker = `${JSON.stringify(binding.verification_subject.payload)}\n`;
      const evidencePath = exactTarget.slice("repository:".length);
      await writeFile(path.join(activeRepository, evidencePath), marker);
      const permission = JSON.parse((await invokeLauncher("rally", [
        "verify", "--json", "--cwd", activeRepository,
        "--report", integrationReportPath,
        "--scope", "full",
      ], { cwd: temporaryRoot, env: launcherEnvironment })).stdout);
      const verified = JSON.parse((await invokeLauncher("rally", [
        "verify", "--json", "--cwd", activeRepository,
        "--resume", permission.interaction.resume_token,
        "--permissions", JSON.stringify({ public_verification: "denied" }),
      ], { cwd: temporaryRoot, env: launcherEnvironment })).stdout);
      const entry = assertEnvironmentBoundEvidence(
        verified,
        "production",
        "passed",
        { target: exactTarget },
      );
      const pack = referenceIntegrationPacks.find(({ family: candidate }) => (
        candidate === family
      ));
      const qualification = qualifyReferenceVerificationEvidence(
        pack,
        binding.implementation_id,
        entry,
        marker,
        "2026-08-14T12:00:00.000Z",
        binding.verification_subject.environment,
      );
      if (
        verified.status !== "completed"
        || entry.evidence_kind !== "file"
        || entry.normalized_artifact?.path !== evidencePath
        || entry.normalized_artifact?.content_digest !== sha256Text(marker)
        || qualification.status !== "verified"
        || qualification.evidence_ref?.digest !== entry.digest
        || JSON.stringify(qualification.observation)
          !== JSON.stringify(binding.verification_subject.expected_observation)
        || !verified.comparison?.invalidated_evidence?.some(
          ({ target }) => target === exactTarget,
        )
      ) throw new Error(`packed_integration_fresh_verify_failed:${family}`);
      integrationFreshVerify[family] = "environment_bound_fresh_evidence";
      integrationSource = verified;
    }
    return integrationSource;
  };
  const migrationBefore = await snapshotTree(path.join(activeRepository, ".launchrally"));
  const migrationSource = {
    report_package: currentArchitectureReport,
    product_intent: intentCompleted.profile,
    catalog,
    capability_graph: graph,
    integration_contracts: integrationContracts,
  };
  const interruptedPreview = await runArchitectureJourney(
    activeRepository,
    migrationSource,
    { review_date: "2026-08-14", launcher_version: version },
  );
  const interrupted = await runArchitectureJourney(activeRepository, {}, {
    resume_token: interruptedPreview.interaction.resume_token,
    migration_confirmation: "confirm",
    launcher_version: version,
    file_operations: {
      async before_migration_commit() {
        const error = new Error("simulated packed P0 to P1 interruption");
        error.code = "simulated_p0_p1_migration_interruption";
        throw error;
      },
    },
  });
  if (
    interrupted.status !== "execution_error"
    || interrupted.error !== "simulated_p0_p1_migration_interruption"
  ) throw new Error(
    `packed_p0_to_p1_migration_interruption_failed:${JSON.stringify(interrupted)}`,
  );
  assertEqual(
    await snapshotTree(path.join(activeRepository, ".launchrally")),
    migrationBefore,
    "packed_p0_to_p1_interruption_changed_p0",
    "Interrupted P1 adoption must roll back every P0 project byte",
  );
  const migrationPreview = await invokeDocumentedPhase1Command(architectExample);
  if (
    migrationPreview.status !== "needs_confirmation"
    || migrationPreview.request?.kind !== "p1_migration_confirmation"
    || migrationPreview.migration_preview?.schema_version
      !== "launchrally.dev/phase-1-migration-preview/v1"
  ) throw new Error("packed_p0_to_p1_migration_preview_failed");
  const migrationArtifact = path.join(temporaryRoot, "p0-to-p1-cross-host-resume.json");
  let migrationDenied;
  if (process.platform === "win32") {
    await codexResume.saveResumeArtifact(
      migrationArtifact,
      migrationPreview.interaction,
      activeRepository,
    ).then(
      () => { throw new Error("packed_windows_cross_host_resume_not_denied"); },
      (error) => {
        if (error?.code !== "host_resume_unavailable") throw error;
      },
    );
    migrationDenied = JSON.parse((await invokeLauncher("rally", [
      "architect", "--json", "--cwd", activeRepository,
      "--resume", migrationPreview.interaction.resume_token,
      "--confirm", "deny",
    ], { cwd: temporaryRoot, env: launcherEnvironment })).stdout);
  } else {
    try {
      await codexResume.saveResumeArtifact(
        migrationArtifact,
        migrationPreview.interaction,
        activeRepository,
      );
    } catch (error) {
      throw new Error(`packed_architecture_artifact_save_failed:${error?.code}:${error?.message}`);
    }
    migrationDenied = await claudeResume.resumeArtifactFile({
      cwd: activeRepository,
      artifact_path: migrationArtifact,
      options: { migration_confirmation: "deny", launcher_version: version },
    });
  }
  if (
    migrationDenied.status !== "denied"
    || migrationDenied.outcome !== "p1_migration_denied"
  ) throw new Error("packed_p0_to_p1_migration_denial_failed");
  assertEqual(
    await snapshotTree(path.join(activeRepository, ".launchrally")),
    migrationBefore,
    "packed_p0_to_p1_migration_changed_p0",
    "Denied P1 migration must preserve every P0 project byte",
  );
  const invokeMigrationArchitect = async (repository) => {
    const arguments_ = architectExample.argv.map((argument) => {
      if (argument === "./app") return repository;
      if (argument.startsWith("./")) {
        return path.join(temporaryRoot, path.basename(argument));
      }
      return argument;
    });
    return JSON.parse((await invokeLauncher("rally", arguments_, {
      cwd: temporaryRoot,
      env: launcherEnvironment,
    })).stdout);
  };
  const adoptionPreview = await invokeMigrationArchitect(activeRepository);
  const adopted = JSON.parse((await invokeLauncher("rally", [
    "architect", "--json", "--cwd", activeRepository,
    "--resume", adoptionPreview.interaction.resume_token,
    "--confirm", "confirm",
  ], { cwd: temporaryRoot, env: launcherEnvironment })).stdout);
  if (adopted.status !== "needs_confirmation" || adopted.state !== "blueprint_review") {
    throw new Error("packed_p0_to_p1_migration_adoption_failed");
  }
  const adoption = JSON.parse(await readFile(path.join(
    activeRepository,
    ".launchrally",
    "phase-1",
    "adoption.json",
  ), "utf8"));
  if (
    adoption.schema_version !== "launchrally.dev/phase-1-adoption/v1"
    || adoption.historical_reports_relabelled !== false
  ) throw new Error("packed_p0_to_p1_migration_record_drift");
  await executeIntegrationFreshVerify();
  p1Scenarios.add("p0_to_p1_migration");
  p1Scenarios.add("cross_host_resume");
  const projectVersion = await invokeFixture("project_version");
  if (
    projectVersion.status !== "completed"
    || projectVersion.cli_version !== version
    || projectVersion.authority?.source !== "project_toolchain"
  ) throw new Error("project_engine_delegation_failed");

  const manifestContent = await readFile(
    path.join(activeRepository, ".launchrally", "manifest.yaml"),
    "utf8",
  );
  const cleaned = await invokeFixture("toolchain_clean");
  if (
    cleaned.status !== "completed"
    || cleaned.authority?.state !== "needs_toolchain_restore"
  ) throw new Error("artifact_toolchain_clean_failed");

  const missingMaterialization = activeRepository;
  const registryStub = await createArtifactNpmStub(
    temporaryRoot,
    cleanProject,
    version,
    { offlineAvailable: false },
  );
  const registryEnvironment = {
    ...launcherEnvironment,
    PATH: [registryStub, path.dirname(launcher), process.env.PATH ?? ""].join(path.delimiter),
  };
  const approvedRestore = path.join(temporaryRoot, "registry restore approved");
  const deniedRestore = path.join(temporaryRoot, "registry restore denied");
  await Promise.all([
    cp(missingMaterialization, approvedRestore, { recursive: true }),
    cp(missingMaterialization, deniedRestore, { recursive: true }),
  ]);

  activeRepository = approvedRestore;
  const registryPermission = await invokeFixture(
    "toolchain_restore",
    {},
    { environment: registryEnvironment },
  );
  if (registryPermission.status !== "needs_permission") {
    throw new Error("artifact_registry_permission_not_requested");
  }
  const registryApproved = await invokeFixture("toolchain_restore_permission", {
    "{toolchain_resume}": registryPermission.interaction.resume_token,
    "{toolchain_permissions_json}": JSON.stringify({ npm_registry_read: "approved" }),
  }, { environment: registryEnvironment });
  if (registryApproved.status !== "completed" || registryApproved.authority?.state !== "ready") {
    throw new Error("artifact_registry_permission_approval_failed");
  }

  activeRepository = deniedRestore;
  const deniedAuthorityFiles = await Promise.all([
    "package.json",
    "package-lock.json",
    "authority.json",
  ].map((name) => readFile(
    path.join(activeRepository, ".launchrally", "toolchain", name),
    "utf8",
  )));
  const deniedPermission = await invokeFixture(
    "toolchain_restore",
    {},
    { environment: registryEnvironment },
  );
  const registryDeniedExecution = await invoke("toolchain_restore_permission", {
    "{toolchain_resume}": deniedPermission.interaction.resume_token,
    "{toolchain_permissions_json}": JSON.stringify({ npm_registry_read: "denied" }),
  }, {
    environment: registryEnvironment,
    includeExitCode: true,
    validate: false,
  });
  const registryDenied = registryDeniedExecution.result;
  if (
    registryDeniedExecution.exitCode === 0
    || registryDenied.status !== "execution_error"
    || registryDenied.error !== "registry_permission_denied"
  ) throw new Error("artifact_registry_permission_denial_failed");
  await assertMissing(
    deniedPermission.request.permissions[0].temporary_target,
    "artifact_registry_denial_retained_preparation",
  );
  await assertMissing(
    path.join(activeRepository, ".launchrally", "toolchain", "node_modules"),
    "artifact_registry_denial_materialized_engine",
  );
  assertEqual(
    await Promise.all(["package.json", "package-lock.json", "authority.json"].map((name) => (
      readFile(path.join(activeRepository, ".launchrally", "toolchain", name), "utf8")
    ))),
    deniedAuthorityFiles,
    "artifact_registry_denial_authority_drift",
    "registry denial must preserve the exact project authority files",
  );
  assertEqual(
    await readFile(path.join(activeRepository, ".launchrally", "manifest.yaml"), "utf8"),
    manifestContent,
    "artifact_registry_denial_manifest_drift",
    "registry denial must preserve the Manifest byte-for-byte",
  );
  const deniedStatus = await invoke("toolchain_status", {}, {
    environment: registryEnvironment,
  });
  if (
    deniedStatus.status !== "unavailable"
    || deniedStatus.authority?.state !== "needs_toolchain_restore"
  ) throw new Error("artifact_registry_denial_changed_authority_state");

  const freshClone = path.join(temporaryRoot, "fresh clone ü restored");
  await cp(missingMaterialization, freshClone, { recursive: true });
  activeRepository = freshClone;
  const missingStatus = await invokeFixture("toolchain_status");
  if (
    missingStatus.status !== "unavailable"
    || missingStatus.error !== "needs_toolchain_restore"
  ) throw new Error("fresh_clone_missing_materialization_not_detected");
  const restored = await invokeFixture("toolchain_restore");
  if (restored.status !== "completed" || restored.authority?.state !== "ready") {
    throw new Error(`fresh_clone_offline_restore_failed: ${restored.status}`);
  }
  const restoredVersion = await invokeFixture("project_version");
  if (
    restoredVersion.status !== "completed"
    || restoredVersion.authority?.source !== "project_toolchain"
  ) throw new Error("restored_project_engine_delegation_failed");
  assertEqual(
    await readFile(path.join(activeRepository, ".launchrally", "manifest.yaml"), "utf8"),
    manifestContent,
    "fresh_clone_manifest_drift",
    "clean and restore must preserve the project Manifest byte-for-byte",
  );

  const planRefresh = await invokeFixture("plan_refresh", {
    "{current_report_path}": reportPath,
  });
  if (planRefresh.status !== "needs_refresh") {
    throw new Error("installation_journey_stale_plan_not_detected");
  }
  const refreshPermission = await invokeFixture("refresh_permission", {
    "{manifest_source_report_path}": reportPath,
  });
  const refreshed = await invokeFixture("refresh_completed", {
    "{refresh_resume}": refreshPermission.interaction.resume_token,
    "{permissions_json}": permissions,
  });
  if (refreshed.status !== "completed") {
    throw new Error("installation_journey_refresh_failed");
  }
  const currentReportPath = path.join(temporaryRoot, "installation-journey-current.json");
  await writeFile(currentReportPath, JSON.stringify(refreshed));
  const plan = await invokeFixture("plan", {
    "{current_report_path}": currentReportPath,
  });
  const handoff = await invokeFixture("handoff", {
    "{current_report_path}": currentReportPath,
  });
  if (plan.status !== "completed" || handoff.status !== "completed") {
    throw new Error("installation_journey_plan_handoff_failed");
  }
  const verifyPermission = await invokeFixture("verify_permission", {
    "{manifest_source_report_path}": reportPath,
  });
  const verified = await invokeFixture("verify_completed", {
    "{verify_resume}": verifyPermission.interaction.resume_token,
    "{permissions_json}": permissions,
  });
  if (verified.status !== "completed" || !verified.report) {
    throw new Error("installation_journey_full_verify_failed");
  }

  const verifiedRepository = activeRepository;
  const immutableHistoryBeforeMigration = await Promise.all([
    snapshotTree(path.join(verifiedRepository, ".launchrally", "reports")),
    snapshotTree(path.join(verifiedRepository, ".launchrally", "evidence")),
  ]);
  const legacyRepository = path.join(temporaryRoot, "legacy 0.2.2 project");
  await cp(verifiedRepository, legacyRepository, { recursive: true });
  const legacyToolchain = path.join(legacyRepository, ".launchrally", "toolchain");
  await Promise.all([
    writeFile(
      path.join(legacyToolchain, "package.json"),
      `${JSON.stringify(exactToolchainPackage("0.2.2"), null, 2)}\n`,
    ),
    writeFile(
      path.join(legacyToolchain, "package-lock.json"),
      `${JSON.stringify(exactToolchainLock("0.2.2"), null, 2)}\n`,
    ),
    rm(path.join(legacyToolchain, "authority.json"), { force: true }),
    rm(path.join(legacyToolchain, "node_modules"), { recursive: true, force: true }),
  ]);
  const publicLegacyToolchain = publicLegacy
    ? await installPublicLegacyToolchain(temporaryRoot)
    : null;
  const legacyNpmStub = await createArtifactNpmStub(
    temporaryRoot,
    cleanProject,
    "0.2.2",
    {
      launcherVersion: version,
      legacyLayout: !publicLegacy,
      preparedToolchain: publicLegacyToolchain,
    },
  );
  const legacyEnvironment = {
    ...launcherEnvironment,
    PATH: [legacyNpmStub, path.dirname(launcher), process.env.PATH ?? ""].join(path.delimiter),
  };
  activeRepository = legacyRepository;
  const legacyRestored = await invoke("toolchain_restore", {}, {
    environment: legacyEnvironment,
  });
  if (
    legacyRestored.status !== "completed"
    || legacyRestored.authority?.engine?.version !== "0.2.2"
    || legacyRestored.authority?.engine?.compatibility !== "legacy_adapter"
  ) throw new Error(`artifact_legacy_restore_failed: ${JSON.stringify(legacyRestored)}`);
  const legacyVersion = await invoke("project_version", {}, {
    environment: legacyEnvironment,
    validate: false,
  });
  if (
    legacyVersion.status !== "completed"
    || legacyVersion.cli_version !== "0.2.2"
    || (!publicLegacy && legacyVersion.authority?.source !== "project_toolchain")
  ) throw new Error(`artifact_legacy_delegation_failed: ${JSON.stringify(legacyVersion)}`);

  const upgradePreview = await invoke("toolchain_migrate", {
    "{target_engine_version}": version,
  }, { environment: launcherEnvironment });
  if (upgradePreview.status !== "needs_confirmation") {
    throw new Error(`artifact_upgrade_preview_failed: ${JSON.stringify(upgradePreview)}`);
  }
  const upgraded = await invoke("toolchain_migrate_confirmation", {
    "{target_engine_version}": version,
    "{toolchain_resume}": upgradePreview.interaction.resume_token,
  }, { environment: launcherEnvironment });
  if (
    upgraded.status !== "completed"
    || upgraded.authority?.engine?.version !== version
    || upgraded.next_action?.reason !== "execution_authority_changed"
  ) throw new Error(`artifact_legacy_upgrade_failed: ${JSON.stringify(upgraded)}`);
  const currentPointerPath = path.join(
    activeRepository,
    ".launchrally",
    "cache",
    "current-report.json",
  );
  const upgradePointer = await json(currentPointerPath);
  if (
    upgradePointer.currentness?.status !== "non_current"
    || !upgradePointer.currentness.reasons?.some(
      ({ reason_code: reasonCode }) => reasonCode === "execution_authority_changed",
    )
  ) throw new Error("artifact_upgrade_did_not_invalidate_report_currentness");
  assertEqual(
    await Promise.all([
      snapshotTree(path.join(activeRepository, ".launchrally", "reports")),
      snapshotTree(path.join(activeRepository, ".launchrally", "evidence")),
    ]),
    immutableHistoryBeforeMigration,
    "artifact_upgrade_mutated_history",
    "upgrade must preserve every immutable Report and Evidence byte",
  );

  const downgradePreview = await invoke("toolchain_migrate", {
    "{target_engine_version}": "0.2.2",
  }, { environment: legacyEnvironment });
  if (downgradePreview.status !== "needs_confirmation") {
    throw new Error(`artifact_downgrade_preview_failed: ${JSON.stringify(downgradePreview)}`);
  }
  const downgraded = await invoke("toolchain_migrate_confirmation", {
    "{target_engine_version}": "0.2.2",
    "{toolchain_resume}": downgradePreview.interaction.resume_token,
  }, { environment: legacyEnvironment });
  if (
    downgraded.status !== "completed"
    || downgraded.authority?.engine?.version !== "0.2.2"
    || downgraded.authority?.engine?.compatibility !== "legacy_adapter"
  ) throw new Error(`artifact_downgrade_failed: ${JSON.stringify(downgraded)}`);
  assertEqual(
    await readFile(path.join(activeRepository, ".launchrally", "manifest.yaml"), "utf8"),
    manifestContent,
    "artifact_migration_manifest_drift",
    "upgrade and downgrade must preserve the Manifest byte-for-byte",
  );
  assertEqual(
    await Promise.all([
      snapshotTree(path.join(activeRepository, ".launchrally", "reports")),
      snapshotTree(path.join(activeRepository, ".launchrally", "evidence")),
    ]),
    immutableHistoryBeforeMigration,
    "artifact_downgrade_mutated_history",
    "downgrade must preserve every immutable Report and Evidence byte",
  );

  const invalidAuthorityCases = [];
  const assertInvalidAuthority = async ({ name, mutate, status = "execution_error" }) => {
    const repositoryCopy = path.join(temporaryRoot, `invalid authority ${name}`);
    await cp(verifiedRepository, repositoryCopy, { recursive: true });
    activeRepository = repositoryCopy;
    await mutate(repositoryCopy);
    const execution = await invoke("plan", {
      "{current_report_path}": currentReportPath,
    }, { includeExitCode: true, validate: false });
    if (
      execution.exitCode === 0
      || execution.result.status !== status
      || execution.result.authority?.source !== "project_toolchain"
    ) throw new Error(
      `artifact_${name}_did_not_fail_closed: ${JSON.stringify(execution)}`,
    );
    assertEqual(
      await readFile(path.join(repositoryCopy, ".launchrally", "manifest.yaml"), "utf8"),
      manifestContent,
      `artifact_${name}_mutated_manifest`,
      "invalid or unavailable project authority must not mutate the Manifest",
    );
    invalidAuthorityCases.push(name);
  };

  await assertInvalidAuthority({
    name: "corrupted_lock",
    mutate: (repositoryCopy) => writeFile(
      path.join(repositoryCopy, ".launchrally", "toolchain", "package-lock.json"),
      "{}\n",
    ),
  });
  await assertInvalidAuthority({
    name: "unsupported_contract",
    status: "unavailable",
    mutate: async (repositoryCopy) => {
      const descriptorPath = path.join(
        repositoryCopy,
        ".launchrally",
        "toolchain",
        "authority.json",
      );
      const descriptor = await json(descriptorPath);
      descriptor.contract = "launchrally.dev/execution-authority/v999";
      await writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`);
    },
  });
  await assertInvalidAuthority({
    name: "descriptor_path_escape",
    mutate: async (repositoryCopy) => {
      const descriptorPath = path.join(
        repositoryCopy,
        ".launchrally",
        "toolchain",
        "authority.json",
      );
      const descriptor = await json(descriptorPath);
      descriptor.engine.entrypoint = "../../../../outside.js";
      await writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`);
    },
  });
  if (process.platform !== "win32") {
    await assertInvalidAuthority({
      name: "symlinked_engine_escape",
      mutate: async (repositoryCopy) => {
        const enginePath = path.join(
          repositoryCopy,
          ".launchrally",
          "toolchain",
          "node_modules",
          "@launchrally",
          "cli",
        );
        const outsideEngine = path.join(temporaryRoot, "outside symlinked engine");
        await cp(enginePath, outsideEngine, { recursive: true });
        await rm(enginePath, { recursive: true });
        await symlink(outsideEngine, enginePath, "dir");
      },
    });
  }
  await assertInvalidAuthority({
    name: "wrong_installed_version",
    mutate: async (repositoryCopy) => {
      const packagePath = path.join(
        repositoryCopy,
        ".launchrally",
        "toolchain",
        "node_modules",
        "@launchrally",
        "cli",
        "package.json",
      );
      const installedPackage = await json(packagePath);
      installedPackage.version = "9.9.9";
      await writeFile(packagePath, `${JSON.stringify(installedPackage)}\n`);
    },
  });
  await assertInvalidAuthority({
    name: "missing_materialization",
    status: "unavailable",
    mutate: (repositoryCopy) => rm(
      path.join(repositoryCopy, ".launchrally", "toolchain", "node_modules"),
      { recursive: true, force: true },
    ),
  });

  const migrationRepository = path.join(temporaryRoot, "failed downgrade rollback");
  await cp(verifiedRepository, migrationRepository, { recursive: true });
  activeRepository = migrationRepository;
  const authoritativePaths = [
    "manifest.yaml",
    "toolchain/package.json",
    "toolchain/package-lock.json",
    "toolchain/authority.json",
  ];
  const beforeMigration = await Promise.all(authoritativePaths.map((relativePath) => (
    readFile(path.join(activeRepository, ".launchrally", relativePath), "utf8")
  )));
  const failedMigration = await invoke("toolchain_migrate", {
    "{target_engine_version}": "0.2.2",
  }, { includeExitCode: true, validate: false });
  if (failedMigration.exitCode === 0 || failedMigration.result.status !== "execution_error") {
    throw new Error("artifact_failed_downgrade_did_not_stop");
  }
  assertEqual(
    await Promise.all(authoritativePaths.map((relativePath) => (
      readFile(path.join(activeRepository, ".launchrally", relativePath), "utf8")
    ))),
    beforeMigration,
    "artifact_failed_downgrade_authority_drift",
    "a failed downgrade must roll back every authoritative file",
  );
  await access(path.join(activeRepository, ".launchrally", "reports"));
  await access(path.join(activeRepository, ".launchrally", "evidence"));

  const recoveryRepository = path.join(temporaryRoot, "interrupted migration recovery");
  await cp(verifiedRepository, recoveryRepository, { recursive: true });
  const recoveryTransaction = path.join(
    recoveryRepository,
    ".launchrally",
    ".toolchain-transaction",
  );
  await mkdir(recoveryTransaction);
  await cp(legacyToolchain, path.join(recoveryTransaction, "old"), { recursive: true });
  await writeFile(
    path.join(recoveryTransaction, "transaction.json"),
    `${JSON.stringify({
      schema_version: "launchrally.dev/toolchain-transaction/v1",
      phase: "prepared",
      operation: "migrate",
      had_previous: true,
      previous_version: "0.2.2",
      version,
    })}\n`,
  );
  activeRepository = recoveryRepository;
  const recoveredMigration = await invoke("toolchain_restore");
  if (
    recoveredMigration.status !== "completed"
    || recoveredMigration.outcome !== "already_ready"
    || recoveredMigration.authority?.engine?.version !== version
  ) throw new Error(`artifact_migration_recovery_failed: ${JSON.stringify(recoveredMigration)}`);
  await assertMissing(recoveryTransaction, "artifact_migration_transaction_not_cleaned");
  const recoveryPointer = await json(path.join(
    recoveryRepository,
    ".launchrally",
    "cache",
    "current-report.json",
  ));
  if (
    recoveryPointer.currentness?.status !== "non_current"
    || !recoveryPointer.currentness.reasons?.some(
      ({ reason_code: reasonCode }) => reasonCode === "execution_authority_changed",
    )
  ) throw new Error("artifact_recovery_did_not_invalidate_report_currentness");
  assertEqual(
    await Promise.all([
      snapshotTree(path.join(recoveryRepository, ".launchrally", "reports")),
      snapshotTree(path.join(recoveryRepository, ".launchrally", "evidence")),
    ]),
    immutableHistoryBeforeMigration,
    "artifact_recovery_mutated_history",
    "interruption recovery must preserve every immutable Report and Evidence byte",
  );
  activeRepository = verifiedRepository;

  const projectData = path.join(activeRepository, ".launchrally");
  await access(path.join(projectData, "manifest.yaml"));
  assertEqual(
    await snapshotTree(prefix),
    installedPrefixSnapshot,
    "packed_adapter_unauthorized_install",
    "Installed Host journeys must not change the explicit user prefix",
  );
  effectObservations.file_boundaries.push({
    boundary: "installed_user_prefix",
    preserved: true,
  });
  assertEqual(
    await snapshotTree(cleanProject, "", new Set(["node_modules"])),
    installedAdapterProjectSnapshot,
    "packed_adapter_unauthorized_write",
    "Installed Host journeys must not mutate their installation project",
  );
  effectObservations.file_boundaries.push({
    boundary: "installed_adapter_project",
    preserved: true,
  });
  await runAuthorizedNpm([
    "uninstall",
    "--global",
    "--prefix",
    prefix,
    "--ignore-scripts",
    "@launchrally/cli",
  ], { cwd: temporaryRoot }, "explicit_user_prefix_uninstall");
  await assertMissing(launcher, "launcher_removal_failed");
  await access(path.join(projectData, "manifest.yaml"));
  await access(path.join(projectData, "toolchain", "authority.json"));

  assertEqual(
    [...p1IntegrationFamilies].sort(),
    [...P1_INTEGRATION_FAMILIES],
    "p1_integration_matrix_incomplete",
    "Every reviewed Integration family must execute through both packed Host adapters",
  );
  assertEqual(
    integrationFreshVerify,
    Object.fromEntries(P1_INTEGRATION_FAMILIES.map((family) => [
      family,
      "environment_bound_fresh_evidence",
    ])),
    "p1_integration_fresh_verify_incomplete",
    "Every reviewed Integration family must complete its exact fresh Verify request",
  );
  assertEqual(
    [...p1HostJourneys].sort(),
    ["claude", "codex"],
    "p1_host_matrix_incomplete",
    "Both packed Host adapters must execute typed journeys",
  );
  assertEqual(
    [...p1Scenarios].sort(),
    [...P1_SCENARIOS],
    "p1_scenario_matrix_incomplete",
    "Every P1 exact-artifact boundary must be observed",
  );
  if (
    !receiptClaimsRequireVerification
    || (process.platform !== "win32"
      && (!successfulDownstreamEvidence || !unsuccessfulDownstreamEvidence))
  ) throw new Error("p1_fresh_verify_matrix_incomplete");

  const sensitivePattern = /packaged-host-secret|bearer\s|"cookie"\s*:|"headers"\s*:/iu;
  const persistedProjectOutput = JSON.stringify(await snapshotTree(projectData));
  const persistedSensitiveValue = effectObservations.normalized_outputs.some((output) =>
    sensitivePattern.test(output)) || sensitivePattern.test(persistedProjectOutput);
  if (
    effectObservations.package_manager.length < 4
    || effectObservations.file_boundaries.length < 4
    || effectObservations.normalized_outputs.length === 0
    || effectObservations.guarded_process_sections < 3
    || (process.platform !== "win32"
      && effectObservations.authenticated_network.length !== 8)
  ) throw new Error("p1_clean_host_observation_incomplete");
  const cleanHost = {
    unauthorized_install: effectObservations.package_manager.some(
      ({ authorized }) => authorized !== true,
    ) || effectObservations.denied_process_effects.some(
      ({ effect }) => effect === "process_execution",
    ),
    unauthorized_login: effectObservations.authenticated_network.some(
      ({ effect }) => effect !== "authenticated_network_read",
    ),
    unauthorized_upload: effectObservations.denied_process_effects.some(
      ({ effect }) => effect === "network_access",
    ) || effectObservations.authenticated_network.some(
      ({ method, destination }) => method !== "GET" || destination !== "loopback_fixture",
    ),
    unauthorized_write: effectObservations.denied_process_effects.some(
      ({ effect }) => effect === "filesystem_write",
    ) || effectObservations.file_boundaries.some(
      ({ preserved }) => preserved !== true,
    ),
    manual_secret_transfer: effectObservations.authenticated_network.some(
      ({ authentication_source: source }) => source !== "owner_private_reference",
    ),
    sensitive_persistence: persistedSensitiveValue,
  };
  if (Object.values(cleanHost).some(Boolean)) {
    throw new Error(`p1_clean_host_effect_boundary_failed:${JSON.stringify(cleanHost)}`);
  }

  return {
    projectData,
    p1Evidence: {
      integrationFamilies: [...p1IntegrationFamilies].sort(),
      integrationFreshVerify,
      hostJourneys: [...p1HostJourneys].sort(),
      p0ToP1Migration: {
        adoption: "completed",
        interruption: "rolled_back_and_recovered",
      },
      cleanHost,
      scenarios: [...p1Scenarios].sort(),
      receiptClaimsRequireVerification,
      successfulDownstreamEvidence,
      unsuccessfulDownstreamEvidence,
    },
    result: {
      no_launcher: "confirmed",
      npm_exec: publicRelease
        ? "exact_version_audit_and_follow_up"
        : "artifact_equivalent_audit_and_follow_up",
      user_prefix: "installed_and_verified",
      project_engine: "initialized_and_delegated",
      fresh_clone: "restored_offline",
      registry_permission: "cache_miss_approved_and_denied",
      invalid_authority: "corruption_failed_closed",
      invalid_authority_cases: invalidAuthorityCases.sort(),
      migration_failure: "pre_adoption_failure_preserved_authority",
      legacy_toolchain: publicLegacy
        ? "public_0.2.2_restored_and_delegated"
        : "compatibility_fixture_restored_and_delegated",
      migration_success: "downgrade_and_upgrade_preserved_immutable_history",
      transaction_recovery: "interrupted_migration_recovered",
      full_journey: "plan_handoff_verify_completed",
      packaged_skill_fixtures: "codex_and_claude_executed",
      protected_journeys: "codex_and_claude_audit_verify_normalized",
      human_authenticated_journey: process.platform === "win32"
        ? "typed_runner_unavailable_restricted_file_boundary"
        : "normalized_success_without_sensitive_persistence",
      launcher_removal: "project_data_preserved",
      fixture_invocations: fixtureInvocations,
    },
  };
}

async function smokeCli(
  temporaryRoot,
  installArguments,
  version,
  releasePackages,
  { verifyProvenance = false } = {},
) {
  const cleanProject = path.join(temporaryRoot, "clean-install");
  await mkdir(cleanProject, { recursive: true });
  await writeFile(
    path.join(cleanProject, "package.json"),
    '{"name":"launchrally-release-smoke","private":true}\n',
  );
  await runNpm(installArguments, { cwd: cleanProject });
  assertNoConsumerInstallScripts(await json(path.join(cleanProject, "package-lock.json")));

  const promptPackage = await json(path.join(
    cleanProject,
    "node_modules",
    "@clack",
    "prompts",
    "package.json",
  ));
  if (promptPackage.name !== "@clack/prompts" || promptPackage.version !== "1.7.0") {
    throw new Error(
      `consumer_ui_dependency_drift: @clack/prompts installed as ${promptPackage.name}@${promptPackage.version}`,
    );
  }

  if (verifyProvenance) {
    const { stdout } = await runNpm([
      "audit",
      "signatures",
      "--json",
      "--include-attestations",
      "--cache",
      path.join(temporaryRoot, "npm-signature-cache"),
    ], { cwd: cleanProject });
    const signatureAudit = JSON.parse(stdout);
    for (const artifact of releasePackages) {
      const verified = signatureAudit.verified?.find(({ name, version: auditedVersion }) => (
        name === artifact.name && auditedVersion === version
      ));
      if (
        verified?.attestations?.provenance === undefined
        || !verified.attestationBundles?.some(({ predicateType }) => (
          typeof predicateType === "string" && predicateType.startsWith("https://slsa.dev/provenance/")
        ))
      ) {
        throw new Error(
          `public_provenance_missing: ${artifact.name}@${version} has no verified provenance attestation`,
        );
      }
    }
  }

  for (const artifact of releasePackages) {
    const installedPackageRoot = path.join(
      cleanProject,
      "node_modules",
      ...artifact.name.split("/"),
    );
    const installed = await json(path.join(installedPackageRoot, "package.json"));
    const source = await json(path.join(root, artifact.path, "package.json"));
    if (installed.name !== artifact.name || installed.version !== version) {
      throw new Error(
        `public_artifact_version_drift: ${artifact.name} installed as ${installed.name}@${installed.version}`,
      );
    }
    assertEqual(
      installed.keywords,
      source.keywords,
      "artifact_keyword_drift",
      `${artifact.name} packed keywords differ from its source manifest`,
    );
    assertEqual(
      await readFile(path.join(installedPackageRoot, "README.md"), "utf8"),
      await readFile(path.join(root, artifact.path, "README.md"), "utf8"),
      "artifact_readme_drift",
      `${artifact.name} packed README differs from its source README`,
    );
  }

  const rally = path.join(
    cleanProject,
    "node_modules",
    "@launchrally",
    "cli",
    "bin",
    "rally.js",
  );
  const humanVerifyModule = path.join(
    cleanProject,
    "node_modules",
    "@launchrally",
    "cli",
    "bin",
    "human-verify.js",
  );
  const invokeRally = (arguments_, options = {}) => run(
    process.execPath,
    [rally, ...arguments_],
    options,
  );
  const renderPackedHumanVerify = async (result, cwd, environment) => (await run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        "import { pathToFileURL } from 'node:url';",
        "const { renderHumanVerify } = await import(pathToFileURL(process.env.LAUNCHRALLY_TEST_HUMAN_VERIFY_MODULE));",
        "const result = JSON.parse(process.env.LAUNCHRALLY_TEST_VERIFY_RESULT);",
        "const invocationContext = JSON.parse(process.env.LAUNCHRALLY_TEST_INVOCATION_CONTEXT);",
        "process.stdout.write(renderHumanVerify(result, { cwd: process.env.LAUNCHRALLY_TEST_CWD, invocationContext, styled: false }));",
      ].join("\n"),
    ],
    {
      cwd: cleanProject,
      env: {
        ...environment,
        LAUNCHRALLY_TEST_HUMAN_VERIFY_MODULE: humanVerifyModule,
        LAUNCHRALLY_TEST_VERIFY_RESULT: JSON.stringify(result),
        LAUNCHRALLY_TEST_INVOCATION_CONTEXT: JSON.stringify({
          schema_version: "launchrally.dev/invocation-context/v1",
          source: "user_path",
          launcher_version: version,
        }),
        LAUNCHRALLY_TEST_CWD: cwd,
      },
    },
  )).stdout;
  const versionResult = JSON.parse((await invokeRally(["--version", "--json"], {
    cwd: cleanProject,
  })).stdout);
  if (versionResult.cli_version !== version || versionResult.operation !== "version") {
    throw new Error("cli_artifact_version_drift: installed CLI reported a different release");
  }

  const auditProject = path.join(temporaryRoot, "first-audit");
  await mkdir(auditProject, { recursive: true });
  await writeFile(
    path.join(auditProject, "package.json"),
    '{"name":"first-audit","scripts":{"build":"node build.js"}}\n',
  );
  await writeFile(
    path.join(auditProject, "package-lock.json"),
    '{"name":"first-audit","lockfileVersion":3,"packages":{"":{}}}\n',
  );
  const audit = JSON.parse((await invokeRally(
    ["audit", "--json", "--cwd", auditProject],
    { cwd: cleanProject },
  )).stdout);
  if (audit.status !== "needs_input") {
    throw new Error(`cli_artifact_smoke_failed: first Audit returned ${audit.status}`);
  }

  const auditConfirmation = JSON.parse((await invokeRally([
    "audit", "--json", "--cwd", auditProject,
    "--resume", audit.interaction.resume_token,
    "--answers", JSON.stringify({
      intended_environment: "production",
      production_targets: ["https://example.com"],
      core_journeys: [{ method: "GET", path: "/", purpose: "homepage loads" }],
      provider_roles: [{ provider: "clerk", role: "authentication" }],
      support_layers: [],
    }),
  ], { cwd: cleanProject })).stdout);
  const auditPermission = JSON.parse((await invokeRally([
    "audit", "--json", "--cwd", auditProject,
    "--resume", auditConfirmation.interaction.resume_token,
    "--confirm", "confirm",
  ], { cwd: cleanProject })).stdout);
  const missingProviderPath = path.join(temporaryRoot, "missing-provider-path");
  await mkdir(missingProviderPath);
  const recoveryReport = JSON.parse((await invokeRally([
    "audit", "--json", "--cwd", auditProject,
    "--resume", auditPermission.interaction.resume_token,
    "--permissions", JSON.stringify({
      public_verification: "denied",
      "provider_read:clerk": "approved",
    }),
  ], {
    cwd: cleanProject,
    env: { ...process.env, PATH: missingProviderPath },
  })).stdout);
  const recovery = recoveryReport.report?.results?.provider_tool_recoveries?.[0];
  if (recovery?.provider !== "clerk") {
    throw new Error("packed_provider_recovery_report_missing: Audit did not emit Clerk recovery");
  }
  const recoveryReportPath = path.join(temporaryRoot, "provider-recovery-report.json");
  await writeFile(recoveryReportPath, JSON.stringify(recoveryReport));
  const instructions = JSON.parse((await invokeRally([
    "providers",
    "--json",
    "--report",
    recoveryReportPath,
    "--recover",
    "clerk",
    "--choice",
    "show_install_instructions",
  ], { cwd: cleanProject })).stdout);
  assertEqual(
    instructions.recovery?.installation_instructions?.[0]?.command,
    {
      executable: "npm",
      arguments: ["install", "--global", "clerk@3.1.0"],
      shell: false,
    },
    "packed_provider_recovery_instruction_drift",
    "packed CLI must render the reviewed exact-version instruction",
  );

  const providerStub = path.join(temporaryRoot, "provider-recovery-bin");
  const providerCalls = path.join(temporaryRoot, "provider-recovery-calls.jsonl");
  const packageManagerCalls = path.join(temporaryRoot, "provider-recovery-npm-calls.jsonl");
  const recoveryWatch = path.join(temporaryRoot, "provider-recovery-watch");
  const recoveryCredentialSentinel = path.join(recoveryWatch, "credentials-do-not-touch");
  const credentialReadCalls = path.join(temporaryRoot, "provider-recovery-credential-reads.jsonl");
  const credentialReadGuard = path.join(temporaryRoot, "deny-credential-reads.cjs");
  const networkGuard = path.join(temporaryRoot, "deny-network.cjs");
  await cp(path.join(root, "fixtures", "coverage", "deny-network.cjs"), networkGuard);
  await writeFile(credentialReadGuard, [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "const guardedRoots = JSON.parse(process.env.PROVIDER_RECOVERY_CREDENTIAL_ROOTS).map((value) => path.resolve(value));",
    "const logPath = process.env.PROVIDER_RECOVERY_CREDENTIAL_READS;",
    "function guard(value) {",
    "  if (typeof value !== \"string\" && !Buffer.isBuffer(value) && !(value instanceof URL)) return;",
    "  const candidate = path.resolve(value instanceof URL ? value.pathname : value.toString());",
    "  if (!guardedRoots.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`))) return;",
    "  fs.appendFileSync(logPath, `${JSON.stringify(candidate)}\\n`);",
    "  const error = new Error(\"Provider recovery attempted to read credential state.\");",
    "  error.code = \"credential_read_forbidden\";",
    "  throw error;",
    "}",
    "for (const method of [\"readFileSync\", \"openSync\", \"accessSync\", \"statSync\", \"lstatSync\", \"readdirSync\"]) {",
    "  const original = fs[method];",
    "  fs[method] = function guardedCredentialRead(value, ...rest) { guard(value); return original.call(this, value, ...rest); };",
    "}",
    "for (const method of [\"readFile\", \"open\", \"access\", \"stat\", \"lstat\", \"readdir\"]) {",
    "  const original = fs.promises[method];",
    "  fs.promises[method] = async function guardedCredentialRead(value, ...rest) { guard(value); return original.call(this, value, ...rest); };",
    "}",
  ].join("\n"));
  await mkdir(providerStub);
  await mkdir(recoveryWatch);
  await writeFile(recoveryCredentialSentinel, "unchanged\n");
  const providerScript = path.join(providerStub, "clerk-stub.cjs");
  await writeFile(providerScript, [
    'const fs = require("node:fs");',
    "fs.appendFileSync(process.env.PROVIDER_RECOVERY_CALLS, JSON.stringify(process.argv.slice(2)) + \"\\n\");",
    'process.stdout.write("3.1.0\\n");',
  ].join("\n"));
  if (process.platform === "win32") {
    await writeFile(
      path.join(providerStub, "clerk.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0clerk-stub.cjs" %*\r\n`,
    );
    await writeFile(
      path.join(providerStub, "npm.cmd"),
      `@echo off\r\necho npm>>"${packageManagerCalls}"\r\nexit /b 99\r\n`,
    );
  } else {
    const providerExecutable = path.join(providerStub, "clerk");
    await writeFile(providerExecutable, `#!/usr/bin/env node\n${await readFile(providerScript, "utf8")}\n`);
    await chmod(providerExecutable, 0o755);
    const npmExecutable = path.join(providerStub, "npm");
    await writeFile(npmExecutable, `#!/bin/sh\nprintf 'npm\\n' >> '${packageManagerCalls}'\nexit 99\n`);
    await chmod(npmExecutable, 0o755);
  }
  const watchedEntriesBefore = await readdir(recoveryWatch);
  const rediscovered = JSON.parse((await invokeRally([
    "providers",
    "--json",
    "--report",
    recoveryReportPath,
    "--recover",
    "clerk",
    "--choice",
    "rediscover_executable",
  ], {
    cwd: cleanProject,
    env: {
      ...process.env,
      PATH: `${providerStub}${path.delimiter}${process.env.PATH ?? ""}`,
      PROVIDER_RECOVERY_CALLS: providerCalls,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${networkGuard} --require=${credentialReadGuard}`.trim(),
      XDG_CONFIG_HOME: recoveryWatch,
      PROVIDER_RECOVERY_CREDENTIAL_ROOTS: JSON.stringify([
        recoveryWatch,
        ...[process.env.HOME, process.env.USERPROFILE].filter(Boolean).flatMap((profile) => [
          path.join(profile, ".config"),
          path.join(profile, ".clerk"),
          path.join(profile, ".sentryclirc"),
          path.join(profile, ".npmrc"),
          path.join(profile, "Library", "Application Support", "Clerk"),
          path.join(profile, "Library", "Keychains"),
          path.join(profile, "AppData", "Roaming", "Clerk"),
        ]),
      ]),
      PROVIDER_RECOVERY_CREDENTIAL_READS: credentialReadCalls,
    },
  })).stdout);
  assertEqual(
    (await readFile(providerCalls, "utf8")).trim().split("\n").map(JSON.parse),
    [["--version"]],
    "packed_provider_recovery_silent_effect",
    "packed recovery may execute only the structured version verification command",
  );
  await access(packageManagerCalls).then(
    () => { throw new Error("packed_provider_recovery_silent_install: recovery invoked npm"); },
    (error) => {
      if (error?.code !== "ENOENT") throw error;
    },
  );
  await access(credentialReadCalls).then(
    () => { throw new Error("packed_provider_recovery_credential_read: recovery read credential state"); },
    (error) => {
      if (error?.code !== "ENOENT") throw error;
    },
  );
  assertEqual(
    await readdir(recoveryWatch),
    watchedEntriesBefore,
    "packed_provider_recovery_filesystem_effect",
    "packed recovery must not create credential or configuration files",
  );
  if (await readFile(recoveryCredentialSentinel, "utf8") !== "unchanged\n") {
    throw new Error("packed_provider_recovery_credential_effect: recovery changed credential state");
  }
  if (
    rediscovered.outcome !== "ready_for_fresh_permission"
    || rediscovered.request?.permission?.decision !== "pending"
    || rediscovered.request?.permission?.previous_approval_reused !== false
  ) {
    throw new Error("packed_provider_recovery_permission_drift: rediscovery must require a fresh read");
  }

  const matrix = await json(path.join(root, "fixtures", "coverage", "matrix.json"));
  const npmStub = await createArtifactNpmStub(
    temporaryRoot,
    cleanProject,
    version,
  );
  const coverageEnvironment = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${networkGuard}`.trim(),
    PATH: `${npmStub}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const coverageJourneys = [];
  for (const representative of matrix.fixtures) {
    const repository = path.join(temporaryRoot, "coverage", representative.id);
    await cp(
      path.join(root, "fixtures", "coverage", representative.path),
      repository,
      { recursive: true },
    );
    const invoke = async (arguments_) => {
      try {
        return JSON.parse((await invokeRally(
          arguments_,
          { cwd: cleanProject, env: coverageEnvironment },
        )).stdout);
      } catch (error) {
        error.message += `\nstdout:\n${error.stdout ?? ""}\nstderr:\n${error.stderr ?? ""}`;
        throw error;
      }
    };
    const input = await invoke(["audit", "--json", "--cwd", repository]);
    const confirmation = await invoke([
      "audit", "--json", "--cwd", repository,
      "--resume", input.interaction.resume_token,
      "--answers", JSON.stringify({
        intended_environment: "production",
        production_targets: [representative.production_target],
        core_journeys: [{ method: "GET", path: "/", purpose: "coverage smoke" }],
        provider_roles: representative.provider_roles ?? [],
        support_layers: [],
      }),
    ]);
    const permission = await invoke([
      "audit", "--json", "--cwd", repository,
      "--resume", confirmation.interaction.resume_token,
      "--confirm", "confirm",
    ]);
    const completed = await invoke([
      "audit", "--json", "--cwd", repository,
      "--resume", permission.interaction.resume_token,
      "--permissions", JSON.stringify({
        public_verification: "denied",
        ...Object.fromEntries((representative.provider_roles ?? []).map(({ provider }) => [
          `provider_read:${provider}`,
          "denied",
        ])),
      }),
    ]);
    if (
      completed.status !== "completed"
      || completed.operation !== "audit"
      || !completed.report
      || completed.report.assessment === "launch_ready"
    ) {
      throw new Error(`coverage_artifact_journey_failed: ${representative.id}`);
    }
    const reports = path.join(temporaryRoot, "coverage-reports");
    await mkdir(reports, { recursive: true });
    const auditPath = path.join(reports, `${representative.id}-audit.json`);
    await writeFile(auditPath, JSON.stringify(completed));
    const initPreview = await invoke([
      "init", "--json", "--cwd", repository, "--report", auditPath,
    ]);
    if (initPreview.status !== "needs_confirmation") {
      throw new Error(`coverage_artifact_init_preview_failed: ${representative.id}`);
    }
    const initialized = await invoke([
      "init", "--json", "--cwd", repository,
      "--resume", initPreview.interaction.resume_token,
      "--confirm", "confirm",
    ]);
    if (initialized.status !== "completed") {
      throw new Error(`coverage_artifact_init_failed: ${representative.id}`);
    }
    const stalePlan = await invoke([
      "plan", "--json", "--cwd", repository, "--report", auditPath,
    ]);
    if (stalePlan.status !== "needs_refresh") {
      throw new Error(`coverage_artifact_stale_plan_failed: ${representative.id}`);
    }
    const refreshPermission = await invoke([
      "verify", "--json", "--cwd", repository, "--report", auditPath, "--scope", "full",
    ]);
    const refreshed = await invoke([
      "verify", "--json", "--cwd", repository,
      "--resume", refreshPermission.interaction.resume_token,
      "--permissions", JSON.stringify({
        public_verification: "denied",
        ...Object.fromEntries((representative.provider_roles ?? []).map(({ provider }) => [
          `provider_read:${provider}`,
          "denied",
        ])),
      }),
    ]);
    const refreshedHuman = await renderPackedHumanVerify(
      refreshed,
      repository,
      coverageEnvironment,
    );
    const escapedSourceId = completed.report.report_id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const currentReportPath = refreshedHuman.match(
      /^Current Report input\n(\.launchrally\/reports\/[^\n]+\/record\.json)$/mu,
    )?.[1];
    if (
      !new RegExp(`^Manifest Source Report\\n${escapedSourceId}$`, "mu").test(refreshedHuman)
      || !/^Current Report\n.+$/mu.test(refreshedHuman)
      || !/^Failed Checks \(\d+\)$/mu.test(refreshedHuman)
      || !/^Verification Gaps \(\d+\)$/mu.test(refreshedHuman)
      || !currentReportPath
      || !/^Next command\n.+\bplan\b.+--report\b/mu.test(refreshedHuman)
    ) {
      throw new Error(`coverage_artifact_refresh_failed: ${representative.id}`);
    }
    const plan = await invoke([
      "plan", "--json", "--cwd", repository, "--report", currentReportPath,
    ]);
    const handoff = await invoke([
      "plan", "--json", "--cwd", repository, "--report", currentReportPath, "--handoff",
    ]);
    if (plan.status !== "completed" || handoff.status !== "completed") {
      throw new Error(`coverage_artifact_plan_failed: ${representative.id}`);
    }
    await writeFile(
      path.join(repository, ".env.example"),
      "LAUNCHRALLY_REMEDIATION_CHECK=1\n",
      { flag: "a" },
    );
    const verifyPermission = await invoke([
      "verify", "--json", "--cwd", repository,
      "--report", auditPath,
      "--scope", "full",
    ]);
    const verified = await invoke([
      "verify", "--json", "--cwd", repository,
      "--resume", verifyPermission.interaction.resume_token,
      "--permissions", JSON.stringify({
        public_verification: "denied",
        ...Object.fromEntries((representative.provider_roles ?? []).map(({ provider }) => [
          `provider_read:${provider}`,
          "denied",
        ])),
      }),
    ]);
    if (
      verified.status !== "completed"
      || verified.interaction?.source_report?.report_id !== completed.report.report_id
      || verified.manifest_drift?.length !== 0
      || verified.report?.policy?.current !== true
      || verified.comparison?.source_report_id === verified.comparison?.current_report_id
      || !verified.comparison?.invalidated_evidence?.some(
        ({ target }) => target === "repository:.env.example",
      )
    ) {
      throw new Error(`coverage_artifact_verification_failed: ${representative.id}`);
    }
    assertEnvironmentBoundEvidence(verified, "production", "passed");
    if (
      verified.report.results.checks.some(({ environment }) => environment !== "production")
      || verified.evidence_index.entries.some(({ environment }) => environment !== "production")
    ) throw new Error(`coverage_artifact_environment_drift:${representative.id}`);
    coverageJourneys.push(representative.id);
  }

  assertEqual(
    coverageJourneys.sort(),
    [...P1_PRODUCT_JOURNEYS],
    "p1_product_matrix_incomplete",
    "Every representative Product journey must complete fresh Verify",
  );
  return {
    cleanProject,
    p1ProductJourneys: coverageJourneys,
    result: {
      operation: versionResult.operation,
      cli_version: versionResult.cli_version,
      audit_status: audit.status,
      provider_tool_recovery: "exact_instruction_and_fresh_permission",
      coverage_journeys: coverageJourneys,
    },
  };
}

async function nativeCommand(name) {
  if (name === "claude") {
    const wrapper = path.join(
      root,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "cli-wrapper.cjs",
    );
    try {
      await access(wrapper);
      return { command: process.execPath, prefix: [wrapper] };
    } catch {
      // Fall through to a host-provided executable for source checkouts without dev dependencies.
    }
  }
  if (name === "codex") {
    const local = path.join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
    try {
      await access(local);
      return { command: process.execPath, prefix: [local] };
    } catch {
      // Fall through to a host-provided executable for source checkouts without dev dependencies.
    }
  }
  const local = path.join(root, "node_modules", ".bin", name);
  try {
    await access(local);
    return { command: local, prefix: [] };
  } catch {
    return process.platform === "win32"
      ? { command: process.env.ComSpec ?? "cmd.exe", prefix: ["/d", "/s", "/c", name] }
      : { command: name, prefix: [] };
  }
}

async function runNative(name, arguments_, options) {
  const native = await nativeCommand(name);
  return run(native.command, [...native.prefix, ...arguments_], options);
}

async function isolatedNativeEnvironment(temporaryRoot, name) {
  const directory = path.join(temporaryRoot, name);
  await mkdir(directory, { recursive: true });
  const home = path.join(directory, "home");
  const codexHome = path.join(directory, "codex");
  const claudeConfig = path.join(directory, "claude");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(codexHome, { recursive: true }),
    mkdir(claudeConfig, { recursive: true }),
  ]);
  return {
    directory,
    codexHome,
    claudeConfig,
    environment: createIsolatedNativeEnvironment(process.env, {
      home,
      codex_home: codexHome,
      claude_config_dir: claudeConfig,
    }),
  };
}

async function nativeEffectBoundary(temporaryRoot) {
  const boundary = await isolatedNativeEnvironment(
    temporaryRoot,
    "native-host-effect-boundary",
  );
  const guard = path.join(boundary.directory, "deny-undisclosed-effects.cjs");
  await writeFile(guard, [
    'const deny = (effect) => () => { throw new Error(`native host ${effect} attempted`); };',
    'const childProcess = require("node:child_process");',
    'const originalSpawn = childProcess.spawn;',
    'const http = require("node:http");',
    'const https = require("node:https");',
    'const net = require("node:net");',
    'for (const method of ["exec", "execFile", "fork"]) {',
    '  childProcess[method] = deny("process execution");',
    '}',
    'childProcess.spawn = (command, ...args) => {',
    '  const normalized = String(command).replaceAll("\\\\", "/");',
    '  if ((normalized.includes("/node_modules/@openai/codex/vendor/")',
    '    || normalized.includes("/node_modules/@openai/codex-"))',
    '    && (normalized.endsWith("/codex") || normalized.endsWith("/codex.exe"))) {',
    '    return originalSpawn(command, ...args);',
    '  }',
    '  throw new Error("native host process execution attempted");',
    '};',
    'for (const owner of [http, https]) {',
    '  owner.get = deny("network access");',
    '  owner.request = deny("network access");',
    '}',
    'net.connect = deny("network access");',
    'net.createConnection = deny("network access");',
    'global.fetch = deny("network access");',
    'require("node:module").syncBuiltinESMExports();',
  ].join("\n"));
  boundary.environment.NODE_OPTIONS = [
    boundary.environment.NODE_OPTIONS ?? "",
    `--require=${guard}`,
  ].filter(Boolean).join(" ");
  return boundary;
}

async function validatePackedNativePlugins(temporaryRoot, cleanProject) {
  const boundary = await nativeEffectBoundary(temporaryRoot);
  const claudePlugin = path.join(
    cleanProject,
    "node_modules",
    "@launchrally",
    "claude-plugin",
  );
  await runNative("claude", [
    "plugin",
    "validate",
    "--strict",
    claudePlugin,
  ], { cwd: cleanProject, env: boundary.environment });
  const claudeMarketplaceRoot = path.join(temporaryRoot, "claude-marketplace");
  const claudeMarketplacePlugin = path.join(
    claudeMarketplaceRoot,
    "plugins",
    "launchrally",
  );
  await mkdir(path.join(claudeMarketplaceRoot, ".claude-plugin"), { recursive: true });
  await cp(claudePlugin, claudeMarketplacePlugin, { recursive: true });
  await writeFile(
    path.join(claudeMarketplaceRoot, ".claude-plugin", "marketplace.json"),
    `${JSON.stringify({
      $schema: "https://anthropic.com/claude-code/marketplace.schema.json",
      name: "launchrally-smoke",
      description: "Local packed LaunchRally smoke-test marketplace.",
      owner: { name: "LaunchRally" },
      plugins: [{
        name: "launchrally",
        source: "./plugins/launchrally",
        description: "Local packed LaunchRally plugin.",
        category: "development",
      }],
    }, null, 2)}\n`,
  );
  await runNative("claude", [
    "plugin", "marketplace", "add", claudeMarketplaceRoot, "--scope", "user",
  ], { cwd: cleanProject, env: boundary.environment });
  await runNative("claude", [
    "plugin", "install", "launchrally@launchrally-smoke", "--scope", "user",
  ], { cwd: cleanProject, env: boundary.environment });
  const claudeInstalled = JSON.parse((await runNative("claude", [
    "plugin", "list", "--json",
  ], { cwd: cleanProject, env: boundary.environment })).stdout);
  if (!JSON.stringify(claudeInstalled).includes("launchrally@launchrally-smoke")) {
    throw new Error("packed_claude_native_plugin_not_discovered");
  }
  await runNative("claude", [
    "plugin", "uninstall", "launchrally@launchrally-smoke", "--scope", "user",
  ], { cwd: cleanProject, env: boundary.environment });
  await runNative("claude", [
    "plugin", "marketplace", "remove", "launchrally-smoke",
  ], { cwd: cleanProject, env: boundary.environment });

  const codexPlugin = path.join(
    cleanProject,
    "node_modules",
    "@launchrally",
    "codex-plugin",
  );
  const marketplaceRoot = path.join(temporaryRoot, "codex-marketplace");
  const marketplacePlugin = path.join(marketplaceRoot, "plugins", "launchrally");
  await mkdir(path.join(marketplaceRoot, ".agents", "plugins"), { recursive: true });
  await cp(codexPlugin, marketplacePlugin, { recursive: true });
  await writeFile(
    path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
    `${JSON.stringify({
      name: "launchrally-smoke",
      plugins: [{
        name: "launchrally",
        source: { source: "local", path: "./plugins/launchrally" },
        policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        category: "Engineering",
      }],
    }, null, 2)}\n`,
  );
  await runNative("codex", [
    "plugin", "marketplace", "add", marketplaceRoot, "--json",
  ], { cwd: cleanProject, env: boundary.environment });
  await runNative("codex", [
    "plugin", "add", "launchrally@launchrally-smoke", "--json",
  ], { cwd: cleanProject, env: boundary.environment });
  const codexInstalled = JSON.parse((await runNative("codex", [
    "plugin", "list", "--json",
  ], { cwd: cleanProject, env: boundary.environment })).stdout);
  if (!JSON.stringify(codexInstalled).includes("launchrally@launchrally-smoke")) {
    throw new Error("packed_codex_native_plugin_not_discovered");
  }
  await runNative("codex", [
    "plugin", "remove", "launchrally@launchrally-smoke", "--json",
  ], { cwd: cleanProject, env: boundary.environment });

  return {
    statuses: {
      claude: "installed_discovered_and_removed",
      codex: "installed_discovered_and_removed",
    },
    effects: {
      configuration_isolated: true,
      sensitive_environment_removed: true,
      scope: "native_plugin_discovery_only",
      agent_execution: "p1_external_verification_required",
    },
  };
}

async function validatePublicNativePlugins(temporaryRoot, cleanProject, version) {
  const boundary = await isolatedNativeEnvironment(
    temporaryRoot,
    "public-native-host-boundary",
  );
  const claudeEnvironment = boundary.environment;
  await runNative("claude", [
    "plugin", "marketplace", "add", "codeacme17/launchrally", "--scope", "user",
  ], { cwd: cleanProject, env: claudeEnvironment });
  const claudeAvailable = JSON.parse((await runNative("claude", [
    "plugin", "list", "--available", "--json",
  ], { cwd: cleanProject, env: claudeEnvironment })).stdout);
  const claudeEntry = claudeAvailable.available?.find(({ pluginId }) => (
    pluginId === "launchrally@launchrally"
  ));
  if (
    claudeEntry?.source?.package !== "@launchrally/claude-plugin"
    || claudeEntry.source.version !== version
  ) {
    throw new Error(
      `public_claude_marketplace_drift: expected @launchrally/claude-plugin@${version}`,
    );
  }
  await runNative("claude", [
    "plugin", "install", "launchrally@launchrally", "--scope", "user",
  ], { cwd: cleanProject, env: claudeEnvironment });
  const claudeInstalled = JSON.parse((await runNative("claude", [
    "plugin", "list", "--available", "--json",
  ], { cwd: cleanProject, env: claudeEnvironment })).stdout);
  if (!hasClaudeInstalledPlugin(
    claudeInstalled,
    "launchrally@launchrally",
    version,
  )) {
    throw new Error("public_claude_install_failed: launchrally@launchrally is not installed");
  }
  await runNative("claude", [
    "plugin",
    "validate",
    "--strict",
    path.join(cleanProject, "node_modules", "@launchrally", "claude-plugin"),
  ], { cwd: cleanProject, env: claudeEnvironment });
  await runNative("claude", [
    "plugin", "uninstall", "launchrally@launchrally", "--scope", "user",
  ], { cwd: cleanProject, env: claudeEnvironment });
  await runNative("claude", [
    "plugin", "marketplace", "remove", "launchrally", "--scope", "user",
  ], { cwd: cleanProject, env: claudeEnvironment });

  const codexEnvironment = boundary.environment;
  await runNative("codex", [
    "plugin", "marketplace", "add", "codeacme17/launchrally", "--ref", `v${version}`, "--json",
  ], { cwd: cleanProject, env: codexEnvironment });
  await runNative("codex", [
    "plugin", "add", "launchrally@launchrally", "--json",
  ], { cwd: cleanProject, env: codexEnvironment });
  const codexInstalled = JSON.parse((await runNative("codex", [
    "plugin", "list", "--json",
  ], { cwd: cleanProject, env: codexEnvironment })).stdout);
  if (!codexInstalled.installed?.some(({ pluginId, version: installedVersion }) => (
    pluginId === "launchrally@launchrally" && installedVersion === version
  ))) {
    throw new Error("public_codex_install_failed: launchrally@launchrally is not installed");
  }
  await runNative("codex", [
    "plugin", "remove", "launchrally@launchrally", "--json",
  ], { cwd: cleanProject, env: codexEnvironment });
  await runNative("codex", [
    "plugin", "marketplace", "remove", "launchrally", "--json",
  ], { cwd: cleanProject, env: codexEnvironment });

  return {
    statuses: {
      claude: "public_marketplace_installed_and_removed",
      codex: "tagged_public_marketplace_installed_and_removed",
    },
    effects: {
      configuration_isolated: true,
      sensitive_environment_removed: true,
      scope: "public_native_plugin_discovery_only",
      agent_execution: "p1_external_verification_required",
    },
  };
}

function publicReleasePlan(release, version, distTag = "experimental") {
  const exactPackages = release.packages.map(({ name }) => `${name}@${version}`);
  return {
    status: "planned",
    source: "public_registry",
    version,
    exact_packages: exactPackages,
    install: {
      command: "npm",
      arguments: [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--save-exact",
        ...exactPackages,
      ],
    },
    registry_verification: release.packages.map(({ name }) => ({
      package: name,
      dist_tag: distTag,
      expected_version: version,
    })),
    provenance_verification: {
      command: "npm",
      arguments: ["audit", "signatures", "--json", "--include-attestations"],
    },
    invocation_journeys: {
      npm_exec: {
        command: "npm",
        arguments: [
          "exec",
          `--package=@launchrally/cli@${version}`,
          "--",
          "rally",
        ],
      },
      user_prefix: {
        install: {
          command: "npm",
          arguments: [
            "install",
            "--global",
            "--ignore-scripts",
            `@launchrally/cli@${version}`,
          ],
        },
        verification: ["--version", "--json"],
      },
    },
    cli_smoke: true,
    native_plugins: {
      claude: {
        marketplace: "codeacme17/launchrally",
        plugin: "launchrally@launchrally",
        scope: "user",
      },
      codex: {
        marketplace: "codeacme17/launchrally",
        plugin: "launchrally@launchrally",
        ref: `v${version}`,
      },
    },
  };
}

async function waitForPublicRelease(release, version, distTag) {
  const attempts = 18;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let unavailable = null;
    for (const { name } of release.packages) {
      try {
        const { stdout } = await runNpm([
          "view",
          `${name}@${distTag}`,
          "version",
          "--json",
        ], { cwd: root });
        const publishedVersion = JSON.parse(stdout);
        if (publishedVersion !== version) {
          throw new Error(
            `public_dist_tag_drift: ${name}@${distTag} resolves to ${publishedVersion}; expected ${version}`,
          );
        }
      } catch (error) {
        if (/public_dist_tag_drift/u.test(error.message)) throw error;
        const detail = `${error.stderr ?? ""}\n${error.message ?? ""}`;
        if (!/\bE404\b|404 Not Found|No match found/u.test(detail)) {
          throw new Error(`public_registry_verification_failed: ${name}: ${detail.trim()}`);
        }
        unavailable = name;
        break;
      }
    }
    if (unavailable === null) return;
    if (attempt === attempts) {
      throw new Error(
        `public_registry_propagation_timeout: ${unavailable}@${version} was not public after ${attempts} attempts`,
      );
    }
    process.stderr.write(
      `Waiting for ${unavailable}@${version} to reach the public registry (${attempt}/${attempts}).\n`,
    );
    await delay(10_000);
  }
}

function publicDistTag() {
  const option = process.argv.indexOf("--dist-tag");
  const distTag = option === -1 ? "experimental" : process.argv[option + 1];
  if (!new Set(["experimental", "latest"]).has(distTag)) {
    throw new Error(`public_dist_tag_invalid: ${distTag ?? "missing"}`);
  }
  return distTag;
}

async function main() {
  assertP1MatrixTarget();
  const release = await json(path.join(root, "release", "artifacts.json"));
  const rootPackage = await json(path.join(root, "package.json"));
  const publicRelease = process.argv.includes("--public");
  const distTag = publicDistTag();
  const publicLegacy = publicRelease || process.argv.includes("--public-legacy");
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "launchrally-artifacts-"));
  try {
    let installArguments;
    let cacheDirectory;
    let packageTarballs;
    if (publicRelease) {
      await waitForPublicRelease(release, rootPackage.version, distTag);
      installArguments = publicReleasePlan(release, rootPackage.version, distTag).install.arguments;
      cacheDirectory = path.join(temporaryRoot, "npm-install-cache");
      installArguments.splice(
        installArguments.indexOf("--save-exact") + 1,
        0,
        "--cache",
        cacheDirectory,
      );
    } else {
      const packed = await packArtifacts(temporaryRoot, release);
      ({ cacheDirectory, packageTarballs } = packed);
      installArguments = [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--offline",
        "--save-exact",
        "--cache",
        cacheDirectory,
        ...packed.tarballs,
      ];
    }
    const cliSmoke = await smokeCli(
      temporaryRoot,
      installArguments,
      rootPackage.version,
      release.packages,
      { verifyProvenance: publicRelease },
    );
    const installationJourneys = await runInstallationJourneys({
      temporaryRoot,
      cleanProject: cliSmoke.cleanProject,
      version: rootPackage.version,
      cacheDirectory,
      packageTarballs,
      publicLegacy,
      publicRelease,
    });
    const nativeValidation = process.argv.includes("--skip-native")
      ? { statuses: "skipped", effects: null }
      : publicRelease
        ? await validatePublicNativePlugins(
          temporaryRoot,
          cliSmoke.cleanProject,
          rootPackage.version,
        )
        : await validatePackedNativePlugins(temporaryRoot, cliSmoke.cleanProject);
    const nativePlugins = nativeValidation.statuses;
    if (nativePlugins === "skipped") {
      installationJourneys.result.plugin_removal = "skipped";
    } else {
      await access(path.join(installationJourneys.projectData, "manifest.yaml"));
      await access(path.join(
        installationJourneys.projectData,
        "toolchain",
        "authority.json",
      ));
      installationJourneys.result.plugin_removal = "project_data_preserved";
    }
    const p1ExactArtifacts = {
      result_version: 1,
      matrix_target: {
        platform: process.platform,
        node_major: Number(process.versions.node.split(".")[0]),
        shell: process.platform === "win32" ? "powershell" : "posix",
      },
      public_surfaces: ["claude", "cli", "codex", "contracts", "core", "skill"],
      product_journeys: cliSmoke.p1ProductJourneys,
      integration_families: installationJourneys.p1Evidence.integrationFamilies,
      integration_fresh_verify: installationJourneys.p1Evidence.integrationFreshVerify,
      host_journeys: installationJourneys.p1Evidence.hostJourneys,
      native_host_journeys: nativePlugins === "skipped" ? "skipped" : {
        claude: {
          discovery: "native_plugin_installed_listed_and_removed",
          agent_execution: "p1_external_verification_required",
        },
        codex: {
          discovery: "native_plugin_installed_listed_and_removed",
          agent_execution: "p1_external_verification_required",
        },
      },
      cross_host_resume: process.platform === "win32"
        ? "typed_unavailable"
        : "architecture_and_handoff",
      p0_to_p1_migration: installationJourneys.p1Evidence.p0ToP1Migration,
      scenarios: installationJourneys.p1Evidence.scenarios,
      fresh_verify: {
        receipt_claims: "verification_required",
        successful_downstream: process.platform === "win32"
          ? "typed_runner_unavailable"
          : "environment_bound_machine_evidence",
        unsuccessful_downstream: process.platform === "win32"
          ? "typed_runner_unavailable"
          : "environment_bound_no_go",
      },
      clean_host: installationJourneys.p1Evidence.cleanHost,
    };
    const result = {
      status: "completed",
      version: rootPackage.version,
      cli_smoke: cliSmoke.result,
      installation_journeys: installationJourneys.result,
      p1_exact_artifacts: p1ExactArtifacts,
      native_plugins: nativePlugins,
      native_plugin_boundary: nativeValidation.effects,
    };
    return publicRelease
      ? {
        ...result,
        source: "public_registry",
        exact_packages: publicReleasePlan(release, rootPackage.version, distTag).exact_packages,
      }
      : {
        ...result,
        artifacts: release.packages.map((artifact) => artifact.name).sort(),
        artifact_files_verified: true,
      };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const autoDiscoveredByNodeTest = process.env.NODE_TEST_CONTEXT !== undefined
  && process.argv.length === 2;

if (autoDiscoveredByNodeTest) {
  // The named release-gate test invokes this script once with --json. Avoid a
  // second concurrent full journey when node --test discovers this file by name.
} else if (process.argv.includes("--public") && process.argv.includes("--dry-run")) {
  const release = await json(path.join(root, "release", "artifacts.json"));
  const rootPackage = await json(path.join(root, "package.json"));
  const distTag = publicDistTag();
  const plan = publicReleasePlan(release, rootPackage.version, distTag);
  process.stdout.write(
    process.argv.includes("--json")
      ? `${JSON.stringify(plan)}\n`
      : `${plan.install.command} ${plan.install.arguments.join(" ")}\n`,
  );
} else {
  try {
    const result = await main();
    process.stdout.write(
      process.argv.includes("--json")
        ? `${JSON.stringify(result)}\n`
        : process.argv.includes("--public")
          ? `Verified ${result.exact_packages.length} public release artifacts for ${result.version}.\n`
          : `Verified ${result.artifacts.length} release artifacts for ${result.version}.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
