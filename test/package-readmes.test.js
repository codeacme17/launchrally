import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

const publishedPackages = [
  {
    name: "@launchrally/cli",
    packagePath: "packages/cli",
    packageFiles: ["bin/"],
    keywords: ["launch-readiness", "audit", "verification", "cli", "local-first", "release"],
    requiredContent: [
      "# @launchrally/cli",
      "Experimental P0",
      "npm install --global @launchrally/cli@0.2.2",
      "Node.js 20.12.0 or newer",
      "local-first",
      "docs/getting-started/quickstart.md",
      "docs/concepts/privacy.md",
    ],
  },
  {
    name: "@launchrally/contracts",
    packagePath: "packages/contracts",
    packageFiles: ["schemas/", "src/"],
    keywords: ["launchrally", "contracts", "schemas", "json-schema", "audit", "verification"],
    requiredContent: [
      "# @launchrally/contracts",
      "Experimental P0",
      "npm install @launchrally/contracts@0.2.2",
      "import { REPORT_SCHEMA } from \"@launchrally/contracts\";",
      "versioned JSON Schemas",
      "ESM",
      "docs/concepts/data-model.md",
    ],
  },
  {
    name: "@launchrally/core",
    packagePath: "packages/core",
    packageFiles: ["provider-decision-cards/", "src/"],
    keywords: ["launchrally", "launch-readiness", "audit", "verification", "local-first", "release"],
    requiredContent: [
      "# @launchrally/core",
      "Experimental P0",
      "npm install @launchrally/core@0.2.2",
      "import { runAudit } from \"@launchrally/core\";",
      "deterministic",
      "ESM",
      "docs/concepts/privacy.md",
    ],
  },
  {
    name: "@launchrally/codex-plugin",
    packagePath: "adapters/codex/launchrally",
    packageFiles: [".codex-plugin/", "skills/"],
    keywords: ["launchrally", "codex", "plugin", "agent-skill", "audit", "launch-readiness"],
    requiredContent: [
      "# @launchrally/codex-plugin",
      "Experimental P0",
      "codex plugin marketplace add codeacme17/launchrally --ref v0.2.2",
      "codex plugin add launchrally@launchrally",
      "codex plugin remove launchrally@launchrally",
      "canonical Agent Skill",
      "skills/launchrally/SKILL.md",
    ],
  },
  {
    name: "@launchrally/claude-plugin",
    packagePath: "adapters/claude/launchrally",
    packageFiles: [".claude-plugin/", "skills/"],
    keywords: ["launchrally", "claude-code", "plugin", "agent-skill", "audit", "launch-readiness"],
    requiredContent: [
      "# @launchrally/claude-plugin",
      "Experimental P0",
      "claude plugin marketplace add codeacme17/launchrally --scope user",
      "claude plugin install launchrally@launchrally --scope user",
      "claude plugin uninstall launchrally@launchrally --scope user",
      "canonical Agent Skill",
      "skills/launchrally/SKILL.md",
    ],
  },
];

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"));
}

async function readText(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

test("published packages expose their package-specific npm keywords", async () => {
  for (const publishedPackage of publishedPackages) {
    const manifest = await readJson(`${publishedPackage.packagePath}/package.json`);
    assert.deepEqual(
      manifest.keywords,
      publishedPackage.keywords,
      `${publishedPackage.name} keywords`,
    );
  }
});

test("published package READMEs stand alone on npm with tailored guidance", async () => {
  const sharedContent = [
    "https://github.com/codeacme17/launchrally",
    "https://github.com/codeacme17/launchrally/issues",
    "Apache-2.0",
    "https://github.com/codeacme17/launchrally/blob/main/LICENSE",
  ];

  for (const publishedPackage of publishedPackages) {
    const readme = await readText(`${publishedPackage.packagePath}/README.md`);
    for (const expected of [...publishedPackage.requiredContent, ...sharedContent]) {
      assert.ok(readme.includes(expected), `${publishedPackage.name} README includes ${expected}`);
    }

    const markdownTargets = [...readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)]
      .map((match) => match[1]);
    assert.ok(markdownTargets.length > 0, `${publishedPackage.name} README contains links`);
    assert.ok(
      markdownTargets.every((target) => target.startsWith("https://")),
      `${publishedPackage.name} README uses absolute HTTPS links`,
    );

    for (const target of markdownTargets) {
      const repositoryPath = target.match(
        /^https:\/\/github\.com\/codeacme17\/launchrally\/(?:blob|tree)\/main\/([^#]+)(?:#.*)?$/u,
      )?.[1];
      if (repositoryPath !== undefined) {
        await access(path.join(repositoryRoot, decodeURIComponent(repositoryPath)));
      }
    }
  }
});

test("release artifacts declare every package README without widening files allowlists", async () => {
  const releaseArtifacts = await readJson("release/artifacts.json");

  for (const publishedPackage of publishedPackages) {
    const artifact = releaseArtifacts.packages.find(
      (candidate) => candidate.name === publishedPackage.name,
    );
    assert.ok(artifact, `${publishedPackage.name} has an artifact declaration`);
    assert.deepEqual(
      artifact.package_files,
      publishedPackage.packageFiles,
      `${publishedPackage.name} files allowlist remains unchanged`,
    );
    assert.equal(
      artifact.files.filter((file) => file === "README.md").length,
      1,
      `${publishedPackage.name} declares README.md exactly once`,
    );
  }
});

test("npm dry-run payloads include every package README and metadata", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "launchrally-readmes-"));
  const cache = path.join(temporaryRoot, "npm-cache");

  try {
    for (const publishedPackage of publishedPackages) {
      const { stdout } = await execFileAsync(
        "npm",
        ["pack", "--dry-run", "--json", "--cache", cache],
        { cwd: path.join(repositoryRoot, publishedPackage.packagePath) },
      );
      const [payload] = JSON.parse(stdout);
      assert.equal(payload.name, publishedPackage.name);
      const files = payload.files.map(({ path: filePath }) => filePath);
      assert.ok(files.includes("README.md"), `${publishedPackage.name} packs its README`);
      assert.ok(files.includes("package.json"), `${publishedPackage.name} packs its metadata`);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
