import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertValidProviderKnowledge,
  assertValidReferenceIntegrationPack,
} from "@launchrally/contracts";
import { CORE_PROVIDER_KNOWLEDGE } from "../packages/core/src/provider-knowledge.js";
import { referenceExecutorDescriptors } from "../packages/core/src/reference-executors.js";

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
const providerToolAuthorityPath =
  "packages/core/provider-tool-installation/v1/authority.json";
const providerToolRecoverySkillPaths = [
  "skills/launchrally/references/provider-tool-recovery.md",
  "adapters/claude/launchrally/skills/launchrally/references/provider-tool-recovery.md",
  "adapters/codex/launchrally/skills/launchrally/references/provider-tool-recovery.md",
];
const exactVersionPattern =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const providerSourceHosts = new Set([
  "clerk.com",
  "developers.cloudflare.com",
  "neon.com",
  "resend.com",
  "vercel.com",
  "www.npmjs.com",
]);
const providerIdentities = Object.freeze({
  clerk: { source_host: "clerk.com", package_name: "clerk", executable: "clerk", adapter_version: "clerk-read/v1" },
  cloudflare: { source_host: "developers.cloudflare.com", package_name: "wrangler", executable: "wrangler", adapter_version: "cloudflare-read/v1" },
  neon: { source_host: "neon.com", package_name: "neonctl", executable: "neonctl", adapter_version: "neon-read/v1" },
  resend: { source_host: "resend.com", package_name: "resend-cli", executable: "resend", adapter_version: "resend-read/v1" },
  sentry: { source_host: "www.npmjs.com", package_name: "@sentry/cli", executable: "sentry-cli", adapter_version: "sentry-read/v1" },
  vercel: { source_host: "vercel.com", package_name: "vercel", executable: "vercel", adapter_version: "vercel-read/v1" },
});
const referencePackPaths = [
  "identity-to-application-data.json",
  "payment-to-entitlement.json",
  "source-to-ci-cd-to-deployment.json",
  "storage-to-metadata-access.json",
  "email-to-domain-delivery.json",
  "release-to-observability.json",
  "backup-to-restore.json",
  "queue-background-work.json",
].map((file) => `packages/core/reference-integration-packs/v1/${file}`);
const phase1CommandPaths = [
  "skills/launchrally/references/phase-1-command-examples.json",
  "adapters/claude/launchrally/skills/launchrally/references/phase-1-command-examples.json",
  "adapters/codex/launchrally/skills/launchrally/references/phase-1-command-examples.json",
];

async function json(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

function assertEqualVersion(actual, expected, source) {
  if (actual !== expected) {
    throw new Error(`release_version_drift: ${source} declares ${actual ?? "no version"}; expected ${expected}`);
  }
}

async function validateProviderToolAuthority() {
  const entries = await json(providerToolAuthorityPath);
  const expectedProviders = ["clerk", "cloudflare", "neon", "resend", "sentry", "vercel"];
  if (
    !Array.isArray(entries)
    || JSON.stringify(entries.map(({ provider }) => provider)) !== JSON.stringify(expectedProviders)
  ) {
    throw new Error("provider_tool_authority_invalid: supported Providers are missing, duplicated, or unordered");
  }
  for (const entry of entries) {
    const source = entry.official_source;
    let sourceHost;
    try {
      sourceHost = new URL(source?.url).hostname;
    } catch {
      sourceHost = null;
    }
    if (!source?.title || !providerSourceHosts.has(sourceHost)) {
      throw new Error(`provider_tool_authority_invalid: ${entry.provider} has no reviewed official source`);
    }
    const identity = providerIdentities[entry.provider];
    if (
      sourceHost !== identity.source_host
      || entry.package?.name !== identity.package_name
      || entry.executable !== identity.executable
      || entry.adapter_version !== identity.adapter_version
    ) {
      throw new Error(`provider_tool_authority_invalid: ${entry.provider} identity drifted from its reviewed source and Adapter`);
    }
    const exactVersion = entry.package?.exact_version;
    if (!exactVersionPattern.test(exactVersion ?? "")) {
      throw new Error(`provider_tool_authority_invalid: ${entry.provider} must pin an exact supported version`);
    }
    if (
      entry.package.manager !== "npm"
      || entry.verification_command?.executable !== entry.executable
      || JSON.stringify(entry.verification_command.arguments) !== JSON.stringify(["--version"])
      || entry.verification_command.shell !== false
    ) {
      throw new Error(`provider_tool_authority_invalid: ${entry.provider} has an unsafe verification command`);
    }
    if (
      !Array.isArray(entry.supported_platforms)
      || !Array.isArray(entry.supported_shells)
      || !Array.isArray(entry.installation_routes)
    ) {
      throw new Error(`provider_tool_authority_invalid: ${entry.provider} has incomplete platform guidance`);
    }
    if (
      entry.installation_routes.length === 0
      && (entry.supported_platforms.length !== 0 || entry.supported_shells.length !== 0)
    ) {
      throw new Error(`provider_tool_authority_invalid: ${entry.provider} claims unsupported installation guidance`);
    }
    for (const route of entry.installation_routes) {
      if (
        route.platforms.some((platform) => !entry.supported_platforms.includes(platform))
        || route.shells.some((shell) => !entry.supported_shells.includes(shell))
      ) {
        throw new Error(`provider_tool_authority_invalid: ${entry.provider} claims an unsupported platform or shell`);
      }
      const expectedArguments = [
        "install",
        "--global",
        `${entry.package.name}@${exactVersion}`,
      ];
      if (
        route.command?.executable !== "npm"
        || JSON.stringify(route.command.arguments) !== JSON.stringify(expectedArguments)
        || route.command.shell !== false
      ) {
        throw new Error(`provider_tool_authority_invalid: ${entry.provider} has an unreviewed or floating installation command`);
      }
    }
    for (const platform of entry.supported_platforms) {
      if (!entry.installation_routes.some((route) => route.platforms.includes(platform))) {
        throw new Error(`provider_tool_authority_invalid: ${entry.provider} has a stale supported platform claim`);
      }
    }
    for (const shell of entry.supported_shells) {
      if (!entry.installation_routes.some((route) => route.shells.includes(shell))) {
        throw new Error(`provider_tool_authority_invalid: ${entry.provider} has a stale supported shell claim`);
      }
    }
  }

  const recoveryReferences = await Promise.all(providerToolRecoverySkillPaths.map(
    (relativePath) => readFile(path.join(root, relativePath), "utf8"),
  ));
  if (recoveryReferences.some((content) => content !== recoveryReferences[0])) {
    throw new Error("provider_tool_recovery_skill_drift: canonical, Codex, and Claude routes differ");
  }
}

async function validateP1SupplyChain() {
  assertValidProviderKnowledge(CORE_PROVIDER_KNOWLEDGE);
  const descriptorDigests = new Map(referenceExecutorDescriptors.map((descriptor) => [
    descriptor.descriptor_id,
    descriptor.trust.digest,
  ]));
  for (const packPath of referencePackPaths) {
    const pack = await json(packPath);
    try {
      assertValidReferenceIntegrationPack(pack);
    } catch {
      throw new Error(`p1_pack_invalid: ${packPath}`);
    }
    for (const implementation of pack.implementations) {
      for (const reference of implementation.executor_descriptors) {
        if (descriptorDigests.get(reference.id) !== reference.digest) {
          throw new Error(
            `p1_pack_executor_binding_invalid: ${pack.pack_id}:${implementation.implementation_id}`,
          );
        }
      }
    }
  }
  const commandMatrices = await Promise.all(phase1CommandPaths.map((file) => json(file)));
  if (commandMatrices.some((matrix) =>
    JSON.stringify(matrix) !== JSON.stringify(commandMatrices[0]))) {
    throw new Error("p1_command_matrix_drift: canonical, Codex, and Claude commands differ");
  }
  const allowedOperations = ["architect", "plan", "handoff", "verify"];
  if (
    commandMatrices[0].format !== "launchrally-phase-1-command-examples"
    || commandMatrices[0].version !== 1
    || JSON.stringify(commandMatrices[0].commands.map(({ operation }) => operation))
      !== JSON.stringify(allowedOperations)
    || commandMatrices[0].commands.some(({ operation, argv, expected }) =>
      argv?.[0] !== operation
      || !argv.includes("--json")
      || expected?.status === "execution_error")
  ) throw new Error("p1_command_matrix_invalid: public commands expand unreviewed authority");
}

async function validateRelease() {
  const rootPackage = await json("package.json");
  const release = await json("release/artifacts.json");
  const version = rootPackage.version;
  await validateProviderToolAuthority();
  await validateP1SupplyChain();
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
    if (
      packageJson.name === "@launchrally/cli"
      && packageJson.dependencies?.["@clack/prompts"] !== "1.7.0"
    ) {
      throw new Error(
        `release_ui_dependency_drift: @clack/prompts declares ${packageJson.dependencies?.["@clack/prompts"] ?? "missing"}; expected 1.7.0`,
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
