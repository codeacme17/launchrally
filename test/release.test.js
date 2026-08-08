import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { copyRepositoryFixture } from "./helpers/repository-fixture.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const releaseManifest = JSON.parse(await readFile(
  path.join(root, "release/artifacts.json"),
  "utf8",
));

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
    version: "0.1.0",
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
  manifest.version = "0.1.1";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-release.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /release_version_drift/u);
      assert.match(error.stderr, /plugin\.json declares 0\.1\.1; expected 0\.1\.0/u);
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
    skill.replace("@launchrally/cli@0.1.0", "@launchrally/cli@0.1.1"),
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

test("npm release packages are public, provenance-enabled, and file-allowlisted", async () => {
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
        assert.equal(version, "0.1.0", `${relative}: ${dependency}`);
      }
    }
  }
});

test("the default first Audit is exact, confirmation-preserving, and non-global", async () => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const skill = await readFile(path.join(root, "skills/launchrally/SKILL.md"), "utf8");
  const journey = await readFile(
    path.join(root, "skills/launchrally/references/reference-journey.md"),
    "utf8",
  );
  const publicGuidance = [readme, skill, journey].join("\n");

  assert.match(
    readme,
    /npm exec --package=@launchrally\/cli@0\.1\.0 -- rally audit --json --cwd \./u,
  );
  assert.match(publicGuidance, /preserve the package manager's download confirmation/iu);
  assert.doesNotMatch(publicGuidance, /npm (?:install|i) (?:--global|-g) @launchrally/u);
  assert.doesNotMatch(publicGuidance, /npm exec[^\n]*--(?:yes|y)\b/u);
  assert.doesNotMatch(publicGuidance, /curl[^\n|]*\|\s*(?:ba)?sh/u);
  assert.doesNotMatch(publicGuidance, /(?:copy|cp)[^\n]*skills?\//iu);
});

test("release validation rejects internal dependency ranges", async () => {
  const fixture = await createReleaseFixture();
  const packagePath = path.join(fixture, "packages/cli/package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.dependencies["@launchrally/core"] = "^0.1.0";
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-release.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /release_dependency_drift/u);
      assert.match(error.stderr, /@launchrally\/core declares \^0\.1\.0/u);
      return true;
    },
  );
});

test("public tarballs install together and smoke-test the CLI in a clean project", async () => {
  const { stdout } = await execFileAsync(
    "npm",
    ["--silent", "run", "test:artifacts", "--", "--json", "--skip-native"],
    { cwd: root, maxBuffer: 1024 * 1024 * 4 },
  );
  const result = JSON.parse(stdout);

  assert.deepEqual(result, {
    status: "completed",
    version: "0.1.0",
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
      cli_version: "0.1.0",
      audit_status: "needs_input",
      coverage_journeys: [
        "astro-hosted-web",
        "custom-self-hosted",
        "fastapi-container",
        "pnpm-edge-monorepo",
        "react-go-split",
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
      version: "0.1.0",
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
  marketplace.plugins[0].source.version = "0.1.1";
  await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-release.mjs", "--root", fixture, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /release_version_drift/u);
      assert.match(error.stderr, /marketplace\.json declares 0\.1\.1/u);
      return true;
    },
  );
});

test("release docs cover user-scope Plugin install, update, and uninstall", async () => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const guide = await readFile(path.join(root, "docs/install.md"), "utf8");

  assert.match(readme, /\[Install and release guide\]\(docs\/install\.md\)/u);
  assert.match(
    guide,
    /codex plugin marketplace add codeacme17\/launchrally --ref v0\.1\.0/u,
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
  assert.match(guide, /project-owned \.launchrally data remains/iu);
  assert.doesNotMatch(guide, /npm (?:install|i) (?:--global|-g) @launchrally/u);
  assert.doesNotMatch(guide, /curl[^\n|]*\|\s*(?:ba)?sh/u);
  assert.doesNotMatch(guide, /(?:copy|cp)[^\n]*skills?\//iu);
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
  assert.match(release, /npm run test:artifacts/u);
  assert.match(release, /node scripts\/publish-release\.mjs/u);
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
      ],
    })),
  );
});

test("release validation rejects a tag that does not match package SemVer", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-release.mjs", "--tag", "v0.1.1", "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /release_tag_mismatch/u);
      assert.match(error.stderr, /v0\.1\.1.*v0\.1\.0/u);
      return true;
    },
  );
});
