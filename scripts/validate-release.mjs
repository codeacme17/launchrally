import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootOption = process.argv.indexOf("--root");
const root = rootOption === -1
  ? scriptRoot
  : path.resolve(process.argv[rootOption + 1] ?? "");
const tagOption = process.argv.indexOf("--tag");
const releaseTag = tagOption === -1 ? null : process.argv[tagOption + 1];
const execFileAsync = promisify(execFile);
const forbiddenLifecycleScripts = new Set([
  "install",
  "postinstall",
  "postpack",
  "postpublish",
  "preinstall",
  "prepack",
  "prepare",
  "prepublish",
  "prepublishOnly",
]);
const pluginManifestPaths = {
  claude: "adapters/claude/launchrally/.claude-plugin/plugin.json",
  codex: "adapters/codex/launchrally/.codex-plugin/plugin.json",
};
const skillContractPaths = {
  canonical: "skills/launchrally/references/reference-journey.json",
  claude: "adapters/claude/launchrally/skills/launchrally/references/reference-journey.json",
  codex: "adapters/codex/launchrally/skills/launchrally/references/reference-journey.json",
};
const skillTextPaths = [
  "skills/launchrally/SKILL.md",
  "skills/launchrally/references/reference-journey.md",
  "adapters/claude/launchrally/skills/launchrally/SKILL.md",
  "adapters/claude/launchrally/skills/launchrally/references/reference-journey.md",
  "adapters/codex/launchrally/skills/launchrally/SKILL.md",
  "adapters/codex/launchrally/skills/launchrally/references/reference-journey.md",
];

async function json(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

function assertEqualVersion(actual, expected, source) {
  if (actual !== expected) {
    throw new Error(`release_version_drift: ${source} declares ${actual ?? "no version"}; expected ${expected}`);
  }
}

async function validateRelease() {
  const rootPackage = await json("package.json");
  const release = await json("release/artifacts.json");
  const version = rootPackage.version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`invalid_release_version: ${version}`);
  }
  if (releaseTag !== null && releaseTag !== `v${version}`) {
    throw new Error(`release_tag_mismatch: ${releaseTag ?? "no tag"} does not match v${version}`);
  }

  const packages = [];
  for (const artifact of release.packages) {
    const packagePath = `${artifact.path}/package.json`;
    const packageJson = await json(packagePath);
    if (packageJson.name !== artifact.name) {
      throw new Error(
        `release_artifact_name_drift: ${packagePath} declares ${packageJson.name}; expected ${artifact.name}`,
      );
    }
    assertEqualVersion(packageJson.version, version, packagePath);
    if (JSON.stringify(packageJson.files) !== JSON.stringify(artifact.package_files)) {
      throw new Error(
        `release_artifact_allowlist_drift: ${packageJson.name} files differ from release/artifacts.json`,
      );
    }
    const lifecycleScript = Object.keys(packageJson.scripts ?? {})
      .find((script) => forbiddenLifecycleScripts.has(script));
    if (lifecycleScript) {
      throw new Error(
        `forbidden_lifecycle_script: ${packageJson.name} declares ${lifecycleScript}`,
      );
    }
    for (const dependencyGroup of [
      packageJson.dependencies,
      packageJson.optionalDependencies,
      packageJson.peerDependencies,
    ]) {
      for (const [dependency, dependencyVersion] of Object.entries(dependencyGroup ?? {})) {
        if (dependency.startsWith("@launchrally/") && dependencyVersion !== version) {
          throw new Error(
            `release_dependency_drift: ${packageJson.name} dependency ${dependency} declares ${dependencyVersion}; expected ${version}`,
          );
        }
      }
    }
    packages.push(packageJson.name);
  }

  for (const [host, manifestPath] of Object.entries(pluginManifestPaths)) {
    const manifest = await json(manifestPath);
    assertEqualVersion(manifest.version, version, manifestPath);
    if (manifest.name !== "launchrally") {
      throw new Error(`invalid_plugin_name: ${host} declares ${manifest.name}`);
    }
  }

  const claudeMarketplacePath = ".claude-plugin/marketplace.json";
  const claudeMarketplace = await json(claudeMarketplacePath);
  const claudeSource = claudeMarketplace.plugins?.find(
    (plugin) => plugin.name === "launchrally",
  )?.source;
  if (claudeSource?.source !== "npm" || claudeSource.package !== "@launchrally/claude-plugin") {
    throw new Error("invalid_plugin_source: Claude marketplace must use the public npm artifact");
  }
  assertEqualVersion(claudeSource.version, version, claudeMarketplacePath);

  const codexMarketplace = await json(".agents/plugins/marketplace.json");
  const codexSource = codexMarketplace.plugins?.find(
    (plugin) => plugin.name === "launchrally",
  )?.source;
  if (
    codexSource?.source !== "local"
    || codexSource.path !== "./adapters/codex/launchrally"
  ) {
    throw new Error("invalid_plugin_source: Codex marketplace must use the bundled adapter");
  }

  for (const contractPath of Object.values(skillContractPaths)) {
    const contract = await json(contractPath);
    assertEqualVersion(contract.cli?.version, version, contractPath);
    assertEqualVersion(contract.cli?.package, "@launchrally/cli", `${contractPath} CLI package`);
  }

  for (const skillPath of skillTextPaths) {
    const content = await readFile(path.join(root, skillPath), "utf8");
    const declaredVersions = [
      ...content.matchAll(/@launchrally\/cli@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/gu),
      ...content.matchAll(/cli_version:\s*["'`](\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)["'`]/gu),
    ].map((match) => match[1]);
    if (declaredVersions.length === 0 || declaredVersions.some((declared) => declared !== version)) {
      throw new Error(
        `skill_contract_version_drift: ${skillPath} must declare only @launchrally/cli@${version}`,
      );
    }
  }

  const { stdout } = await execFileAsync(
    process.execPath,
    [path.join(root, "packages/cli/bin/rally.js"), "--version", "--json"],
    { cwd: root },
  );
  const runtime = JSON.parse(stdout);
  assertEqualVersion(runtime.cli_version, version, "rally --version --json");

  return {
    status: "completed",
    version,
    packages: packages.sort(),
    plugin_manifests: Object.keys(pluginManifestPaths).sort(),
    skill_contracts: Object.keys(skillContractPaths).sort(),
  };
}

try {
  const result = await validateRelease();
  process.stdout.write(
    process.argv.includes("--json")
      ? `${JSON.stringify(result)}\n`
      : `Release ${result.version} is internally consistent.\n`,
  );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
