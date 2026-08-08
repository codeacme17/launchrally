import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { writeExactToolchain } from "../test/helpers/exact-toolchain.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

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

function assertEqual(actual, expected, code, detail) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${code}: ${detail}`);
  }
}

async function packArtifacts(temporaryRoot, release) {
  const packDirectory = path.join(temporaryRoot, "packs");
  const cacheDirectory = path.join(temporaryRoot, "npm-cache");
  await mkdir(packDirectory, { recursive: true });
  const tarballs = [];

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
    tarballs.push(path.join(packDirectory, packed.filename));
  }

  return { cacheDirectory, tarballs };
}

async function smokeCli(temporaryRoot, installArguments, version, publicPackages = []) {
  const cleanProject = path.join(temporaryRoot, "clean-install");
  await mkdir(cleanProject, { recursive: true });
  await writeFile(
    path.join(cleanProject, "package.json"),
    '{"name":"launchrally-release-smoke","private":true}\n',
  );
  await runNpm(installArguments, { cwd: cleanProject });

  if (publicPackages.length > 0) {
    const { stdout } = await runNpm([
      "audit",
      "signatures",
      "--json",
      "--include-attestations",
      "--cache",
      path.join(temporaryRoot, "npm-signature-cache"),
    ], { cwd: cleanProject });
    const signatureAudit = JSON.parse(stdout);
    for (const artifact of publicPackages) {
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

  for (const artifact of publicPackages) {
    const installed = await json(path.join(
      cleanProject,
      "node_modules",
      ...artifact.name.split("/"),
      "package.json",
    ));
    if (installed.name !== artifact.name || installed.version !== version) {
      throw new Error(
        `public_artifact_version_drift: ${artifact.name} installed as ${installed.name}@${installed.version}`,
      );
    }
  }

  const rally = path.join(
    cleanProject,
    "node_modules",
    "@launchrally",
    "cli",
    "bin",
    "rally.js",
  );
  const invokeRally = (arguments_, options = {}) => run(
    process.execPath,
    [rally, ...arguments_],
    options,
  );
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

  const matrix = await json(path.join(root, "fixtures", "coverage", "matrix.json"));
  const networkGuard = path.join(temporaryRoot, "deny-network.cjs");
  await cp(path.join(root, "fixtures", "coverage", "deny-network.cjs"), networkGuard);
  const coverageEnvironment = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${networkGuard}`.trim(),
  };
  const coverageJourneys = [];
  for (const representative of matrix.fixtures) {
    const repository = path.join(temporaryRoot, "coverage", representative.id);
    await cp(
      path.join(root, "fixtures", "coverage", representative.path),
      repository,
      { recursive: true },
    );
    const invoke = async (arguments_) => JSON.parse((await invokeRally(
      arguments_,
      { cwd: cleanProject, env: coverageEnvironment },
    )).stdout);
    await writeExactToolchain(repository, version);
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
    if (refreshed.status !== "completed") {
      throw new Error(`coverage_artifact_refresh_failed: ${representative.id}`);
    }
    const refreshedPath = path.join(reports, `${representative.id}-refreshed.json`);
    await writeFile(refreshedPath, JSON.stringify(refreshed));
    const plan = await invoke([
      "plan", "--json", "--cwd", repository, "--report", refreshedPath,
    ]);
    const handoff = await invoke([
      "plan", "--json", "--cwd", repository, "--report", refreshedPath, "--handoff",
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
      "--report", refreshedPath,
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
      || verified.comparison?.source_report_id === verified.comparison?.current_report_id
      || !verified.comparison?.invalidated_evidence?.some(
        ({ target }) => target === "repository:.env.example",
      )
    ) {
      throw new Error(`coverage_artifact_verification_failed: ${representative.id}`);
    }
    coverageJourneys.push(representative.id);
  }

  return {
    cleanProject,
    result: {
      operation: versionResult.operation,
      cli_version: versionResult.cli_version,
      audit_status: audit.status,
      coverage_journeys: coverageJourneys.sort(),
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

async function validatePackedNativePlugins(temporaryRoot, cleanProject) {
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
  ], { cwd: cleanProject });

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
  const codexHome = path.join(temporaryRoot, "codex-user-scope");
  await mkdir(codexHome, { recursive: true });
  const codexEnvironment = { ...process.env, CODEX_HOME: codexHome };
  await runNative("codex", [
    "plugin", "marketplace", "add", marketplaceRoot, "--json",
  ], { cwd: cleanProject, env: codexEnvironment });
  await runNative("codex", [
    "plugin", "add", "launchrally@launchrally-smoke", "--json",
  ], { cwd: cleanProject, env: codexEnvironment });
  await runNative("codex", [
    "plugin", "remove", "launchrally@launchrally-smoke", "--json",
  ], { cwd: cleanProject, env: codexEnvironment });

  return {
    claude: "strictly_validated",
    codex: "installed_and_removed",
  };
}

async function validatePublicNativePlugins(temporaryRoot, cleanProject, version) {
  const claudeConfig = path.join(temporaryRoot, "claude-user-scope");
  await mkdir(claudeConfig, { recursive: true });
  const claudeEnvironment = { ...process.env, CLAUDE_CONFIG_DIR: claudeConfig };
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
  if (!claudeInstalled.installed?.some(({ pluginId }) => (
    pluginId === "launchrally@launchrally"
  ))) {
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

  const codexHome = path.join(temporaryRoot, "codex-user-scope");
  await mkdir(codexHome, { recursive: true });
  const codexEnvironment = { ...process.env, CODEX_HOME: codexHome };
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
    claude: "public_marketplace_installed_and_removed",
    codex: "tagged_public_marketplace_installed_and_removed",
  };
}

function publicReleasePlan(release, version) {
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
      dist_tag: "experimental",
      expected_version: version,
    })),
    provenance_verification: {
      command: "npm",
      arguments: ["audit", "signatures", "--json", "--include-attestations"],
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

async function waitForPublicRelease(release, version) {
  const attempts = 18;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let unavailable = null;
    for (const { name } of release.packages) {
      try {
        const { stdout } = await runNpm([
          "view",
          `${name}@experimental`,
          "version",
          "--json",
        ], { cwd: root });
        const publishedVersion = JSON.parse(stdout);
        if (publishedVersion !== version) {
          throw new Error(
            `public_dist_tag_drift: ${name}@experimental resolves to ${publishedVersion}; expected ${version}`,
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

async function main() {
  const release = await json(path.join(root, "release", "artifacts.json"));
  const rootPackage = await json(path.join(root, "package.json"));
  const publicRelease = process.argv.includes("--public");
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "launchrally-artifacts-"));
  try {
    let installArguments;
    if (publicRelease) {
      await waitForPublicRelease(release, rootPackage.version);
      installArguments = publicReleasePlan(release, rootPackage.version).install.arguments;
      installArguments.splice(
        installArguments.indexOf("--save-exact") + 1,
        0,
        "--cache",
        path.join(temporaryRoot, "npm-install-cache"),
      );
    } else {
      const { cacheDirectory, tarballs } = await packArtifacts(temporaryRoot, release);
      installArguments = [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--offline",
        "--save-exact",
        "--cache",
        cacheDirectory,
        ...tarballs,
      ];
    }
    const cliSmoke = await smokeCli(
      temporaryRoot,
      installArguments,
      rootPackage.version,
      publicRelease ? release.packages : [],
    );
    const nativePlugins = process.argv.includes("--skip-native")
      ? "skipped"
      : publicRelease
        ? await validatePublicNativePlugins(
          temporaryRoot,
          cliSmoke.cleanProject,
          rootPackage.version,
        )
        : await validatePackedNativePlugins(temporaryRoot, cliSmoke.cleanProject);
    const result = {
      status: "completed",
      version: rootPackage.version,
      cli_smoke: cliSmoke.result,
      native_plugins: nativePlugins,
    };
    return publicRelease
      ? {
        ...result,
        source: "public_registry",
        exact_packages: publicReleasePlan(release, rootPackage.version).exact_packages,
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

if (process.argv.includes("--public") && process.argv.includes("--dry-run")) {
  const release = await json(path.join(root, "release", "artifacts.json"));
  const rootPackage = await json(path.join(root, "package.json"));
  const plan = publicReleasePlan(release, rootPackage.version);
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
