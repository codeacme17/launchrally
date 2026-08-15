import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertValidExecutorDescriptor,
  assertValidProviderDecisionCard,
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
const referencePackDigests = new Map([
  ["packages/core/reference-integration-packs/v1/backup-to-restore.json", "sha256:d32ee63f2d872e3830292263431b9ca6a8bb057f637427ba58c9f0a2542b4ed4"],
  ["packages/core/reference-integration-packs/v1/email-to-domain-delivery.json", "sha256:310a3a0ca43c8676c2dbe74ed91ac820c31aff748327676c22ab454e2c6889b8"],
  ["packages/core/reference-integration-packs/v1/identity-to-application-data.json", "sha256:6003d0b88d90ae80916d51dd7582081a8939e489e172c2ca5807939e3dc58a31"],
  ["packages/core/reference-integration-packs/v1/payment-to-entitlement.json", "sha256:71fbacf678b217a621bce50e093fcbd0fb81c618315db5e9a2f1f36e8bb67455"],
  ["packages/core/reference-integration-packs/v1/queue-background-work.json", "sha256:b5077096d94d4c59764ce4690e5b14f00e813a1dfd9459fec7584d2f5ee32b7a"],
  ["packages/core/reference-integration-packs/v1/release-to-observability.json", "sha256:b32d4fb94e9d696ba9f93602335db3d649a5e9ce82ab951fbe06d29c84fb55f4"],
  ["packages/core/reference-integration-packs/v1/source-to-ci-cd-to-deployment.json", "sha256:73965e0d195f85aa9996bf68d261c610ac754241328ff61a1d74c6f42957e81f"],
  ["packages/core/reference-integration-packs/v1/storage-to-metadata-access.json", "sha256:e9726d2ee0db5c2115fbe5124c5e9f15a833befef4e55a44e765ececb542801a"],
]);
const referencePackRegistrySource = Object.freeze({
  path: "packages/core/src/reference-integration-packs.js",
  digest: "sha256:75b0bc14f314175743bae07955da0b544db3fa66cde6f02ace864efc1f227617",
});
const phase1CommandPaths = [
  "skills/launchrally/references/phase-1-command-examples.json",
  "adapters/claude/launchrally/skills/launchrally/references/phase-1-command-examples.json",
  "adapters/codex/launchrally/skills/launchrally/references/phase-1-command-examples.json",
];
const phase1CommandAuthority = Object.freeze({
  architect: {
    argv: [
      "architect",
      "--json",
      "--cwd",
      "./app",
      "--review-date",
      "2026-08-14",
      "--report",
      "./launchrally-current-report.json",
      "--intent",
      "./product-intent.json",
      "--catalog",
      "./capability-catalog.json",
      "--graph",
      "./capability-graph.json",
      "--integrations",
      "./integration-contracts.json",
    ],
    expected: {
      contract: "launchrally.dev/architect-interaction/v1",
      status: "needs_confirmation",
      state: "blueprint_review",
    },
  },
  plan: {
    argv: [
      "plan",
      "--json",
      "--cwd",
      "./app",
      "--report",
      "./launchrally-current-report.json",
      "--architecture-package",
      "./architecture-package.json",
    ],
    expected: { contract: "launchrally.dev/cli/v2", status: "completed", state: null },
  },
  handoff: {
    argv: [
      "handoff",
      "--json",
      "--task-graph",
      "./task-graph.json",
      "--executors",
      "./executor-descriptors.json",
      "--tools",
      "./tool-observations.json",
      "--reviewed-executors",
      "./reviewed-executors.json",
    ],
    expected: {
      contract: "launchrally.dev/handoff-interaction/v1",
      status: "needs_input",
      state: "executor_discovery",
    },
  },
  verify: {
    argv: [
      "verify",
      "--json",
      "--cwd",
      "./app",
      "--report",
      "./launchrally-manifest-source-report.json",
      "--scope",
      "full",
    ],
    expected: {
      contract: "launchrally.dev/cli/v2",
      status: "needs_permission",
      state: null,
    },
    success_continuation: {
      posix: "rally verify --json --cwd ./app \\\n  --resume <verify-token> \\\n  --permissions '{\"public_verification\":\"denied\"}'",
      powershell: "$permissions = '{\\\"public_verification\\\":\\\"denied\\\"}'\nrally verify --json --cwd ./app `\n  --resume <verify-token> `\n  --permissions $permissions",
      expected: { contract: "launchrally.dev/cli/v2", status: "completed" },
    },
  },
});
const providerCardSources = new Map([
  ["packages/core/provider-decision-cards/v1/cloudflare-workers.json", {
    digest: "sha256:f8d8339e2eda0450ed777963a08897910ec91f9c56369e522f03b0873ad68f06",
    urls: [
      "https://developers.cloudflare.com/workers/",
      "https://developers.cloudflare.com/pages/framework-guides/",
      "https://developers.cloudflare.com/workers/platform/pricing/",
      "https://developers.cloudflare.com/workers/platform/limits/",
    ],
  }],
  ["packages/core/provider-decision-cards/v1/vercel.json", {
    digest: "sha256:7af45433e5addaa8fa623f7df763c60724987db95501b0dc49bccea6420a25ae",
    urls: [
      "https://vercel.com/docs",
      "https://vercel.com/docs/functions",
      "https://vercel.com/docs/pricing",
      "https://vercel.com/docs/limits",
    ],
  }],
]);
const referenceExecutorSourceDigest =
  "sha256:65a5df811cdf1b40de124ab084d64505f2f65976fb608a2076ece63dba28ccb7";
const referenceExecutorSourcePath = "packages/core/src/reference-executors.js";
const providerCardRegistrySource = Object.freeze({
  path: "packages/core/src/provider-decision-cards.js",
  digest: "sha256:1d5698a0ecde3b39012386f3d7333d9113a61706fb07185a727a6820047672f7",
});
const providerKnowledgeSource = Object.freeze({
  path: "packages/core/src/provider-knowledge.js",
  digest: "sha256:c529a4f847c7ed83e84378dda5a69873aa1dd9f0b5b7cb2b7c094c3c839045ec",
});
const executorInstallationAuthorityDigest =
  "sha256:e508f1a50928c5900f0b4e6a501902be84dcc65da95d3c95270eaa4a90b7aaa6";

async function json(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

async function fileDigest(relativePath) {
  const content = await readFile(path.join(root, relativePath));
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function assertEqualVersion(actual, expected, source) {
  if (actual !== expected) {
    throw new Error(`release_version_drift: ${source} declares ${actual ?? "no version"}; expected ${expected}`);
  }
}

function documentedArguments(command) {
  return command
    .replaceAll("\\\n", " ")
    .replaceAll("`\n", " ")
    .trim()
    .split(/\s+/u)
    .slice(1);
}

function assertCurrentSupplyChainRecord(owner, reviewedAt, expiresAt, assessmentAt) {
  const reviewed = Date.parse(reviewedAt);
  const expires = Date.parse(expiresAt);
  const assessment = Date.parse(assessmentAt);
  if (
    !Number.isFinite(reviewed)
    || !Number.isFinite(expires)
    || !Number.isFinite(assessment)
    || reviewed > assessment
    || assessment >= expires
  ) throw new Error(`p1_supply_chain_stale: ${owner}`);
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

async function validateP1SupplyChain(rootPackage, p1Contract) {
  const assessmentAt = p1Contract.supply_chain_assessment_at;
  const currentAssessmentAt = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  if (assessmentAt !== currentAssessmentAt) {
    throw new Error(
      `p1_supply_chain_assessment_stale: release/p1.json declares ${assessmentAt}; expected ${currentAssessmentAt}`,
    );
  }
  assertValidProviderKnowledge(CORE_PROVIDER_KNOWLEDGE);
  assertCurrentSupplyChainRecord(
    "Core Provider Knowledge",
    CORE_PROVIDER_KNOWLEDGE.review.reviewed_at,
    CORE_PROVIDER_KNOWLEDGE.review.expires_at,
    assessmentAt,
  );
  const providerCardDirectory = "packages/core/provider-decision-cards/v1";
  const packagedCardPaths = (await readdir(path.join(root, providerCardDirectory)))
    .filter((file) => file.endsWith(".json"))
    .map((file) => `${providerCardDirectory}/${file}`)
    .sort();
  const reviewedCardPaths = [...providerCardSources.keys()].sort();
  if (JSON.stringify(packagedCardPaths) !== JSON.stringify(reviewedCardPaths)) {
    throw new Error("p1_provider_card_registry_invalid: unexpected packaged Card roster");
  }
  for (const source of [providerCardRegistrySource, providerKnowledgeSource]) {
    if (await fileDigest(source.path) !== source.digest) {
      throw new Error(`p1_provider_card_registry_invalid: ${source.path}`);
    }
  }
  for (const [cardPath, reviewed] of providerCardSources) {
    const card = await json(cardPath);
    try {
      assertValidProviderDecisionCard(card);
    } catch {
      throw new Error(`p1_provider_card_invalid: ${cardPath}`);
    }
    if (
      await fileDigest(cardPath) !== reviewed.digest
      || JSON.stringify(card.official_sources.map(({ url }) => url))
        !== JSON.stringify(reviewed.urls)
    ) {
      throw new Error(`p1_provider_card_provenance_invalid: ${cardPath}`);
    }
  }
  if (await fileDigest(referenceExecutorSourcePath) !== referenceExecutorSourceDigest) {
    throw new Error(
      `p1_executor_descriptor_authority_invalid: ${referenceExecutorSourcePath}`,
    );
  }
  const descriptorDigests = new Map(referenceExecutorDescriptors.map((descriptor) => [
    descriptor.descriptor_id,
    descriptor.trust.digest,
  ]));
  const executorAuthority = await json("packages/core/executor-installation/v1/authority.json");
  if (executorAuthority.length !== referenceExecutorDescriptors.length) {
    throw new Error("p1_executor_authority_invalid: unexpected authority count");
  }
  for (const descriptor of referenceExecutorDescriptors) {
    assertValidExecutorDescriptor(descriptor);
    assertCurrentSupplyChainRecord(
      descriptor.descriptor_id,
      descriptor.trust.reviewed_at,
      descriptor.trust.expires_at,
      assessmentAt,
    );
    const tool = descriptor.tools[0];
    const authority = executorAuthority.find(
      ({ authority_id: authorityId }) => authorityId === tool.installation_authority_id,
    );
    const route = authority?.installation_routes?.[0];
    assertCurrentSupplyChainRecord(
      authority?.authority_id ?? descriptor.descriptor_id,
      authority?.reviewed_at,
      authority?.expires_at,
      assessmentAt,
    );
    if (
      descriptor.allowed_effects.length !== 1
      || descriptor.allowed_effects[0] !== "source_write"
      || !descriptor.prohibited_effects.includes("deployment_write")
      || !descriptor.prohibited_effects.includes("provider_configuration_write")
      || authority?.tool_id !== tool.tool_id
      || authority?.executable !== tool.executable
      || authority?.exact_version !== tool.exact_version
      || authority?.package?.exact_version !== tool.exact_version
      || authority?.package?.manager !== "npm"
      || rootPackage.devDependencies?.[authority?.package?.name] !== tool.exact_version
      || JSON.stringify(authority?.supported_platforms) !== JSON.stringify(descriptor.platforms)
      || JSON.stringify(authority?.supported_shells) !== JSON.stringify(["posix", "powershell"])
      || authority?.verification_command?.executable !== tool.executable
      || JSON.stringify(authority?.verification_command?.arguments) !== JSON.stringify(["--version"])
      || authority?.verification_command?.shell !== false
      || authority?.installation_routes?.length !== 1
      || route?.route_id !== "npm_global_exact"
      || JSON.stringify(route?.platforms) !== JSON.stringify(descriptor.platforms)
      || JSON.stringify(route?.shells) !== JSON.stringify(authority?.supported_shells)
      || route?.command?.executable !== "npm"
      || JSON.stringify(route?.command?.arguments) !== JSON.stringify([
        "install",
        "--global",
        `${authority?.package?.name}@${tool.exact_version}`,
      ])
      || route?.command?.shell !== false
    ) throw new Error(`p1_executor_authority_invalid: ${descriptor.descriptor_id}`);
  }
  if (await fileDigest("packages/core/executor-installation/v1/authority.json")
    !== executorInstallationAuthorityDigest) {
    throw new Error("p1_executor_installation_authority_invalid: reviewed file changed");
  }
  const referencePackDirectory = "packages/core/reference-integration-packs/v1";
  const packagedPackPaths = (await readdir(path.join(root, referencePackDirectory)))
    .filter((file) => file.endsWith(".json"))
    .map((file) => `${referencePackDirectory}/${file}`)
    .sort();
  if (
    JSON.stringify(packagedPackPaths) !== JSON.stringify([...referencePackDigests.keys()].sort())
    || await fileDigest(referencePackRegistrySource.path) !== referencePackRegistrySource.digest
  ) throw new Error("p1_pack_registry_invalid: unexpected packaged Pack roster");
  for (const packPath of referencePackPaths) {
    const pack = await json(packPath);
    try {
      assertValidReferenceIntegrationPack(pack);
    } catch {
      throw new Error(`p1_pack_invalid: ${packPath}`);
    }
    assertCurrentSupplyChainRecord(
      pack.pack_id,
      pack.review.reviewed_at,
      pack.review.expires_at,
      assessmentAt,
    );
    for (const implementation of pack.implementations) {
      for (const reference of implementation.executor_descriptors) {
        if (descriptorDigests.get(reference.id) !== reference.digest) {
          throw new Error(
            `p1_pack_executor_binding_invalid: ${pack.pack_id}:${implementation.implementation_id}`,
          );
        }
      }
    }
    if (await fileDigest(packPath) !== referencePackDigests.get(packPath)) {
      throw new Error(`p1_pack_authority_invalid: ${packPath}`);
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
    || commandMatrices[0].commands.some((command) => {
      const reviewed = phase1CommandAuthority[command.operation];
      return !reviewed
        || JSON.stringify(command.argv) !== JSON.stringify(reviewed.argv)
        || JSON.stringify(documentedArguments(command.posix ?? ""))
          !== JSON.stringify(reviewed.argv)
        || JSON.stringify(documentedArguments(command.powershell ?? ""))
          !== JSON.stringify(reviewed.argv)
        || JSON.stringify(command.expected) !== JSON.stringify(reviewed.expected)
        || JSON.stringify(command.success_continuation ?? null)
          !== JSON.stringify(reviewed.success_continuation ?? null);
    })
  ) throw new Error("p1_command_matrix_invalid: public commands expand unreviewed authority");
}

async function validateRelease() {
  const rootPackage = await json("package.json");
  const release = await json("release/artifacts.json");
  const p1Contract = await json("release/p1.json");
  const version = rootPackage.version;
  await validateProviderToolAuthority();
  await validateP1SupplyChain(rootPackage, p1Contract);
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
