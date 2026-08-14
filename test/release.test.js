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
import { hasClaudeInstalledPlugin } from "../scripts/native-plugin-state.mjs";
import { assertNoConsumerInstallScripts } from "../scripts/release-artifact-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const releaseManifest = JSON.parse(await readFile(
  path.join(root, "release/artifacts.json"),
  "utf8",
));
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
  return copyRepositoryFixture(root, "launchrally-stable-promotion-", [
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
    version: "0.3.2",
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
      assert.match(error.stderr, /plugin\.json declares 0\.3\.1; expected 0\.3\.2/u);
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
    skill.replace("@launchrally/cli@0.3.2", "@launchrally/cli@0.3.1"),
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

test("release validation rejects untrusted Pack Executor bindings and Phase 1 command drift", async () => {
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

  const commandFixture = await createReleaseFixture();
  const commandPath = path.join(
    commandFixture,
    "adapters/codex/launchrally/skills/launchrally/references/phase-1-command-examples.json",
  );
  const commands = JSON.parse(await readFile(commandPath, "utf8"));
  commands.commands[0].argv.push("--hidden-authority");
  await writeFile(commandPath, `${JSON.stringify(commands, null, 2)}\n`);
  await assertReleaseValidationFailure(commandFixture, /p1_command_matrix_drift/u);
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
        assert.equal(version, "0.3.2", `${relative}: ${dependency}`);
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
    /npm install --global @launchrally\/cli@0\.3\.2/u,
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
  packageJson.dependencies["@launchrally/core"] = "^0.3.2";
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-release.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /release_dependency_drift/u);
      assert.match(error.stderr, /@launchrally\/core declares \^0\.3\.2/u);
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
  const exactPackages = releaseManifest.packages.map(({ name }) => `${name}@0.3.2`);

  assert.deepEqual(plan, {
    status: "planned",
    source: "public_registry",
    version: "0.3.2",
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
      expected_version: "0.3.2",
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
          "--package=@launchrally/cli@0.3.2",
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
            "@launchrally/cli@0.3.2",
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
        ref: "v0.3.2",
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
      expected_version: "0.3.2",
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
      "v0.3.2",
      "--dry-run",
      "--json",
    ],
    { cwd: root },
  );

  assert.deepEqual(JSON.parse(stdout), {
    status: "planned",
    strategy: "new_coherent_version",
    tag: "v0.3.2",
    version: "0.3.2",
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
        "v0.3.2",
        "--verify-tag",
        "--generate-notes",
        "--latest",
        "--title",
        "LaunchRally v0.3.2",
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
          "v0.3.2",
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
      ["scripts/promote-stable.mjs", "--root", fixture, "--tag", "v0.3.2", "--dry-run"],
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
  packageJson.version = "0.3.2-rc.1";
  contract.stable_promotion.approved_tag = "v0.3.2-rc.1";
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
        "v0.3.2-rc.1",
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
      "v0.3.2",
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
    tag: "v0.3.2",
    version: "0.3.2",
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
      arguments: ["view", `${name}@0.3.2`, "version", "--json"],
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
      arguments: ["release", "view", "v0.3.2", "--json", "isDraft,isPrerelease"],
    },
    {
      command: "gh",
      arguments: [
        "release",
        "create",
        "v0.3.2",
        "--verify-tag",
        "--generate-notes",
        "--latest",
        "--title",
        "LaunchRally v0.3.2",
      ],
    },
  ]);
});

test("Stable promotion resumes only after a coherent publication", async () => {
  const fixture = await createStablePromotionFixture();
  const commands = await createStablePromotionCommandStubs();
  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/promote-stable.mjs", "--root", fixture, "--tag", "v0.3.2", "--json"],
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
  const existing = `${releaseManifest.packages[0].name}@0.3.2`;
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/promote-stable.mjs", "--root", fixture, "--tag", "v0.3.2", "--json"],
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
    ["scripts/promote-stable.mjs", "--root", fixture, "--tag", "v0.3.2", "--json"],
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
      arguments: ["release", "view", "v0.3.2", "--json", "isDraft,isPrerelease"],
    },
    {
      command: "gh",
      arguments: [
        "release",
        "edit",
        "v0.3.2",
        "--draft=false",
        "--prerelease=false",
        "--latest",
        "--title",
        "LaunchRally v0.3.2",
      ],
    },
  ]);
});

test("packed artifacts complete installation, delegation, lifecycle, and full verification journeys", async () => {
  const { stdout } = await execFileAsync(
    "npm",
    ["--silent", "run", "test:artifacts", "--", "--json", "--skip-native"],
    { cwd: root, maxBuffer: 1024 * 1024 * 4 },
  );
  const result = JSON.parse(stdout);

  assert.deepEqual(result, {
    status: "completed",
    version: "0.3.2",
    artifacts: [
      "@launchrally/claude-plugin",
      "@launchrally/cli",
      "@launchrally/codex-plugin",
      "@launchrally/contracts",
      "@launchrally/core",
    ],
    artifact_files_verified: true,
    cli_smoke: {
      operation: "version",
      cli_version: "0.3.2",
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
      launcher_removal: "project_data_preserved",
      plugin_removal: "skipped",
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
    native_plugins: "skipped",
  });
});

test("packed Plugin adapters pass their native host validation", async () => {
  const { stdout } = await execFileAsync(
    "npm",
    ["--silent", "run", "test:artifacts", "--", "--json"],
    { cwd: root, maxBuffer: 1024 * 1024 * 8 },
  );
  const result = JSON.parse(stdout);

  assert.deepEqual(result.native_plugins, {
    claude: "strictly_validated",
    codex: "installed_and_removed",
  });
  assert.equal(
    result.installation_journeys.plugin_removal,
    "project_data_preserved",
  );
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
      version: "0.3.2",
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

test("release CI verifies clean artifacts before OIDC provenance publishing", async () => {
  const release = await readFile(
    path.join(root, ".github/workflows/release.yml"),
    "utf8",
  );
  const ci = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");

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

test("release CI exposes an approved Stable promotion path through the trusted workflow", async () => {
  const release = await readFile(
    path.join(root, ".github/workflows/release.yml"),
    "utf8",
  );

  assert.match(release, /workflow_dispatch:[\s\S]*tag:[\s\S]*required: true/u);
  assert.match(release, /workflow_dispatch:[\s\S]*promotion_pr:[\s\S]*required: true/u);
  assert.match(
    release,
    /release_state:[\s\S]*outputs:[\s\S]*release_status:[\s\S]*GITHUB_OUTPUT/u,
  );
  assert.match(
    release,
    /contracts:[\s\S]*needs: release_state[\s\S]*if: github\.event_name == 'push' && needs\.release_state\.outputs\.release_status == 'experimental'/u,
  );
  assert.match(
    release,
    /journeys:[\s\S]*needs: release_state[\s\S]*if: github\.event_name == 'push' && needs\.release_state\.outputs\.release_status == 'experimental'/u,
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
      assert.match(error.stderr, /@launchrally\/contracts@0\.3\.2/u);
      assert.match(error.stderr, /new coherent version/iu);
      return true;
    },
  );

  const calls = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.slice(0, 5), releaseManifest.packages.map(({ name }) => [
    "view",
    `${name}@0.3.2`,
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
      assert.match(error.stderr, /v0\.3\.1.*v0\.3\.2/u);
      return true;
    },
  );
});
