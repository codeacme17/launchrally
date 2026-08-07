import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
    const { stdout } = await run("npm", [
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

async function smokeCli(temporaryRoot, cacheDirectory, tarballs, version) {
  const cleanProject = path.join(temporaryRoot, "clean-install");
  await mkdir(cleanProject, { recursive: true });
  await writeFile(
    path.join(cleanProject, "package.json"),
    '{"name":"launchrally-release-smoke","private":true}\n',
  );
  await run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--offline",
    "--save-exact",
    "--cache",
    cacheDirectory,
    ...tarballs,
  ], { cwd: cleanProject });

  const rally = path.join(cleanProject, "node_modules", ".bin", "rally");
  const versionResult = JSON.parse((await run(rally, ["--version", "--json"], {
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
  const audit = JSON.parse((await run(
    rally,
    ["audit", "--json", "--cwd", auditProject],
    { cwd: cleanProject },
  )).stdout);
  if (audit.status !== "needs_input") {
    throw new Error(`cli_artifact_smoke_failed: first Audit returned ${audit.status}`);
  }

  return {
    cleanProject,
    result: {
      operation: versionResult.operation,
      cli_version: versionResult.cli_version,
      audit_status: audit.status,
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
  const local = path.join(root, "node_modules", ".bin", name);
  try {
    await access(local);
    return { command: local, prefix: [] };
  } catch {
    return { command: name, prefix: [] };
  }
}

async function runNative(name, arguments_, options) {
  const native = await nativeCommand(name);
  return run(native.command, [...native.prefix, ...arguments_], options);
}

async function validateNativePlugins(temporaryRoot, cleanProject) {
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

async function main() {
  const release = await json(path.join(root, "release", "artifacts.json"));
  const rootPackage = await json(path.join(root, "package.json"));
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "launchrally-artifacts-"));
  try {
    const { cacheDirectory, tarballs } = await packArtifacts(temporaryRoot, release);
    const cliSmoke = await smokeCli(
      temporaryRoot,
      cacheDirectory,
      tarballs,
      rootPackage.version,
    );
    const nativePlugins = process.argv.includes("--skip-native")
      ? "skipped"
      : await validateNativePlugins(temporaryRoot, cliSmoke.cleanProject);
    return {
      status: "completed",
      version: rootPackage.version,
      artifacts: release.packages.map((artifact) => artifact.name).sort(),
      artifact_files_verified: true,
      cli_smoke: cliSmoke.result,
      native_plugins: nativePlugins,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  const result = await main();
  process.stdout.write(
    process.argv.includes("--json")
      ? `${JSON.stringify(result)}\n`
      : `Verified ${result.artifacts.length} release artifacts for ${result.version}.\n`,
  );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
