import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
      version: "0.3.0",
      scope: "user",
      enabled: true,
    }],
    available: [],
  };

  assert.equal(
    hasClaudeInstalledPlugin(installed, "launchrally@launchrally", "0.3.0"),
    true,
  );
  assert.equal(
    hasClaudeInstalledPlugin(installed, "launchrally@launchrally", "0.3.1"),
    false,
  );
  assert.equal(hasClaudeInstalledPlugin({
    installed: [{ pluginId: "launchrally@launchrally", version: "0.3.0" }],
  }, "launchrally@launchrally", "0.3.0"), false);
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

test("release validation proves one SemVer across CLI, Plugins, and bundled Skills", async () => {
  const { stdout } = await execFileAsync(
    "npm",
    ["--silent", "run", "validate:release", "--", "--json"],
    { cwd: root },
  );
  const result = JSON.parse(stdout);

  assert.deepEqual(result, {
    status: "completed",
    version: "0.3.0",
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
      assert.match(error.stderr, /plugin\.json declares 0\.3\.1; expected 0\.3\.0/u);
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
    skill.replace("@launchrally/cli@0.3.0", "@launchrally/cli@0.3.1"),
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
        assert.equal(version, "0.3.0", `${relative}: ${dependency}`);
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
    /npm install --global @launchrally\/cli@0\.3\.0/u,
  );
  assert.match(readme, /rally --version --json/u);
  assert.match(
    readme,
    /npm exec --package=@launchrally\/cli@0\.3\.0 -- rally audit --plain --cwd \. --output \.\/launchrally-audit-report\.json/u,
  );
  assert.match(publicGuidance, /preserve the package manager's download confirmation/iu);
  assert.match(
    skillGuidance,
    /npm install --global @launchrally\/cli@0\.3\.0/u,
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
  packageJson.dependencies["@launchrally/core"] = "^0.3.0";
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-release.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /release_dependency_drift/u);
      assert.match(error.stderr, /@launchrally\/core declares \^0\.3\.0/u);
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
  const exactPackages = releaseManifest.packages.map(({ name }) => `${name}@0.3.0`);

  assert.deepEqual(plan, {
    status: "planned",
    source: "public_registry",
    version: "0.3.0",
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
      expected_version: "0.3.0",
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
          "--package=@launchrally/cli@0.3.0",
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
            "@launchrally/cli@0.3.0",
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
        ref: "v0.3.0",
      },
    },
  });
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
    version: "0.3.0",
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
      cli_version: "0.3.0",
      audit_status: "needs_input",
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
      full_journey: "plan_handoff_verify_completed",
      packaged_skill_fixtures: "codex_and_claude_executed",
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
      version: "0.3.0",
    },
  }]);
});

test("native Plugin validators are exact development dependencies", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(packageJson.devDependencies, {
    "@anthropic-ai/claude-code": "2.1.224",
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
    /codex plugin marketplace add codeacme17\/launchrally --ref v0\.3\.0/u,
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
  assert.match(guide, /npm install --global @launchrally\/cli@0\.3\.0/u);
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
    "tag", "--annotate", "v0.3.0", "--message", "LaunchRally 0.3.0",
  ], { cwd: repository });

  const { stdout } = await execFileAsync(
    process.execPath,
    [path.join(root, "scripts/validate-release-ref.mjs"), "--root", repository, "--tag", "v0.3.0", "--json"],
    { cwd: root },
  );
  assert.equal(JSON.parse(stdout).tag_type, "annotated");

  await execFileAsync("git", ["tag", "--delete", "v0.3.0"], { cwd: repository });
  await execFileAsync("git", ["tag", "v0.3.0"], { cwd: repository });
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [path.join(root, "scripts/validate-release-ref.mjs"), "--root", repository, "--tag", "v0.3.0"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /release_tag_not_annotated/u);
      return true;
    },
  );

  await execFileAsync("git", ["tag", "--delete", "v0.3.0"], { cwd: repository });
  await execFileAsync("git", [
    "-c", "user.name=LaunchRally Tests",
    "-c", "user.email=tests@launchrally.dev",
    "tag", "--annotate", "v0.3.0", "--message", "LaunchRally 0.3.0",
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
  await execFileAsync("git", ["checkout", "--quiet", "v0.3.0"], { cwd: repository });
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [path.join(root, "scripts/validate-release-ref.mjs"), "--root", repository, "--tag", "v0.3.0"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /release_tag_not_on_main/u);
      return true;
    },
  );
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
      assert.match(error.stderr, /@launchrally\/contracts@0\.3\.0/u);
      assert.match(error.stderr, /new coherent version/iu);
      return true;
    },
  );

  const calls = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.slice(0, 5), releaseManifest.packages.map(({ name }) => [
    "view",
    `${name}@0.3.0`,
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
      assert.match(error.stderr, /v0\.3\.1.*v0\.3\.0/u);
      return true;
    },
  );
});
