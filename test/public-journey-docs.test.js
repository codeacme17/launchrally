import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicVersion = "0.2.2";

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

function assertInOrder(content, expected, label) {
  let previous = -1;
  for (const value of expected) {
    const position = content.indexOf(value, previous + 1);
    assert.ok(position > previous, `${label} presents ${value} in journey order`);
    previous = position;
  }
}

const installedJourney = [
  `npm install --global @launchrally/cli@${publicVersion}`,
  "rally --version --json",
  "rally audit --plain --cwd . --output ./launchrally-audit-report.json",
  "rally init --plain --cwd . --report ./launchrally-audit-report.json",
  "rally --version --json --cwd .",
];

test("README and Quickstart lead with one executable installation-first journey", async () => {
  for (const relativePath of ["README.md", "docs/getting-started/quickstart.md"]) {
    const content = await read(relativePath);
    assertInOrder(content, installedJourney, relativePath);
    assert.match(content, /permissions?[^\n]*default-denied|default[^\n]*denied/iu);
    assert.match(content, /Audit[^\n]*does not (?:create|write)[^\n]*\.launchrally/iu);
    assert.match(content, /application (?:dependency files|manifests? and lockfiles?)[^\n]*unchanged/iu);
    assert.match(content, /project-pinned Engine/iu);
  }
});

test("the Install guide owns supported environments and every independent lifecycle", async () => {
  const install = await read("docs/getting-started/install.md");

  for (const expected of [
    "Node.js 20.12.0 or newer",
    "macOS",
    "Linux",
    "Windows",
    "PowerShell",
    "npm prefix --global",
    "user-writable npm prefix",
    "Node version manager",
    ...installedJourney,
    `npm exec --package=@launchrally/cli@${publicVersion} -- rally audit --plain --cwd . --output ./launchrally-audit-report.json`,
    `npm exec --package=@launchrally/cli@${publicVersion} -- rally init --plain --cwd . --report ./launchrally-audit-report.json`,
    `npm exec --package=@launchrally/cli@${publicVersion} -- rally --version --json --cwd .`,
    "rally toolchain status --json --cwd .",
    "rally toolchain restore --cwd .",
    "rally toolchain migrate --to 0.3.0 --cwd .",
    `rally toolchain migrate --to ${publicVersion} --cwd .`,
    "rally toolchain clean --cwd .",
    `npm install --global @launchrally/cli@${publicVersion}`,
    "npm install --global @launchrally/cli@0.2.1",
    "npm uninstall --global @launchrally/cli",
    "rm -rf .launchrally",
    "Remove-Item -Recurse -Force .launchrally",
  ]) {
    assert.ok(install.includes(expected), `Install guide includes ${expected}`);
  }

  for (const term of [
    "Launcher",
    "Engine",
    "Project Toolchain",
    "Execution Authority",
    "Invocation Context",
  ]) {
    assert.match(install, new RegExp(`\\*\\*${term}\\*\\*`, "u"));
  }

  for (const problem of [
    "command not found: rally",
    "prefix permission",
    "Node version-manager",
    "needs_toolchain_restore",
    "needs_toolchain_migration",
    "invalid_toolchain",
    "offline cache",
    "registry denial",
    "legacy 0.2.2",
  ]) {
    assert.match(install, new RegExp(problem, "iu"), `Install guide troubleshoots ${problem}`);
  }

  assert.match(install, /no-install trial[^\n]*CI fallback/iu);
  assert.match(install, /Plugin removal[^\n]*preserves[^\n]*\.launchrally/iu);
  assert.match(install, /Launcher removal[^\n]*preserves[^\n]*\.launchrally/iu);
  assert.match(install, /full project-data deletion[^\n]*destructive/iu);
  assert.doesNotMatch(install, /sudo npm install|--yes|curl[^\n]*\|[^\n]*(?:sh|bash)/iu);
});

test("package and Plugin READMEs point to the same exact installation authority", async () => {
  const cli = await read("packages/cli/README.md");
  assertInOrder(cli, installedJourney, "CLI package README");
  assert.match(cli, /no-install trial[^\n]*CI fallback/iu);

  for (const [relativePath, host] of [
    ["adapters/codex/launchrally/README.md", "Codex"],
    ["adapters/claude/launchrally/README.md", "Claude"],
  ]) {
    const content = await read(relativePath);
    assert.match(content, /CLI prerequisite/iu, `${host} separates the CLI prerequisite`);
    assert.match(content, /Plugin installation/iu, `${host} identifies Plugin installation`);
    assert.match(
      content,
      /https:\/\/github\.com\/codeacme17\/launchrally\/blob\/main\/docs\/getting-started\/install\.md/iu,
      `${host} links the CLI installation authority`,
    );
    assert.match(content, /Plugin removal[^\n]*preserves[^\n]*\.launchrally/iu);
  }

  assert.match(
    await read("packages/core/README.md"),
    new RegExp(`npm install @launchrally/core@${publicVersion.replaceAll(".", "\\.")}`, "u"),
  );
  assert.match(
    await read("packages/contracts/README.md"),
    new RegExp(`npm install @launchrally/contracts@${publicVersion.replaceAll(".", "\\.")}`, "u"),
  );
});

test("public examples, Skills, generated adapters, and terminal assets use the exact current journey", async () => {
  const publicFiles = [
    "README.md",
    "docs/getting-started/install.md",
    "docs/getting-started/quickstart.md",
    "packages/cli/README.md",
    "packages/core/README.md",
    "packages/contracts/README.md",
    "adapters/codex/launchrally/README.md",
    "adapters/claude/launchrally/README.md",
    "skills/launchrally/SKILL.md",
    "skills/launchrally/references/cli-contract.md",
    "skills/launchrally/references/reference-journey.md",
  ];
  const combined = (await Promise.all(publicFiles.map(read))).join("\n");

  const npmExecVersions = [...combined.matchAll(
    /npm exec --package=@launchrally\/cli@(\d+\.\d+\.\d+)/gu,
  )].map((match) => match[1]);
  assert.ok(npmExecVersions.length > 0);
  assert.ok(npmExecVersions.every((version) => version === publicVersion));
  assert.doesNotMatch(combined, /vX\.Y\.Z/gu);

  const canonicalReferences = [
    "skills/launchrally/references/audit.md",
    "skills/launchrally/references/cli-contract.md",
    "skills/launchrally/references/init.md",
    "skills/launchrally/references/permissions.md",
    "skills/launchrally/references/plan.md",
    "skills/launchrally/references/reference-journey.json",
    "skills/launchrally/references/reference-journey.md",
    "skills/launchrally/references/verify.md",
  ];
  for (const canonicalPath of canonicalReferences) {
    const canonical = await read(canonicalPath);
    for (const host of ["codex", "claude"]) {
      const generatedPath = `adapters/${host}/launchrally/${canonicalPath}`;
      assert.equal(await read(generatedPath), canonical, `${generatedPath} is synchronized`);
    }
  }

  const canonicalSkill = await read("skills/launchrally/SKILL.md");
  assert.equal(await read("adapters/codex/launchrally/skills/launchrally/SKILL.md"), canonicalSkill);
  assert.equal(
    (await read("adapters/claude/launchrally/skills/launchrally/SKILL.md"))
      .replace("disable-model-invocation: true\n", ""),
    canonicalSkill,
  );
  assert.equal(
    await read("adapters/codex/launchrally/skills/launchrally/agents/openai.yaml"),
    await read("skills/launchrally/agents/openai.yaml"),
  );

  const fixture = await read("fixtures/readme/first-audit-output.txt");
  assert.match(fixture, /Report\n\.\/audit\.json/iu);
  assert.match(fixture, /rally init --report \.\/audit\.json --cwd \./u);
  assert.doesNotMatch(fixture, /rally init --report audit\.json$/mu);
});
