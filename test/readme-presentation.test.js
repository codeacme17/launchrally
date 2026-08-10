import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

function section(markdown, heading) {
  const start = markdown.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `missing ${heading} section`);
  const next = markdown.indexOf("\n## ", start + heading.length + 3);
  return markdown.slice(start, next === -1 ? undefined : next);
}

function wordCount(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/[\[\]()`*_>#|]/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .length;
}

test("the repository README presents a concise first-use journey", async () => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const headings = [
    "First Audit",
    "How it works",
    "What it checks and produces",
    "Safety and permissions",
    "Commands and integrations",
    "Packages",
    "Documentation and project links",
  ];

  let previous = -1;
  for (const heading of headings) {
    const position = readme.indexOf(`## ${heading}`);
    assert.ok(position > previous, `${heading} must appear in the public journey order`);
    previous = position;
  }

  const firstAudit = section(readme, "First Audit");
  const firstAuditWords = wordCount(firstAudit);
  assert.ok(
    firstAuditWords >= 200 && firstAuditWords <= 250,
    `First Audit must contain 200-250 prose words; received ${firstAuditWords}`,
  );
  assert.match(
    firstAudit,
    /npm exec --package=@launchrally\/cli@0\.2\.1 -- rally audit --json --cwd \./u,
  );
  assert.match(firstAudit, /local-first/iu);
  assert.match(firstAudit, /no LaunchRally account/iu);
  assert.match(firstAudit, /does not write|no repository writes/iu);
  assert.match(firstAudit, /package-manager confirmation/iu);

  for (const packageName of [
    "@launchrally/cli",
    "@launchrally/core",
    "@launchrally/contracts",
    "@launchrally/codex-plugin",
    "@launchrally/claude-plugin",
  ]) {
    assert.match(section(readme, "Packages"), new RegExp(packageName.replace("/", "\\/"), "u"));
  }
});

test("the README terminal visual is accessible, responsive, and fixture-derived", async () => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  assert.match(
    readme,
    /<picture>[\s\S]*?<source media="\(prefers-color-scheme: dark\)" srcset="docs\/assets\/launchrally-terminal-dark\.svg">[\s\S]*?<img src="docs\/assets\/launchrally-terminal-light\.svg" alt="LaunchRally terminal showing an Inconclusive audit with verification gaps and the next init command" width="380">[\s\S]*?<\/picture>/u,
  );

  await execFileAsync(
    process.execPath,
    ["scripts/generate-readme-visual.mjs", "--check"],
    { cwd: root },
  );

  const fixture = await readFile(
    path.join(root, "fixtures/readme/first-audit-output.txt"),
    "utf8",
  );
  for (const theme of ["light", "dark"]) {
    const svg = await readFile(
      path.join(root, `docs/assets/launchrally-terminal-${theme}.svg`),
      "utf8",
    );
    assert.match(svg, /viewBox="0 0 440 440"/u);
    const fontSize = Number(svg.match(/font: (\d+)px/u)?.[1]);
    const mobileFontSize = fontSize * (320 / 440);
    assert.ok(
      mobileFontSize >= 11,
      `${theme} visual text must remain at least 11px wide at a 320px viewport`,
    );
    for (const line of fixture.trimEnd().split("\n")) {
      assert.ok(svg.includes(line), `${theme} visual must contain fixture line: ${line}`);
    }
    assert.doesNotMatch(svg, /(?:credential|token|password|\/Users\/|repository_id|account_id|deployment_id)/iu);
  }
});

test("repository README links resolve and release guidance explains npm page timing", async () => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const localLinks = [...readme.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)]
    .map(([, destination]) => destination)
    .filter((destination) => !/^(?:https?:|mailto:|#)/u.test(destination));

  for (const destination of localLinks) {
    const relativePath = decodeURIComponent(destination.split("#", 1)[0]);
    await access(path.join(root, relativePath));
  }

  const releaseGuide = await readFile(
    path.join(root, "docs/maintainers/release-runbook.md"),
    "utf8",
  );
  assert.match(
    releaseGuide,
    /npm package pages? (?:change|update)[^\n]*only after (?:the )?new (?:package )?versions? (?:are|is) published/iu,
  );
});
