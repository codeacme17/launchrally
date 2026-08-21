import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { computeReferenceIntegrationPackDigest } from "@launchrally/contracts";
import { copyRepositoryFixture } from "./helpers/repository-fixture.js";
import { createIsolatedNativeEnvironment } from "../scripts/native-environment.mjs";
import { hasClaudeInstalledPlugin } from "../scripts/native-plugin-state.mjs";
import { assertNoConsumerInstallScripts } from "../scripts/release-artifact-policy.mjs";
import {
  verifyExperimentalCandidateBindings,
  verifyPublishedExperimentalRelease,
} from "../scripts/verify-experimental-release.mjs";
import {
  createExternalHostEnvelope,
  createExternalReviewTemplate,
  verifyExternalEvidenceRecord,
  verifyExternalEvidenceWithGitHub,
  verifyExternalPhase1Results,
} from "../scripts/verify-p1-external-results.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const releaseManifest = JSON.parse(await readFile(
  path.join(root, "release/artifacts.json"),
  "utf8",
));
const currentVersion = JSON.parse(await readFile(
  path.join(root, "package.json"),
  "utf8",
)).version;
test("Claude public smoke recognizes the installed-list schema", () => {
  const installed = {
    installed: [{
      id: "launchrally@launchrally",
      version: "0.3.2",
      scope: "user",
      enabled: true,
    }],
    available: [],
  };

  assert.equal(
    hasClaudeInstalledPlugin(installed, "launchrally@launchrally", "0.3.2"),
    true,
  );
  assert.equal(
    hasClaudeInstalledPlugin(installed, "launchrally@launchrally", "0.3.1"),
    false,
  );
  assert.equal(hasClaudeInstalledPlugin({
    installed: [{ pluginId: "launchrally@launchrally", version: "0.3.2" }],
  }, "launchrally@launchrally", "0.3.2"), false);
});

test("native Plugin validation forwards only an isolated non-secret environment", () => {
  const environment = createIsolatedNativeEnvironment({
    PATH: "/synthetic/bin",
    GH_PAT: "sentinel-gh-secret",
    DATABASE_URL: "postgres://person:secret@example.com/database",
    NPM_CONFIG_USERCONFIG: "/real/user/npmrc",
    NODE_OPTIONS: "--require=/untrusted/preload.cjs",
    HTTPS_PROXY: "https://person:secret@proxy.example.com",
    NO_PROXY: "127.0.0.1",
  }, {
    home: "/isolated/home",
    codex_home: "/isolated/codex",
    claude_config_dir: "/isolated/claude",
  });

  assert.deepEqual(environment, {
    PATH: "/synthetic/bin",
    NO_PROXY: "127.0.0.1",
    APPDATA: "/isolated/home",
    CLAUDE_CONFIG_DIR: "/isolated/claude",
    CODEX_HOME: "/isolated/codex",
    HOME: "/isolated/home",
    LOCALAPPDATA: "/isolated/home",
    NODE_OPTIONS: "",
    USERPROFILE: "/isolated/home",
    XDG_CACHE_HOME: "/isolated/home",
    XDG_CONFIG_HOME: "/isolated/home",
  });
});

async function createReleaseFixture() {
  return copyRepositoryFixture(root, "launchrally-release-", [
    ".agents",
    ".claude-plugin",
    "package.json",
    "package-lock.json",
    "packages",
    "adapters",
    "release",
    "skills",
  ]);
}

async function assertReleaseValidationFailure(fixture, pattern) {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-release.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, pattern);
      return true;
    },
  );
}

async function createStablePromotionFixture() {
  const fixture = await copyRepositoryFixture(root, "launchrally-stable-promotion-", [
    ".agents",
    ".claude-plugin",
    ".github",
    "CONTRIBUTING.md",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "adapters",
    "docs",
    "package.json",
    "package-lock.json",
    "packages",
    "release",
    "scripts",
    "skills",
    "test",
  ]);
  const contractPath = path.join(fixture, "release/p0.json");
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  contract.stable_promotion.approved_tag = `v${currentVersion}`;
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  return fixture;
}

async function createStablePromotionCommandStubs() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-stable-commands-"));
  const logPath = path.join(directory, "calls.jsonl");
  for (const command of ["npm", "gh"]) {
    const scriptPath = path.join(directory, `${command}-stub.cjs`);
    await writeFile(scriptPath, `
const fs = require("node:fs");
const command = ${JSON.stringify(command)};
const args = process.argv.slice(2);
fs.appendFileSync(
  process.env.STABLE_PROMOTION_STUB_LOG,
  JSON.stringify({ command, arguments: args }) + "\\n",
);
if (command === "npm" && args[0] === "view") {
  const existing = (process.env.STABLE_PROMOTION_EXISTING || "").split(",").filter(Boolean);
  if (existing.includes("all") || existing.includes(args[1])) {
    process.stdout.write(JSON.stringify(args[1].slice(args[1].lastIndexOf("@") + 1)));
    process.exit(0);
  }
  process.stderr.write("npm error code E404\\n");
  process.exit(1);
}
if (command === "gh" && args[0] === "release" && args[1] === "view") {
  if (process.env.STABLE_PROMOTION_GITHUB_RELEASE === "existing") {
    process.stdout.write(JSON.stringify({ isDraft: false, isPrerelease: false }));
    process.exit(0);
  }
  process.stderr.write("release not found\\n");
  process.exit(1);
}
if (
  command === "gh"
  && args[0] === "release"
  && args[1] === "create"
  && process.env.STABLE_PROMOTION_GITHUB_RELEASE === "existing"
) {
  process.stderr.write("release already exists\\n");
  process.exit(1);
}
`);
    if (process.platform === "win32") {
      await writeFile(
        path.join(directory, `${command}.cmd`),
        `@echo off\r\n"${process.execPath}" "%~dp0${command}-stub.cjs" %*\r\n`,
      );
    } else {
      const executable = path.join(directory, command);
      await writeFile(
        executable,
        `#!/usr/bin/env node\n${await readFile(scriptPath, "utf8")}`,
      );
      await chmod(executable, 0o755);
    }
  }
  return { directory, logPath };
}

test("release validation proves one SemVer across CLI, Plugins, and bundled Skills", async () => {
  const { stdout } = await execFileAsync(
    "npm",
    ["--silent", "run", "validate:release", "--", "--json"],
    { cwd: root },
  );
  const result = JSON.parse(stdout);

  assert.deepEqual(result, {
    status: "completed",
    version: currentVersion,
    packages: [
      "@launchrally/claude-plugin",
      "@launchrally/cli",
      "@launchrally/codex-plugin",
      "@launchrally/contracts",
      "@launchrally/core",
    ],
    plugin_manifests: ["claude", "codex"],
    skill_contracts: ["canonical", "claude", "codex"],
  });
});

test("release validation fails when a Plugin version drifts", async () => {
  const fixture = await createReleaseFixture();
  const manifestPath = path.join(
    fixture,
    "adapters/codex/launchrally/.codex-plugin/plugin.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = "0.3.1";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-release.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /release_version_drift/u);
      assert.match(error.stderr, new RegExp(
        `plugin\\.json declares 0\\.3\\.1; expected ${currentVersion.replaceAll(".", "\\.")}`,
        "u",
      ));
      return true;
    },
  );

});

test("release validation fails when a bundled Skill command drifts", async () => {
  const fixture = await createReleaseFixture();
  const skillPath = path.join(fixture, "skills/launchrally/SKILL.md");
  const skill = await readFile(skillPath, "utf8");
  await writeFile(
    skillPath,
    skill.replace(`@launchrally/cli@${currentVersion}`, "@launchrally/cli@0.3.1"),
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-release.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /skill_contract_version_drift/u);
      assert.match(error.stderr, /SKILL\.md/u);
      return true;
    },
  );

});

test("release validation rejects missing Provider sources and non-exact versions", async () => {
  const authorityPath = "packages/core/provider-tool-installation/v1/authority.json";
  const missingSourceFixture = await createReleaseFixture();
  const missingSourcePath = path.join(missingSourceFixture, authorityPath);
  const missingSource = JSON.parse(await readFile(missingSourcePath, "utf8"));
  missingSource[0].official_source.url = "";
  await writeFile(missingSourcePath, `${JSON.stringify(missingSource, null, 2)}\n`);
  await assertReleaseValidationFailure(
    missingSourceFixture,
    /provider_tool_authority_invalid: clerk has no reviewed official source/u,
  );

  const floatingVersionFixture = await createReleaseFixture();
  const floatingVersionPath = path.join(floatingVersionFixture, authorityPath);
  const floatingVersion = JSON.parse(await readFile(floatingVersionPath, "utf8"));
  floatingVersion[0].package.exact_version = "latest";
  await writeFile(floatingVersionPath, `${JSON.stringify(floatingVersion, null, 2)}\n`);
  await assertReleaseValidationFailure(
    floatingVersionFixture,
    /provider_tool_authority_invalid: clerk must pin an exact supported version/u,
  );
});

test("release validation binds each Provider to its reviewed source and package identity", async () => {
  const authorityPath = "packages/core/provider-tool-installation/v1/authority.json";
  const fixture = await createReleaseFixture();
  const fixturePath = path.join(fixture, authorityPath);
  const authority = JSON.parse(await readFile(fixturePath, "utf8"));
  authority[0].official_source.url = "https://vercel.com/docs/cli";
  authority[0].package.name = "vercel";
  await writeFile(fixturePath, `${JSON.stringify(authority, null, 2)}\n`);

  await assertReleaseValidationFailure(
    fixture,
    /provider_tool_authority_invalid: clerk identity drifted from its reviewed source and Adapter/u,
  );
});

test("release validation rejects floating commands and unsupported platform claims", async () => {
  const authorityPath = "packages/core/provider-tool-installation/v1/authority.json";
  const floatingCommandFixture = await createReleaseFixture();
  const floatingCommandPath = path.join(floatingCommandFixture, authorityPath);
  const floatingCommand = JSON.parse(await readFile(floatingCommandPath, "utf8"));
  floatingCommand[0].installation_routes[0].command.arguments[2] = "clerk@latest";
  await writeFile(floatingCommandPath, `${JSON.stringify(floatingCommand, null, 2)}\n`);
  await assertReleaseValidationFailure(
    floatingCommandFixture,
    /provider_tool_authority_invalid: clerk has an unreviewed or floating installation command/u,
  );

  const platformFixture = await createReleaseFixture();
  const platformPath = path.join(platformFixture, authorityPath);
  const platformAuthority = JSON.parse(await readFile(platformPath, "utf8"));
  platformAuthority[2].installation_routes[0].platforms.push("freebsd");
  await writeFile(platformPath, `${JSON.stringify(platformAuthority, null, 2)}\n`);
  await assertReleaseValidationFailure(
    platformFixture,
    /provider_tool_authority_invalid: neon claims an unsupported platform or shell/u,
  );
});

test("release validation rejects a stale generated Provider recovery route", async () => {
  const fixture = await createReleaseFixture();
  const recoveryPath = path.join(
    fixture,
    "adapters/codex/launchrally/skills/launchrally/references/provider-tool-recovery.md",
  );
  await writeFile(recoveryPath, `${await readFile(recoveryPath, "utf8")}\nstale\n`);
  await assertReleaseValidationFailure(
    fixture,
    /provider_tool_recovery_skill_drift/u,
  );
});

test("release validation rejects untrusted Pack Executor bindings and authority expansion", async () => {
  const packFixture = await createReleaseFixture();
  const packPath = path.join(
    packFixture,
    "packages/core/reference-integration-packs/v1/identity-to-application-data.json",
  );
  const pack = JSON.parse(await readFile(packPath, "utf8"));
  pack.implementations[0].executor_descriptors[0].digest = `sha256:${"0".repeat(64)}`;
  pack.pack_digest = computeReferenceIntegrationPackDigest(pack);
  await writeFile(packPath, `${JSON.stringify(pack, null, 2)}\n`);
  await assertReleaseValidationFailure(
    packFixture,
    /p1_pack_executor_binding_invalid/u,
  );

  const cardFixture = await createReleaseFixture();
  const cardPath = path.join(
    cardFixture,
    "packages/core/provider-decision-cards/v1/vercel.json",
  );
  const card = JSON.parse(await readFile(cardPath, "utf8"));
  card.official_sources[0].url = "https://example.com/unreviewed";
  await writeFile(cardPath, `${JSON.stringify(card, null, 2)}\n`);
  await assertReleaseValidationFailure(cardFixture, /p1_provider_card_provenance_invalid/u);

  const sameHostCardFixture = await createReleaseFixture();
  const sameHostCardPath = path.join(
    sameHostCardFixture,
    "packages/core/provider-decision-cards/v1/vercel.json",
  );
  const sameHostCard = JSON.parse(await readFile(sameHostCardPath, "utf8"));
  sameHostCard.official_sources[0].url = "https://vercel.com/unreviewed";
  await writeFile(sameHostCardPath, `${JSON.stringify(sameHostCard, null, 2)}\n`);
  await assertReleaseValidationFailure(
    sameHostCardFixture,
    /p1_provider_card_provenance_invalid/u,
  );

  const extraCardFixture = await createReleaseFixture();
  const extraCardSourcePath = path.join(
    extraCardFixture,
    "packages/core/provider-decision-cards/v1/vercel.json",
  );
  const extraCard = JSON.parse(await readFile(extraCardSourcePath, "utf8"));
  extraCard.card_id = "managed-web-delivery.unreviewed";
  extraCard.provider.id = "unreviewed";
  extraCard.provider.display_name = "Unreviewed";
  await writeFile(
    path.join(extraCardFixture, "packages/core/provider-decision-cards/v1/unreviewed.json"),
    `${JSON.stringify(extraCard, null, 2)}\n`,
  );
  await assertReleaseValidationFailure(
    extraCardFixture,
    /p1_provider_card_registry_invalid/u,
  );

  const descriptorFixture = await createReleaseFixture();
  const descriptorPath = path.join(
    descriptorFixture,
    "packages/core/src/reference-executors.js",
  );
  const descriptorSource = await readFile(descriptorPath, "utf8");
  await writeFile(
    descriptorPath,
    descriptorSource.replace('      "credential_persistence",\n', ""),
  );
  await assertReleaseValidationFailure(
    descriptorFixture,
    /p1_executor_descriptor_authority_invalid/u,
  );

  const staleAuthorityFixture = await createReleaseFixture();
  const staleAuthorityPath = path.join(
    staleAuthorityFixture,
    "packages/core/executor-installation/v1/authority.json",
  );
  const staleAuthority = JSON.parse(await readFile(staleAuthorityPath, "utf8"));
  staleAuthority[0].expires_at = "2026-08-14";
  await writeFile(staleAuthorityPath, `${JSON.stringify(staleAuthority, null, 2)}\n`);
  await assertReleaseValidationFailure(staleAuthorityFixture, /p1_supply_chain_stale/u);

  const authoritySourceFixture = await createReleaseFixture();
  const authoritySourcePath = path.join(
    authoritySourceFixture,
    "packages/core/executor-installation/v1/authority.json",
  );
  const authoritySource = JSON.parse(await readFile(authoritySourcePath, "utf8"));
  authoritySource[0].official_source.title = "Unreviewed source title";
  await writeFile(authoritySourcePath, `${JSON.stringify(authoritySource, null, 2)}\n`);
  await assertReleaseValidationFailure(
    authoritySourceFixture,
    /p1_executor_installation_authority_invalid/u,
  );

  const semanticPackFixture = await createReleaseFixture();
  const semanticPackPath = path.join(
    semanticPackFixture,
    "packages/core/reference-integration-packs/v1/identity-to-application-data.json",
  );
  const semanticPack = JSON.parse(await readFile(semanticPackPath, "utf8"));
  semanticPack.implementations[0].official_sources[0].title = "Unreviewed semantic change";
  semanticPack.pack_digest = computeReferenceIntegrationPackDigest(semanticPack);
  await writeFile(semanticPackPath, `${JSON.stringify(semanticPack, null, 2)}\n`);
  await assertReleaseValidationFailure(semanticPackFixture, /p1_pack_authority_invalid/u);

  const extraPackFixture = await createReleaseFixture();
  const reviewedPackPath = path.join(
    extraPackFixture,
    "packages/core/reference-integration-packs/v1/identity-to-application-data.json",
  );
  await writeFile(
    path.join(
      extraPackFixture,
      "packages/core/reference-integration-packs/v1/unreviewed-extra-pack.json",
    ),
    await readFile(reviewedPackPath, "utf8"),
  );
  await assertReleaseValidationFailure(extraPackFixture, /p1_pack_registry_invalid/u);

  const historicalAssessmentFixture = await createReleaseFixture();
  const historicalAssessmentPath = path.join(
    historicalAssessmentFixture,
    "release/p1.json",
  );
  const historicalAssessment = JSON.parse(await readFile(historicalAssessmentPath, "utf8"));
  historicalAssessment.supply_chain_assessment_at = "2026-08-13T00:00:00.000Z";
  await writeFile(
    historicalAssessmentPath,
    `${JSON.stringify(historicalAssessment, null, 2)}\n`,
  );
  await assertReleaseValidationFailure(
    historicalAssessmentFixture,
    /p1_supply_chain_assessment_stale/u,
  );

  const executorFixture = await createReleaseFixture();
  const executorPath = path.join(
    executorFixture,
    "packages/core/executor-installation/v1/authority.json",
  );
  const executorAuthority = JSON.parse(await readFile(executorPath, "utf8"));
  executorAuthority[0].exact_version = "0.148.0";
  await writeFile(executorPath, `${JSON.stringify(executorAuthority, null, 2)}\n`);
  await assertReleaseValidationFailure(executorFixture, /p1_executor_authority_invalid/u);

  const missingRouteFixture = await createReleaseFixture();
  const missingRoutePath = path.join(
    missingRouteFixture,
    "packages/core/executor-installation/v1/authority.json",
  );
  const missingRouteAuthority = JSON.parse(await readFile(missingRoutePath, "utf8"));
  missingRouteAuthority[0].installation_routes = [];
  await writeFile(
    missingRoutePath,
    `${JSON.stringify(missingRouteAuthority, null, 2)}\n`,
  );
  await assertReleaseValidationFailure(missingRouteFixture, /p1_executor_authority_invalid/u);

  const expandedRouteFixture = await createReleaseFixture();
  const expandedRoutePath = path.join(
    expandedRouteFixture,
    "packages/core/executor-installation/v1/authority.json",
  );
  const expandedRouteAuthority = JSON.parse(await readFile(expandedRoutePath, "utf8"));
  expandedRouteAuthority[0].installation_routes[0].command.arguments = [
    "install",
    "--global",
    "--ignore-scripts=false",
    "@openai/codex@0.147.0",
  ];
  await writeFile(
    expandedRoutePath,
    `${JSON.stringify(expandedRouteAuthority, null, 2)}\n`,
  );
  await assertReleaseValidationFailure(expandedRouteFixture, /p1_executor_authority_invalid/u);

  const commandFixture = await createReleaseFixture();
  const commandPath = path.join(
    commandFixture,
    "adapters/codex/launchrally/skills/launchrally/references/phase-1-command-examples.json",
  );
  const commands = JSON.parse(await readFile(commandPath, "utf8"));
  commands.commands[0].argv.push("--hidden-authority");
  await writeFile(commandPath, `${JSON.stringify(commands, null, 2)}\n`);
  await assertReleaseValidationFailure(commandFixture, /p1_command_matrix_drift/u);

  const expandedCommandFixture = await createReleaseFixture();
  for (const relativePath of [
    "skills/launchrally/references/phase-1-command-examples.json",
    "adapters/claude/launchrally/skills/launchrally/references/phase-1-command-examples.json",
    "adapters/codex/launchrally/skills/launchrally/references/phase-1-command-examples.json",
  ]) {
    const expandedCommandPath = path.join(expandedCommandFixture, relativePath);
    const expandedCommands = JSON.parse(await readFile(expandedCommandPath, "utf8"));
    expandedCommands.commands[0].argv.push("--hidden-authority");
    expandedCommands.commands[0].posix += " --hidden-authority";
    expandedCommands.commands[0].powershell += " --hidden-authority";
    await writeFile(
      expandedCommandPath,
      `${JSON.stringify(expandedCommands, null, 2)}\n`,
    );
  }
  await assertReleaseValidationFailure(
    expandedCommandFixture,
    /p1_command_matrix_invalid/u,
  );
});

test("release validation synchronizes CRLF Skill checkouts", async () => {
  const fixture = await copyRepositoryFixture(root, "launchrally-crlf-skill-", [
    "adapters",
    "scripts/sync-skills.mjs",
    "skills",
  ]);
  const sourceSkillPath = path.join(fixture, "skills/launchrally/SKILL.md");
  const sourceSkill = await readFile(sourceSkillPath, "utf8");
  await writeFile(sourceSkillPath, sourceSkill.replace(/\r?\n/gu, "\r\n"), "utf8");
  await execFileAsync("git", ["init", "--quiet"], { cwd: fixture });
  await execFileAsync("git", ["config", "core.autocrlf", "true"], { cwd: fixture });
  await execFileAsync("git", ["add", "adapters", "scripts", "skills"], { cwd: fixture });
  await execFileAsync("git", [
    "-c",
    "user.name=LaunchRally Tests",
    "-c",
    "user.email=tests@launchrally.dev",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ], { cwd: fixture });

  await execFileAsync(process.execPath, ["scripts/sync-skills.mjs"], { cwd: fixture });
  await execFileAsync(process.execPath, ["scripts/sync-skills.mjs", "--check"], {
    cwd: fixture,
  });

  const claudeSkill = await readFile(
    path.join(fixture, "adapters/claude/launchrally/skills/launchrally/SKILL.md"),
    "utf8",
  );
  assert.match(claudeSkill, /disable-model-invocation: true\r\n/u);
  assert.equal(claudeSkill.replaceAll("\r\n", "").includes("\n"), false);
  await execFileAsync("git", ["diff", "--exit-code", "--", "adapters"], {
    cwd: fixture,
  });
});

test("release validation rejects lifecycle scripts in a public artifact", async () => {
  const fixture = await createReleaseFixture();
  const packagePath = path.join(fixture, "packages/cli/package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.scripts = { install: "node install.js" };
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-release.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /forbidden_lifecycle_script/u);
      assert.match(error.stderr, /@launchrally\/cli.*install/u);
      return true;
    },
  );
});

test("release artifact policy rejects consumer dependencies with install lifecycle scripts", () => {
  assert.doesNotThrow(() => assertNoConsumerInstallScripts({
    packages: {
      "": { name: "consumer" },
      "node_modules/safe-runtime": { version: "1.0.0" },
    },
  }));
  assert.throws(
    () => assertNoConsumerInstallScripts({
      packages: {
        "": { name: "consumer" },
        "node_modules/unsafe-runtime": { version: "1.0.0", hasInstallScript: true },
      },
    }),
    /consumer_install_lifecycle_script: node_modules\/unsafe-runtime/u,
  );
});

test("release validation rejects drift from the exact Human Mode UI dependency", async () => {
  const fixture = await createReleaseFixture();
  const packagePath = path.join(fixture, "packages/cli/package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.dependencies["@clack/prompts"] = "^1.7.0";
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-release.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /release_ui_dependency_drift/u);
      assert.match(error.stderr, /@clack\/prompts declares \^1\.7\.0; expected 1\.7\.0/u);
      return true;
    },
  );
});

test("npm release packages are public, provenance-enabled, and file-allowlisted", async () => {
  const contracts = releaseManifest.packages.find(
    ({ name }) => name === "@launchrally/contracts",
  );
  assert.ok(contracts.files.includes("schemas/init-interaction/v2.schema.json"));
  assert.ok(contracts.files.includes("schemas/verify-interaction/v2.schema.json"));

  for (const artifact of releaseManifest.packages) {
    const relative = `${artifact.path}/package.json`;
    const packageJson = JSON.parse(await readFile(path.join(root, relative), "utf8"));
    assert.notEqual(packageJson.private, true, relative);
    assert.deepEqual(packageJson.files, artifact.package_files, relative);
    assert.deepEqual(packageJson.publishConfig, {
      access: "public",
      provenance: true,
    }, relative);
    assert.equal(packageJson.repository?.url, "git+https://github.com/codeacme17/launchrally.git");
    for (const [dependency, version] of Object.entries(packageJson.dependencies ?? {})) {
      if (dependency.startsWith("@launchrally/")) {
        assert.equal(version, currentVersion, `${relative}: ${dependency}`);
      }
    }
  }
  const cliPackage = JSON.parse(await readFile(
    path.join(root, "packages/cli/package.json"),
    "utf8",
  ));
  assert.equal(cliPackage.engines.node, ">=20.12.0");
  assert.equal(cliPackage.dependencies["@clack/prompts"], "1.7.0");
});

test("CI and release verification exercise the exact CLI Node runtime floor", async () => {
  const [ci, release, installGuide] = await Promise.all([
    readFile(path.join(root, ".github/workflows/ci.yml"), "utf8"),
    readFile(path.join(root, ".github/workflows/release.yml"), "utf8"),
    readFile(path.join(root, "docs/getting-started/install.md"), "utf8"),
  ]);
  assert.match(ci, /node: \[20\.12\.0, 22, 24\]/u);
  assert.match(release, /node: \[20\.12\.0, 22, 24\]/u);
  assert.match(installGuide, /Node\.js 20\.12\.0 or newer/u);
});

test("Node and OS matrices gate execution authority and platform-safe Launcher behavior", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.match(packageJson.scripts["test:contracts"], /npm run test:authority-contracts/u);
  assert.match(packageJson.scripts["test:journeys"], /npm run test:authority-contracts/u);
  for (const testPath of [
    "test/execution-authority.test.js",
    "test/invocation-context.test.js",
    "test/launcher.test.js",
    "test/toolchain-lifecycle.test.js",
  ]) {
    assert.match(
      packageJson.scripts["test:authority-contracts"],
      new RegExp(testPath.replace(".", "\\.")),
    );
  }
});

test("the default first Audit uses an exact user-managed Launcher with npm-exec as fallback", async () => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const skill = await readFile(path.join(root, "skills/launchrally/SKILL.md"), "utf8");
  const journey = await readFile(
    path.join(root, "skills/launchrally/references/reference-journey.md"),
    "utf8",
  );
  const publicGuidance = [readme, skill, journey].join("\n");
  const skillGuidance = [skill, journey].join("\n");

  assert.match(
    readme,
    /npm install --global @launchrally\/cli@0\.3\.2/u,
  );
  assert.match(readme, /rally --version --json/u);
  assert.match(
    readme,
    /npm exec --package=@launchrally\/cli@0\.3\.2 -- rally audit --plain --cwd \. --output \.\/launchrally-audit-report\.json/u,
  );
  assert.match(publicGuidance, /preserve the package manager's download confirmation/iu);
  assert.match(
    skillGuidance,
    new RegExp(`npm install --global @launchrally/cli@${currentVersion.replaceAll(".", "\\.")}`, "u"),
  );
  assert.match(skillGuidance, /stop before Audit/iu);
  assert.doesNotMatch(publicGuidance, /npm exec[^\n]*--(?:yes|y)\b/u);
  assert.doesNotMatch(publicGuidance, /curl[^\n|]*\|\s*(?:ba)?sh/u);
  assert.doesNotMatch(publicGuidance, /(?:copy|cp)[^\n]*skills?\//iu);
});

test("release validation rejects internal dependency ranges", async () => {
  const fixture = await createReleaseFixture();
  const packagePath = path.join(fixture, "packages/cli/package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.dependencies["@launchrally/core"] = `^${currentVersion}`;
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-release.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /release_dependency_drift/u);
      assert.match(error.stderr, new RegExp(
        `@launchrally/core declares \\^${currentVersion.replaceAll(".", "\\.")}`,
        "u",
      ));
      return true;
    },
  );
});

test("release validation plans exact public CLI and Plugin smoke inputs", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/test-release-artifacts.mjs", "--public", "--dry-run", "--json"],
    { cwd: root },
  );
  const plan = JSON.parse(stdout);
  const exactPackages = releaseManifest.packages.map(({ name }) => `${name}@${currentVersion}`);

  assert.deepEqual(plan, {
    status: "planned",
    source: "public_registry",
    version: currentVersion,
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
    registry_verification: releaseManifest.packages.map(({ name }) => ({
      package: name,
      dist_tag: "experimental",
      expected_version: currentVersion,
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
          `--package=@launchrally/cli@${currentVersion}`,
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
            `@launchrally/cli@${currentVersion}`,
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
        ref: `v${currentVersion}`,
      },
    },
  });
});

test("Stable public smoke verifies the latest dist-tag", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "scripts/test-release-artifacts.mjs",
      "--public",
      "--dist-tag",
      "latest",
      "--dry-run",
      "--json",
    ],
    { cwd: root },
  );
  const plan = JSON.parse(stdout);

  assert.deepEqual(
    plan.registry_verification,
    releaseManifest.packages.map(({ name }) => ({
      package: name,
      dist_tag: "latest",
      expected_version: currentVersion,
    })),
  );
});

test("Stable promotion plans a new coherent version through trusted publishing", async () => {
  const fixture = await createStablePromotionFixture();
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "scripts/promote-stable.mjs",
      "--root",
      fixture,
      "--tag",
      `v${currentVersion}`,
      "--dry-run",
      "--json",
    ],
    { cwd: root },
  );

  assert.deepEqual(JSON.parse(stdout), {
    status: "planned",
    strategy: "new_coherent_version",
    tag: `v${currentVersion}`,
    version: currentVersion,
    packages: releaseManifest.packages.map(({ name }) => name),
    publish: releaseManifest.packages.map(({ name }) => ({
      command: "npm",
      arguments: [
        "publish",
        "--workspace",
        name,
        "--provenance",
        "--access",
        "public",
        "--tag",
        "latest",
      ],
    })),
    smoke: {
      command: "npm",
      arguments: ["run", "test:public-release", "--", "--dist-tag", "latest", "--json"],
    },
    github_release: {
      command: "gh",
      arguments: [
        "release",
        "create",
        `v${currentVersion}`,
        "--verify-tag",
        "--generate-notes",
        "--latest",
        "--title",
        `LaunchRally v${currentVersion}`,
      ],
    },
  });
});

test("Stable promotion rejects every ineligible release state", async () => {
  const cases = [
    {
      name: "product completion",
      file: "release/p0.json",
      mutate: (value) => { value.product_status = "suspended"; },
      blocker: "product_status",
    },
    {
      name: "Stable release approval",
      file: "release/p0.json",
      mutate: (value) => { value.release_status = "experimental"; },
      blocker: "release_status",
    },
    {
      name: "validation status",
      file: "release/p0.json",
      mutate: (value) => { value.validation_status = "collecting"; },
      blocker: "validation_status",
    },
    {
      name: "P0 Validated decision",
      file: "release/p0.json",
      mutate: (value) => { value.p0_validated = false; },
      blocker: "p0_validated",
    },
    {
      name: "Quality Floor",
      file: "release/p0.json",
      mutate: (value) => { value.quality_floor_status = "suspended"; },
      blocker: "quality_floor_status",
    },
    {
      name: "promotion approval",
      file: "release/p0.json",
      mutate: (value) => { value.stable_promotion.status = "not_approved"; },
      blocker: "stable_promotion.status",
    },
    {
      name: "maintainer E2E",
      file: "release/p0.json",
      mutate: (value) => { value.stable_promotion.maintainer_e2e_status = "pending"; },
      blocker: "stable_promotion.maintainer_e2e_status",
    },
    {
      name: "maintainer E2E evidence",
      file: "release/p0.json",
      mutate: (value) => { delete value.stable_promotion.maintainer_e2e_evidence.direct_cli; },
      blocker: "stable_promotion.maintainer_e2e_evidence",
    },
    {
      name: "approved tag",
      file: "release/p0.json",
      mutate: (value) => { value.stable_promotion.approved_tag = "v0.3.1"; },
      blocker: "stable_promotion.approved_tag",
    },
    {
      name: "acceptance completion",
      file: "release/p0-acceptance.json",
      mutate: (value) => { value.requirements[0].status = "open"; },
      blocker: "acceptance.requirements",
    },
  ];

  for (const scenario of cases) {
    const fixture = await createStablePromotionFixture();
    const filePath = path.join(fixture, scenario.file);
    const value = JSON.parse(await readFile(filePath, "utf8"));
    scenario.mutate(value);
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "scripts/promote-stable.mjs",
          "--root",
          fixture,
          "--tag",
          `v${currentVersion}`,
          "--dry-run",
          "--json",
        ],
        { cwd: root },
      ),
      (error) => {
        assert.match(error.stderr, /stable_promotion_blocked/u, scenario.name);
        assert.match(error.stderr, new RegExp(scenario.blocker.replaceAll(".", "\\."), "u"));
        return true;
      },
      scenario.name,
    );
  }
});

test("Stable promotion requires the authoritative five-package release set", async () => {
  const fixture = await createStablePromotionFixture();
  const manifestPath = path.join(fixture, "release/artifacts.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.packages.pop();
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/promote-stable.mjs", "--root", fixture, "--tag", `v${currentVersion}`, "--dry-run"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /stable_promotion_blocked/u);
      assert.match(error.stderr, /release\.packages/u);
      return true;
    },
  );
});

test("Stable promotion rejects a prerelease SemVer", async () => {
  const fixture = await createStablePromotionFixture();
  const packagePath = path.join(fixture, "package.json");
  const contractPath = path.join(fixture, "release/p0.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  packageJson.version = `${currentVersion}-rc.1`;
  contract.stable_promotion.approved_tag = `v${currentVersion}-rc.1`;
  await Promise.all([
    writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`),
    writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`),
  ]);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "scripts/promote-stable.mjs",
        "--root",
        fixture,
        "--tag",
        `v${currentVersion}-rc.1`,
        "--dry-run",
      ],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /stable_promotion\.approved_tag/u);
      return true;
    },
  );
});

test("Stable promotion publishes, verifies, and announces through public commands", async () => {
  const fixture = await createStablePromotionFixture();
  const commands = await createStablePromotionCommandStubs();
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "scripts/promote-stable.mjs",
      "--root",
      fixture,
      "--tag",
      `v${currentVersion}`,
      "--json",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${commands.directory}${path.delimiter}${process.env.PATH ?? ""}`,
        STABLE_PROMOTION_STUB_LOG: commands.logPath,
      },
    },
  );

  assert.deepEqual(JSON.parse(stdout), {
    status: "completed",
    strategy: "new_coherent_version",
    tag: `v${currentVersion}`,
    version: currentVersion,
    publication: "published",
    smoke: "verified",
    github_release: "created",
  });
  const calls = (await readFile(commands.logPath, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(calls, [
    ...releaseManifest.packages.map(({ name }) => ({
      command: "npm",
      arguments: ["view", `${name}@${currentVersion}`, "version", "--json"],
    })),
    ...releaseManifest.packages.map(({ name }) => ({
      command: "npm",
      arguments: [
        "publish",
        "--workspace",
        name,
        "--provenance",
        "--access",
        "public",
        "--tag",
        "latest",
      ],
    })),
    {
      command: "npm",
      arguments: ["run", "test:public-release", "--", "--dist-tag", "latest", "--json"],
    },
    {
      command: "gh",
      arguments: ["release", "view", `v${currentVersion}`, "--json", "isDraft,isPrerelease"],
    },
    {
      command: "gh",
      arguments: [
        "release",
        "create",
        `v${currentVersion}`,
        "--verify-tag",
        "--generate-notes",
        "--latest",
        "--title",
        `LaunchRally v${currentVersion}`,
      ],
    },
  ]);
});

test("Stable promotion resumes only after a coherent publication", async () => {
  const fixture = await createStablePromotionFixture();
  const commands = await createStablePromotionCommandStubs();
  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/promote-stable.mjs", "--root", fixture, "--tag", `v${currentVersion}`, "--json"],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${commands.directory}${path.delimiter}${process.env.PATH ?? ""}`,
        STABLE_PROMOTION_STUB_LOG: commands.logPath,
        STABLE_PROMOTION_EXISTING: "all",
      },
    },
  );
  assert.equal(JSON.parse(stdout).publication, "resumed");
  const calls = (await readFile(commands.logPath, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(calls.filter(({ arguments: arguments_ }) => arguments_[0] === "publish").length, 0);
  assert.deepEqual(calls.slice(-3).map(({ command }) => command), ["npm", "gh", "gh"]);
});

test("Stable promotion rejects a partially published coherent version", async () => {
  const fixture = await createStablePromotionFixture();
  const commands = await createStablePromotionCommandStubs();
  const existing = `${releaseManifest.packages[0].name}@${currentVersion}`;
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/promote-stable.mjs", "--root", fixture, "--tag", `v${currentVersion}`, "--json"],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${commands.directory}${path.delimiter}${process.env.PATH ?? ""}`,
          STABLE_PROMOTION_STUB_LOG: commands.logPath,
          STABLE_PROMOTION_EXISTING: existing,
        },
      },
    ),
    (error) => {
      assert.match(error.stderr, /partial_stable_publication/u);
      assert.match(error.stderr, /new coherent version/iu);
      return true;
    },
  );
  const calls = (await readFile(commands.logPath, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(calls.every(({ arguments: arguments_ }) => arguments_[0] === "view"), true);
});

test("Stable promotion reconciles an existing GitHub release on retry", async () => {
  const fixture = await createStablePromotionFixture();
  const commands = await createStablePromotionCommandStubs();
  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/promote-stable.mjs", "--root", fixture, "--tag", `v${currentVersion}`, "--json"],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${commands.directory}${path.delimiter}${process.env.PATH ?? ""}`,
        STABLE_PROMOTION_STUB_LOG: commands.logPath,
        STABLE_PROMOTION_EXISTING: "all",
        STABLE_PROMOTION_GITHUB_RELEASE: "existing",
      },
    },
  );
  assert.equal(JSON.parse(stdout).github_release, "reconciled");
  const calls = (await readFile(commands.logPath, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(calls.slice(-2), [
    {
      command: "gh",
      arguments: ["release", "view", `v${currentVersion}`, "--json", "isDraft,isPrerelease"],
    },
    {
      command: "gh",
      arguments: [
        "release",
        "edit",
        `v${currentVersion}`,
        "--draft=false",
        "--prerelease=false",
        "--latest",
        "--title",
        `LaunchRally v${currentVersion}`,
      ],
    },
  ]);
});

test("the P1 artifact matrix rejects a CI target that does not match the runtime", async () => {
  const mismatchedTarget = process.platform === "win32"
    ? "linux-node20-posix"
    : "windows-node22-powershell";
  await assert.rejects(
    execFileAsync(process.execPath, [
      "scripts/test-release-artifacts.mjs",
      "--json",
      "--skip-native",
      "--matrix-target",
      mismatchedTarget,
    ], { cwd: root }),
    (error) => /p1_artifact_matrix_target_mismatch/u.test(error.stderr ?? ""),
  );
});

test("release CI runs every exact P1 platform and shell target", async () => {
  const workflows = await Promise.all([
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
  ].map((relativePath) => readFile(path.join(root, relativePath), "utf8")));
  for (const workflow of workflows) {
    for (const target of [
      "linux-node20-posix",
      "linux-node22-posix",
      "linux-node24-posix",
      "macos-node22-posix",
      "windows-node22-powershell",
    ]) assert.match(workflow, new RegExp(`target: ${target}`, "u"));
    assert.match(
      workflow,
      /npm run test:artifacts -- --matrix-target "\$\{\{ matrix\.target \}\}"/u,
    );
  }
});

test("P1 governance binds the completed exact-artifact gate to runtime evidence", async () => {
  const matrix = JSON.parse(await readFile(
    path.join(root, "release/p1-acceptance.json"),
    "utf8",
  ));
  const exact = matrix.release_gates.find(({ id }) => id === "p1_exact_artifacts");
  const external = matrix.release_gates.find(({ id }) => id === "p1_external_verification");
  assert.deepEqual(exact, {
    id: "p1_exact_artifacts",
    command: "test:p1-exact-artifacts",
    mandatory: true,
    status: "complete",
    evidence: {
      type: "test",
      path: "test/release.test.js",
      name: "packed artifacts complete installation, delegation, lifecycle, and full verification journeys",
    },
  });
  assert.deepEqual(external, {
    id: "p1_external_verification",
    command: "test:p1-external",
    mandatory: true,
    status: "pending",
    evidence: {
      type: "script",
      path: "scripts/verify-p1-external-results.mjs",
    },
  });
});

test("packed artifacts complete installation, delegation, lifecycle, and full verification journeys", async () => {
  const { stdout } = await execFileAsync(
    "npm",
    ["--silent", "run", "test:artifacts", "--", "--json"],
    { cwd: root, maxBuffer: 1024 * 1024 * 4 },
  );
  const result = JSON.parse(stdout);

  assert.deepEqual(result, {
    status: "completed",
    version: currentVersion,
    artifacts: [
      "@launchrally/claude-plugin",
      "@launchrally/cli",
      "@launchrally/codex-plugin",
      "@launchrally/contracts",
      "@launchrally/core",
    ],
    artifact_files_verified: true,
    p1_exact_artifacts: {
      result_version: 1,
      matrix_target: {
        platform: process.platform,
        node_major: Number(process.versions.node.split(".")[0]),
        shell: process.platform === "win32" ? "powershell" : "posix",
      },
      public_surfaces: ["claude", "cli", "codex", "contracts", "core", "skill"],
      product_journeys: [
        "astro-hosted-web",
        "custom-self-hosted",
        "fastapi-container",
        "pnpm-edge-monorepo",
        "react-go-split",
      ],
      integration_families: [
        "backup_to_restore",
        "email_to_domain_delivery",
        "identity_to_application_data",
        "payment_to_entitlement",
        "queue_background_work",
        "release_to_observability",
        "source_to_ci_cd_to_deployment",
        "storage_to_metadata_access",
      ],
      integration_fresh_verify: {
        backup_to_restore: "environment_bound_fresh_evidence",
        email_to_domain_delivery: "environment_bound_fresh_evidence",
        identity_to_application_data: "environment_bound_fresh_evidence",
        payment_to_entitlement: "environment_bound_fresh_evidence",
        queue_background_work: "environment_bound_fresh_evidence",
        release_to_observability: "environment_bound_fresh_evidence",
        source_to_ci_cd_to_deployment: "environment_bound_fresh_evidence",
        storage_to_metadata_access: "environment_bound_fresh_evidence",
      },
      host_journeys: ["claude", "codex"],
      native_host_journeys: {
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
      p0_to_p1_migration: {
        adoption: "completed",
        interruption: "rolled_back_and_recovered",
      },
      scenarios: [
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
      ],
      fresh_verify: {
        receipt_claims: "verification_required",
        successful_downstream: process.platform === "win32"
          ? "typed_runner_unavailable"
          : "environment_bound_machine_evidence",
        unsuccessful_downstream: process.platform === "win32"
          ? "typed_runner_unavailable"
          : "environment_bound_no_go",
      },
      clean_host: {
        unauthorized_install: false,
        unauthorized_login: false,
        unauthorized_upload: false,
        unauthorized_write: false,
        manual_secret_transfer: false,
        sensitive_persistence: false,
      },
    },
    cli_smoke: {
      operation: "version",
      cli_version: currentVersion,
      audit_status: "needs_input",
      provider_tool_recovery: "exact_instruction_and_fresh_permission",
      coverage_journeys: [
        "astro-hosted-web",
        "custom-self-hosted",
        "fastapi-container",
        "pnpm-edge-monorepo",
        "react-go-split",
      ],
    },
    installation_journeys: {
      no_launcher: "confirmed",
      npm_exec: "artifact_equivalent_audit_and_follow_up",
      user_prefix: "installed_and_verified",
      project_engine: "initialized_and_delegated",
      fresh_clone: "restored_offline",
      registry_permission: "cache_miss_approved_and_denied",
      invalid_authority: "corruption_failed_closed",
      invalid_authority_cases: [
        "corrupted_lock",
        "descriptor_path_escape",
        "missing_materialization",
        ...(process.platform === "win32" ? [] : ["symlinked_engine_escape"]),
        "unsupported_contract",
        "wrong_installed_version",
      ],
      migration_failure: "pre_adoption_failure_preserved_authority",
      legacy_toolchain: "compatibility_fixture_restored_and_delegated",
      migration_success: "downgrade_and_upgrade_preserved_immutable_history",
      transaction_recovery: "interrupted_migration_recovered",
      full_journey: "plan_handoff_verify_completed",
      packaged_skill_fixtures: "codex_and_claude_executed",
      protected_journeys: "codex_and_claude_audit_verify_normalized",
      human_authenticated_journey: process.platform === "win32"
        ? "typed_runner_unavailable_restricted_file_boundary"
        : "normalized_success_without_sensitive_persistence",
      launcher_removal: "project_data_preserved",
      plugin_removal: "project_data_preserved",
      fixture_invocations: [
        "version",
        "audit_input",
        "audit_confirmation",
        "audit_permission",
        "audit_completed",
        "init_preview",
        "init_completed",
        "project_version",
        "toolchain_clean",
        "toolchain_restore",
        "toolchain_restore_permission",
        "toolchain_restore",
        "toolchain_status",
        "toolchain_restore",
        "project_version",
        "plan_refresh",
        "refresh_permission",
        "refresh_completed",
        "plan",
        "handoff",
        "verify_permission",
        "verify_completed",
      ],
    },
    native_plugins: {
      claude: "installed_discovered_and_removed",
      codex: "installed_discovered_and_removed",
    },
    native_plugin_boundary: {
      configuration_isolated: true,
      sensitive_environment_removed: true,
      scope: "native_plugin_discovery_only",
      agent_execution: "p1_external_verification_required",
    },
  });
});

test("Codex and Claude marketplaces resolve their native Plugin adapters", async () => {
  const codex = JSON.parse(await readFile(
    path.join(root, ".agents/plugins/marketplace.json"),
    "utf8",
  ));
  const claude = JSON.parse(await readFile(
    path.join(root, ".claude-plugin/marketplace.json"),
    "utf8",
  ));

  assert.equal(codex.name, "launchrally");
  assert.deepEqual(codex.plugins.map(({ name, source }) => ({ name, source })), [{
    name: "launchrally",
    source: { source: "local", path: "./adapters/codex/launchrally" },
  }]);
  assert.equal(claude.name, "launchrally");
  assert.deepEqual(claude.plugins.map(({ name, source }) => ({ name, source })), [{
    name: "launchrally",
    source: {
      source: "npm",
      package: "@launchrally/claude-plugin",
      version: currentVersion,
    },
  }]);
});

test("native Plugin validators are exact development dependencies", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(packageJson.devDependencies, {
    "@anthropic-ai/claude-code": "2.1.231",
    "@openai/codex": "0.147.0",
  });
});

test("release validation rejects a stale marketplace package pin", async () => {
  const fixture = await createReleaseFixture();
  const marketplacePath = path.join(fixture, ".claude-plugin/marketplace.json");
  const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
  marketplace.plugins[0].source.version = "0.1.0";
  await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-release.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /release_version_drift/u);
      assert.match(error.stderr, /marketplace\.json declares 0\.1\.0/u);
      return true;
    },
  );
});

test("release docs cover user-scope Plugin install, update, and uninstall", async () => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const guide = await readFile(path.join(root, "docs/getting-started/install.md"), "utf8");

  assert.match(readme, /\[Install and release guide\]\(docs\/getting-started\/install\.md\)/u);
  assert.match(
    guide,
    /codex plugin marketplace add codeacme17\/launchrally --ref v0\.3\.2/u,
  );
  assert.match(guide, /codex plugin add launchrally@launchrally/u);
  assert.match(guide, /codex plugin remove launchrally@launchrally/u);
  assert.match(guide, /codex plugin marketplace remove launchrally/u);
  assert.match(
    guide,
    /claude plugin marketplace add codeacme17\/launchrally --scope user/u,
  );
  assert.match(
    guide,
    /claude plugin install launchrally@launchrally --scope user/u,
  );
  assert.match(
    guide,
    /claude plugin update launchrally@launchrally --scope user/u,
  );
  assert.match(
    guide,
    /claude plugin uninstall launchrally@launchrally --scope user/u,
  );
  assert.match(guide, /Plugin removal preserves project-owned `?\.launchrally/iu);
  assert.match(guide, /npm install --global @launchrally\/cli@0\.3\.2/u);
  assert.doesNotMatch(guide, /sudo npm|npm exec[^\n]*--yes/u);
  assert.doesNotMatch(guide, /curl[^\n|]*\|\s*(?:ba)?sh/u);
  assert.doesNotMatch(guide, /(?:copy|cp)[^\n]*skills?\//iu);
});

test("release docs define the guarded Experimental publication runbook", async () => {
  const runbook = await readFile(path.join(root, "docs/maintainers/release-runbook.md"), "utf8");
  for (const packageName of releaseManifest.packages.map(({ name }) => name)) {
    assert.match(runbook, new RegExp(packageName.replace("/", "\\/"), "u"));
  }
  assert.match(runbook, /npm trust list/iu);
  assert.match(runbook, /codeacme17\/launchrally/u);
  assert.match(runbook, /release\.yml/u);
  assert.match(runbook, /environment `npm`/iu);
  assert.match(runbook, /allowed action `npm publish`/iu);
  assert.match(runbook, /selected tag pattern\s+`v\*\.\*\.\*`/iu);
  assert.match(runbook, /annotated tag/iu);
  assert.match(runbook, /new coherent version/iu);
  assert.match(runbook, /GitHub prerelease[\s\S]*public smoke/iu);
  assert.match(runbook, /package must already exist/iu);
});

test("the P1 announcement and external Agent procedure preserve every lifecycle boundary", async () => {
  const [announcement, procedure] = await Promise.all([
    readFile(
      path.join(root, `docs/maintainers/experimental-${currentVersion}-announcement.md`),
      "utf8",
    ),
    readFile(path.join(root, "docs/maintainers/p1-external-verification.md"), "utf8"),
  ]);

  assert.match(announcement, /Product Incomplete/u);
  assert.match(announcement, /Experimental/u);
  assert.match(announcement, /not P1 Validated/u);
  assert.match(announcement, /not Stable/u);
  assert.match(announcement, /independent external verification/u);
  assert.match(announcement, /Phase 0[\s\S]*0\.3\.2[\s\S]*npm `latest`/u);
  assert.match(procedure, /verify-experimental-release\.mjs --phase published/u);
  assert.match(
    procedure,
    new RegExp(`codex plugin marketplace add[\\s\\S]*--ref v${currentVersion.replaceAll(".", "\\.")}`, "u"),
  );
  assert.match(procedure, /codex -C "\$PHASE1_RELEASE"/u);
  assert.match(
    procedure,
    new RegExp(`claude plugin marketplace add codeacme17/launchrally@v${currentVersion.replaceAll(".", "\\.")} --scope user`, "u"),
  );
  assert.match(procedure, /claude plugin install[\s\S]*--scope user/u);
  assert.match(procedure, /claude "Use the installed LaunchRally Skill/u);
  for (const predicate of [
    "denied_write",
    "missing_executor",
    "partial_receipt",
    "stale_architecture",
    "environment_bound_machine_evidence",
    "environment_bound_no_go",
  ]) assert.match(procedure, new RegExp(predicate, "u"));
  assert.match(procedure, /verify-p1-external-results\.mjs/u);
  assert.match(procedure, /Publication alone leaves all three\s+unchanged/u);
});

test("external Phase 1 results require machine-checked CLI, Codex, and Claude scenario coverage", async () => {
  const externalResult = () => ({
    status: "completed",
    version: currentVersion,
    source: "public_registry",
    exact_packages: [
      `@launchrally/contracts@${currentVersion}`,
      `@launchrally/core@${currentVersion}`,
      `@launchrally/cli@${currentVersion}`,
      `@launchrally/codex-plugin@${currentVersion}`,
      `@launchrally/claude-plugin@${currentVersion}`,
    ],
    cli_smoke: { cli_version: currentVersion },
    installation_journeys: { full_journey: "plan_handoff_verify_completed" },
    p1_exact_artifacts: {
      product_journeys: ["astro-hosted-web"],
      scenarios: [
        "denied_write",
        "missing_executor",
        "partial_receipt",
        "stale_architecture",
      ],
      fresh_verify: {
        receipt_claims: "verification_required",
        successful_downstream: "environment_bound_machine_evidence",
        unsuccessful_downstream: "environment_bound_no_go",
      },
      clean_host: {
        unauthorized_install: false,
        unauthorized_login: false,
        unauthorized_upload: false,
        unauthorized_write: false,
        manual_secret_transfer: false,
        sensitive_persistence: false,
      },
      native_host_journeys: {
        codex: { agent_execution: "p1_external_verification_required" },
        claude: { agent_execution: "p1_external_verification_required" },
      },
    },
  });
  const results = {
    cli: createExternalHostEnvelope({
      host: "cli",
      challenge: "a".repeat(64),
      result: externalResult(),
      version: currentVersion,
      recordedAt: "2026-08-15T01:00:00.000Z",
    }),
    codex: createExternalHostEnvelope({
      host: "codex",
      challenge: "b".repeat(64),
      result: externalResult(),
      version: currentVersion,
      recordedAt: "2026-08-15T01:01:00.000Z",
    }),
    claude: createExternalHostEnvelope({
      host: "claude",
      challenge: "c".repeat(64),
      result: externalResult(),
      version: currentVersion,
      recordedAt: "2026-08-15T01:02:00.000Z",
    }),
  };
  const candidate = {
    version: currentVersion,
    tag: `v${currentVersion}`,
    channel: "experimental",
    packages: [
      "@launchrally/contracts",
      "@launchrally/core",
      "@launchrally/cli",
      "@launchrally/codex-plugin",
      "@launchrally/claude-plugin",
    ].map((name, index) => ({
      name,
      integrity: `sha512-${Buffer.alloc(64, index + 1).toString("base64")}`,
      shasum: String(index + 1).repeat(40),
    })),
  };
  const review = {
    url: "https://github.com/codeacme17/launchrally/issues/141#issuecomment-123456",
    reviewer: "external-reviewer",
    release_actor: "release-actor",
    created_at: "2026-08-15T01:30:00.000Z",
    body: createExternalReviewTemplate({ version: currentVersion, results }),
  };
  const workflow = {
    url: "https://github.com/codeacme17/launchrally/actions/runs/123456",
    actor: "release-actor",
    conclusion: "success",
    event: "push",
    head_branch: `v${currentVersion}`,
    head_sha: "a".repeat(40),
    path: ".github/workflows/release.yml",
  };
  const publicationJobs = ["prerelease", "public-smoke", "publish"].map((name) => ({
    conclusion: "success",
    name,
    status: "completed",
  }));

  const verified = verifyExternalPhase1Results({
    version: currentVersion,
    results,
    workflow,
    releaseUrl: `https://github.com/codeacme17/launchrally/releases/tag/v${currentVersion}`,
    candidate,
    publicationJobs,
    review,
    verifiedAt: "2026-08-15T02:00:00.000Z",
  });
  assert.equal(verified.status, "completed");
  assert.deepEqual(verified.hosts.map(({ host }) => host), ["cli", "codex", "claude"]);
  assert.equal(verifyExternalEvidenceRecord(verified, { candidate }).status, "completed");
  const publicEvidence = {
    "repos/codeacme17/launchrally/issues/comments/123456": {
      issue_url: "https://api.github.com/repos/codeacme17/launchrally/issues/141",
      html_url: review.url,
      user: { login: review.reviewer },
      created_at: review.created_at,
      body: review.body,
    },
    "repos/codeacme17/launchrally/actions/runs/123456": {
      html_url: workflow.url,
      status: "completed",
      actor: { login: workflow.actor },
      conclusion: workflow.conclusion,
      event: workflow.event,
      head_branch: workflow.head_branch,
      head_sha: workflow.head_sha,
      path: workflow.path,
    },
    "repos/codeacme17/launchrally/actions/runs/123456/jobs?per_page=100": {
      jobs: publicationJobs,
    },
    [`repos/codeacme17/launchrally/contents/release/p1-release-candidate.json?ref=${workflow.head_sha}`]: {
      encoding: "base64",
      content: Buffer.from(JSON.stringify(candidate)).toString("base64"),
    },
    [`repos/codeacme17/launchrally/git/ref/tags/v${currentVersion}`]: {
      object: { type: "commit", sha: workflow.head_sha },
    },
  };
  const githubApi = async (endpoint) => publicEvidence[endpoint];
  assert.equal((await verifyExternalEvidenceWithGitHub(
    verified,
    { candidate, githubApi },
  )).status, "completed");
  publicEvidence["repos/codeacme17/launchrally/issues/comments/123456"].issue_url =
    "https://api.github.com/repos/codeacme17/launchrally/issues/140";
  await assert.rejects(
    verifyExternalEvidenceWithGitHub(verified, { candidate, githubApi }),
    /p1_external_independent_review_invalid/u,
  );
  publicEvidence["repos/codeacme17/launchrally/issues/comments/123456"].issue_url =
    "https://api.github.com/repos/codeacme17/launchrally/issues/141";

  results.codex.public_result.p1_exact_artifacts.fresh_verify.successful_downstream = "unverified";
  assert.throws(
    () => verifyExternalPhase1Results({
      version: currentVersion,
      results,
      workflow,
      releaseUrl: `https://github.com/codeacme17/launchrally/releases/tag/v${currentVersion}`,
      candidate,
      publicationJobs,
      review,
    }),
    /p1_external_result_invalid: codex/u,
  );
  results.codex = createExternalHostEnvelope({
    host: "codex",
    challenge: "b".repeat(64),
    result: externalResult(),
    version: currentVersion,
  });
  results.claude = results.codex;
  assert.throws(
    () => verifyExternalPhase1Results({
      version: currentVersion,
      results,
      workflow,
      releaseUrl: `https://github.com/codeacme17/launchrally/releases/tag/v${currentVersion}`,
      candidate,
      publicationJobs,
      review,
    }),
    /p1_external_result_invalid/u,
  );
});

test("release CI verifies clean artifacts before OIDC provenance publishing", async () => {
  const release = await readFile(
    path.join(root, ".github/workflows/release.yml"),
    "utf8",
  );
  const ci = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");

  for (const workflow of [release, ci]) {
    assert.match(workflow, /actions: read/u);
    assert.match(workflow, /issues: read/u);
    assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  }
  assert.match(release, /tags:\s*\n\s+- "v\*\.\*\.\*"/u);
  assert.match(release, /contents: read/u);
  assert.match(release, /id-token: write/u);
  assert.match(release, /node-version: 24/u);
  assert.match(release, /npm@11\.17\.0/u);
  assert.match(release, /npm ci/u);
  assert.match(release, /npm run build/u);
  assert.match(release, /npm test/u);
  assert.match(release, /npm run validate:release -- --tag/u);
  assert.match(release, /npm run validate:release-ref -- --tag/u);
  assert.match(release, /npm run test:artifacts/u);
  assert.match(release, /node scripts\/publish-release\.mjs/u);
  assert.match(release, /public-smoke:[\s\S]*npm run test:public-release/u);
  assert.match(release, /prerelease:[\s\S]*gh release create[^\n]*--prerelease/u);
  assert.match(release, /prerelease:[\s\S]*needs: public-smoke/u);
  assert.doesNotMatch(release, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./u);
  assert.match(ci, /npm run validate:release/u);
  assert.match(ci, /npm run test:artifacts/u);

  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/publish-release.mjs", "--dry-run", "--json"],
    { cwd: root },
  );
  const plan = JSON.parse(stdout);
  assert.deepEqual(
    plan.packages,
    releaseManifest.packages.map((artifact) => artifact.name),
  );
  assert.deepEqual(
    plan.commands,
    releaseManifest.packages.map((artifact) => ({
      command: "npm",
      arguments: [
        "publish",
        "--workspace",
        artifact.name,
        "--provenance",
        "--access",
        "public",
        "--tag",
        "experimental",
      ],
    })),
  );
});

test("Experimental P1 publication is gated independently from the P0 Stable channel", async () => {
  const release = await readFile(
    path.join(root, ".github/workflows/release.yml"),
    "utf8",
  );

  assert.match(
    release,
    /release_state:[\s\S]*release\/p1\.json[\s\S]*release\/p0\.json/u,
  );
  assert.match(release, /p1_release_status[\s\S]*experimental/u);
  assert.match(release, /p1_publication_status[\s\S]*not_published/u);
  assert.match(release, /p0_release_status[\s\S]*stable/u);
  assert.match(release, /npm run validate:p1 -- --require-publish-ready/u);
  assert.match(release, /npm run test:public-release -- --dist-tag experimental/u);
  assert.match(
    release,
    new RegExp(`--notes-file docs/maintainers/experimental-${currentVersion.replaceAll(".", "\\.")}-announcement\\.md`, "u"),
  );
  assert.doesNotMatch(release, /npm dist-tag add|--tag latest/u);
});

test("the P1 Experimental candidate advances coherently without moving P0 latest", async () => {
  const [rootPackage, p0, p1] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "release/p0.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "release/p1.json"), "utf8").then(JSON.parse),
  ]);

  assert.equal(rootPackage.version, currentVersion);
  assert.equal(p0.release_status, "stable");
  assert.equal(p0.stable_promotion.approved_tag, "v0.3.2");
  assert.deepEqual(p1.experimental_publication, {
    announcement: `docs/maintainers/experimental-${currentVersion}-announcement.md`,
    candidate_tag: `v${currentVersion}`,
    channel: "experimental",
    stable_channel: "latest",
    p0_stable_tag: "v0.3.2",
    candidate_manifest: "release/p1-release-candidate.json",
    changelog: "CHANGELOG.md",
    migration_notes: "docs/maintainers/p1-migration-notes.md",
    evidence_record: `docs/maintainers/experimental-${currentVersion}-p1-evidence.md`,
  });

  for (const { path: packagePath } of releaseManifest.packages) {
    const packageJson = JSON.parse(await readFile(
      path.join(root, packagePath, "package.json"),
      "utf8",
    ));
    assert.equal(packageJson.version, rootPackage.version, packagePath);
    for (const [name, version] of Object.entries(packageJson.dependencies ?? {})) {
      if (name.startsWith("@launchrally/")) assert.equal(version, rootPackage.version, name);
    }
  }
});

test("published P1 artifacts match candidate digests, provenance, and the preserved latest line", () => {
  const digestBytes = Buffer.alloc(64, 7);
  const integrity = `sha512-${digestBytes.toString("base64")}`;
  const candidate = {
    schema_version: "launchrally.dev/p1-release-candidate/v1",
    version: "0.4.0",
    tag: "v0.4.0",
    channel: "experimental",
    stable_channel: "latest",
    p0_stable_version: "0.3.2",
    packages: [{
      name: "@launchrally/cli",
      integrity,
      shasum: "0123456789abcdef0123456789abcdef01234567",
    }],
  };
  const published = [{
    name: "@launchrally/cli",
    dist: {
      integrity,
      shasum: candidate.packages[0].shasum,
      attestations: {
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
    },
    dist_tags: { experimental: "0.4.0", latest: "0.3.2" },
    provenance: {
      _type: "https://in-toto.io/Statement/v1",
      subject: [{
        name: "pkg:npm/%40launchrally/cli@0.4.0",
        digest: { sha512: digestBytes.toString("hex") },
      }],
      predicateType: "https://slsa.dev/provenance/v1",
      predicate: {
        buildDefinition: {
          buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
          externalParameters: {
            workflow: {
              ref: "refs/tags/v0.4.0",
              repository: "https://github.com/codeacme17/launchrally",
              path: ".github/workflows/release.yml",
            },
          },
          resolvedDependencies: [{
            uri: "git+https://github.com/codeacme17/launchrally@refs/tags/v0.4.0",
            digest: { gitCommit: "a".repeat(40) },
          }],
        },
        runDetails: {
          builder: { id: "https://github.com/actions/runner/github-hosted" },
        },
      },
    },
  }];

  const candidateBindings = {
    candidate,
    rootPackage: { version: "0.4.0" },
    p0: {
      release_status: "stable",
      stable_promotion: { approved_tag: "v0.3.2" },
    },
    p1: {
      release_status: "experimental",
      publication_status: "not_published",
      experimental_publication: {
        candidate_tag: "v0.4.0",
        candidate_manifest: "release/p1-release-candidate.json",
        channel: "experimental",
        stable_channel: "latest",
        p0_stable_tag: "v0.3.2",
      },
    },
  };
  assert.deepEqual(verifyExperimentalCandidateBindings(candidateBindings), {
    version: "0.4.0",
    tag: "v0.4.0",
    channel: "experimental",
    p0_latest: "0.3.2",
  });
  assert.throws(
    () => verifyExperimentalCandidateBindings({
      ...candidateBindings,
      rootPackage: { version: "0.4.1" },
    }),
    /p1_candidate_identity_mismatch/u,
  );
  assert.throws(
    () => verifyExperimentalCandidateBindings({
      ...candidateBindings,
      p0: {
        ...candidateBindings.p0,
        stable_promotion: { approved_tag: "v0.3.1" },
      },
    }),
    /p1_candidate_identity_mismatch/u,
  );
  assert.throws(
    () => verifyExperimentalCandidateBindings({
      ...candidateBindings,
      p1: {
        ...candidateBindings.p1,
        experimental_publication: {
          ...candidateBindings.p1.experimental_publication,
          candidate_tag: "v0.4.1",
        },
      },
    }),
    /p1_candidate_identity_mismatch/u,
  );

  assert.deepEqual(
    verifyPublishedExperimentalRelease({
      candidate,
      published,
      expectedCommit: "a".repeat(40),
    }),
    {
      status: "completed",
      version: "0.4.0",
      tag: "v0.4.0",
      channel: "experimental",
      p0_latest: "0.3.2",
      packages: ["@launchrally/cli"],
      digests: "candidate_matches_published",
      provenance: "github_release_workflow_verified",
    },
  );

  assert.throws(
    () => verifyPublishedExperimentalRelease({
      candidate,
      published: [{
        ...published[0],
        dist_tags: { experimental: "0.4.0", latest: "0.4.0" },
      }],
      expectedCommit: "a".repeat(40),
    }),
    /p1_stable_channel_changed/u,
  );
  assert.throws(
    () => verifyPublishedExperimentalRelease({
      candidate,
      published: [{
        ...published[0],
        dist: { ...published[0].dist, integrity: `sha512-${Buffer.alloc(64, 8).toString("base64")}` },
      }],
      expectedCommit: "a".repeat(40),
    }),
    /p1_published_digest_mismatch/u,
  );
});

test("release CI exposes an approved Stable promotion path through the trusted workflow", async () => {
  const release = await readFile(
    path.join(root, ".github/workflows/release.yml"),
    "utf8",
  );

  assert.match(release, /workflow_dispatch:[\s\S]*tag:[\s\S]*required: true/u);
  assert.match(release, /workflow_dispatch:[\s\S]*promotion_pr:[\s\S]*required: true/u);
  assert.match(
    release,
    /release_state:[\s\S]*outputs:[\s\S]*p1_release_status:[\s\S]*GITHUB_OUTPUT/u,
  );
  assert.match(
    release,
    /contracts:[\s\S]*needs: release_state[\s\S]*if: github\.event_name == 'push' && needs\.release_state\.outputs\.p1_release_status == 'experimental'/u,
  );
  assert.match(
    release,
    /journeys:[\s\S]*needs: release_state[\s\S]*if: github\.event_name == 'push' && needs\.release_state\.outputs\.p1_release_status == 'experimental'/u,
  );
  assert.match(
    release,
    /stable-promotion:[\s\S]*if: github\.event_name == 'workflow_dispatch'/u,
  );
  assert.match(release, /stable-promotion:[\s\S]*environment: npm/u);
  assert.match(release, /stable-promotion:[\s\S]*contents: write[\s\S]*id-token: write/u);
  assert.match(release, /stable-promotion:[\s\S]*pull-requests: write/u);
  assert.match(release, /stable-promotion:[\s\S]*ref: \$\{\{ inputs\.tag \}\}/u);
  assert.match(release, /stable-promotion:[\s\S]*npm@11\.17\.0/u);
  assert.match(
    release,
    /stable-promotion:[\s\S]*npm run validate:acceptance -- --require-stable-ready/u,
  );
  assert.match(release, /stable-promotion:[\s\S]*npm run validate:p0/u);
  assert.match(release, /stable-promotion:[\s\S]*npm run validate:release -- --tag/u);
  assert.match(
    release,
    /stable-promotion:[\s\S]*npm run validate:release-ref -- --tag[^\n]*--allow-promotion-head/u,
  );
  assert.match(release, /stable-promotion:[\s\S]*npm run test:artifacts/u);
  assert.match(
    release,
    /stable-promotion:[\s\S]*\.state\)" = "OPEN"[\s\S]*\.mergeable\)" = "MERGEABLE"[\s\S]*\.mergeStateStatus\)" = "CLEAN"[\s\S]*\.reviewDecision\)" = "APPROVED"[\s\S]*--phase publish[\s\S]*gh pr merge[\s\S]*--phase announce/u,
  );
  assert.doesNotMatch(release, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./u);
});

test("release CI uses a bot-authored Stable promotion PR to preserve independent human approval", async () => {
  const workflow = await readFile(
    path.join(root, ".github/workflows/open-stable-promotion-pr.yml"),
    "utf8",
  );
  const runbook = await readFile(
    path.join(root, "docs/maintainers/stable-promotion.md"),
    "utf8",
  );

  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /contents: read/u);
  assert.match(workflow, /pull-requests: write/u);
  assert.doesNotMatch(workflow, /contents: write/u);
  assert.match(workflow, /github\.ref == 'refs\/heads\/dev'/u);
  assert.match(workflow, /validate:acceptance -- --require-stable-ready/u);
  assert.match(workflow, /validate:p0/u);
  assert.match(workflow, /validate:release -- --tag "\$PROMOTION_TAG"/u);
  assert.match(workflow, /gh pr list --base main --head dev --state open/u);
  assert.match(workflow, /gh pr create[\s\S]*--base main[\s\S]*--head dev/u);
  assert.doesNotMatch(workflow, /gh pr (?:review|merge)/u);
  assert.doesNotMatch(workflow, /secrets\./u);
  assert.match(runbook, /github-actions\[bot\]/u);
  assert.match(runbook, /can neither\s+approve nor merge/iu);
  assert.match(runbook, /restored immediately/iu);
});

test("release validation requires an annotated tag on the approved main commit", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "launchrally-release-ref-"));
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repository });
  await writeFile(path.join(repository, "release.txt"), "candidate\n");
  await execFileAsync("git", ["add", "release.txt"], { cwd: repository });
  await execFileAsync("git", [
    "-c", "user.name=LaunchRally Tests",
    "-c", "user.email=tests@launchrally.dev",
    "commit", "--quiet", "-m", "candidate",
  ], { cwd: repository });
  await execFileAsync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], {
    cwd: repository,
  });
  await execFileAsync("git", [
    "-c", "user.name=LaunchRally Tests",
    "-c", "user.email=tests@launchrally.dev",
    "tag", "--annotate", "v0.3.2", "--message", "LaunchRally 0.3.2",
  ], { cwd: repository });

  const { stdout } = await execFileAsync(
    process.execPath,
    [path.join(root, "scripts/validate-release-ref.mjs"), "--root", repository, "--tag", "v0.3.2", "--json"],
    { cwd: root },
  );
  assert.equal(JSON.parse(stdout).tag_type, "annotated");

  await execFileAsync("git", ["tag", "--delete", "v0.3.2"], { cwd: repository });
  await execFileAsync("git", ["tag", "v0.3.2"], { cwd: repository });
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [path.join(root, "scripts/validate-release-ref.mjs"), "--root", repository, "--tag", "v0.3.2"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /release_tag_not_annotated/u);
      return true;
    },
  );

  await execFileAsync("git", ["tag", "--delete", "v0.3.2"], { cwd: repository });
  await execFileAsync("git", [
    "-c", "user.name=LaunchRally Tests",
    "-c", "user.email=tests@launchrally.dev",
    "tag", "--annotate", "v0.3.2", "--message", "LaunchRally 0.3.2",
  ], { cwd: repository });
  await writeFile(path.join(repository, "release.txt"), "different main\n");
  await execFileAsync("git", ["add", "release.txt"], { cwd: repository });
  await execFileAsync("git", [
    "-c", "user.name=LaunchRally Tests",
    "-c", "user.email=tests@launchrally.dev",
    "commit", "--quiet", "-m", "different main",
  ], { cwd: repository });
  await execFileAsync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], {
    cwd: repository,
  });
  await execFileAsync("git", ["checkout", "--quiet", "v0.3.2"], { cwd: repository });
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [path.join(root, "scripts/validate-release-ref.mjs"), "--root", repository, "--tag", "v0.3.2"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /release_tag_not_on_main/u);
      return true;
    },
  );
  const { stdout: promotionStdout } = await execFileAsync(
    process.execPath,
    [
      path.join(root, "scripts/validate-release-ref.mjs"),
      "--root",
      repository,
      "--tag",
      "v0.3.2",
      "--allow-promotion-head",
      "--json",
    ],
    { cwd: root },
  );
  assert.equal(JSON.parse(promotionStdout).tag_type, "annotated");
});

test("release validation fixes partial publication forward with one coherent version", async () => {
  const stubDirectory = await mkdtemp(path.join(os.tmpdir(), "launchrally-npm-publish-"));
  const stubPath = path.join(stubDirectory, "npm");
  const logPath = path.join(stubDirectory, "calls.jsonl");
  await writeFile(stubPath, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NPM_STUB_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "view") {
  process.stderr.write("npm error code E404\\n");
  process.exit(1);
}
if (args[0] === "publish" && args[2] === "@launchrally/core") {
  process.stderr.write("simulated publish failure\\n");
  process.exit(1);
}
`);
  await chmod(stubPath, 0o755);

  await assert.rejects(
    execFileAsync(process.execPath, ["scripts/publish-release.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        NPM_STUB_LOG: logPath,
        PATH: `${stubDirectory}${path.delimiter}${process.env.PATH}`,
      },
    }),
    (error) => {
      assert.match(error.stderr, /partial_publication/u);
      assert.match(error.stderr, new RegExp(
        `@launchrally/contracts@${currentVersion.replaceAll(".", "\\.")}`,
        "u",
      ));
      assert.match(error.stderr, /new coherent version/iu);
      return true;
    },
  );

  const calls = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.slice(0, 5), releaseManifest.packages.map(({ name }) => [
    "view",
    `${name}@${currentVersion}`,
    "version",
    "--json",
  ]));
  assert.deepEqual(calls.slice(5).map((arguments_) => arguments_.slice(0, 3)), [
    ["publish", "--workspace", "@launchrally/contracts"],
    ["publish", "--workspace", "@launchrally/core"],
  ]);
});

test("release validation rejects a tag that does not match package SemVer", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-release.mjs", "--tag", "v0.3.1", "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /release_tag_mismatch/u);
      assert.match(error.stderr, new RegExp(
        `v0\\.3\\.1.*v${currentVersion.replaceAll(".", "\\.")}`,
        "u",
      ));
      return true;
    },
  );
});
