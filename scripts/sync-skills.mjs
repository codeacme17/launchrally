import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "skills", "launchrally");
const codexDestination = path.join(root, "adapters", "codex", "launchrally", "skills", "launchrally");
const claudeDestination = path.join(root, "adapters", "claude", "launchrally", "skills", "launchrally");

async function addClaudeInvocationGuard(skillPath) {
  const content = await readFile(skillPath, "utf8");
  const lines = content.split("\n");
  const frontmatterEnd = lines.indexOf("---", 1);
  if (frontmatterEnd === -1) throw new Error("SKILL.md frontmatter is invalid");
  lines.splice(frontmatterEnd, 0, "disable-model-invocation: true");
  await writeFile(skillPath, lines.join("\n"), "utf8");
}

async function syncTo(codexTarget, claudeTarget) {
  await rm(codexTarget, { recursive: true, force: true });
  await rm(claudeTarget, { recursive: true, force: true });
  await cp(source, codexTarget, { recursive: true });
  await cp(source, claudeTarget, { recursive: true });
  await rm(path.join(claudeTarget, "agents"), { recursive: true, force: true });
  await addClaudeInvocationGuard(path.join(claudeTarget, "SKILL.md"));
}

async function filesUnder(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(path.join(directory, entry.name), relative)));
    } else {
      files.push(relative);
    }
  }
  return files.sort();
}

async function normalisedContent(filePath, claude = false) {
  let content = await readFile(filePath, "utf8");
  if (claude && path.basename(filePath) === "SKILL.md") {
    content = content.replace("disable-model-invocation: true\n", "");
  }
  return content;
}

async function assertMatches(destination, claude = false) {
  const sourceFiles = (await filesUnder(source)).filter(
    (relative) => !claude || !relative.startsWith(`agents${path.sep}`),
  );
  const destinationFiles = await filesUnder(destination);
  if (JSON.stringify(sourceFiles) !== JSON.stringify(destinationFiles)) {
    throw new Error(`Skill file list is stale: ${destination}`);
  }

  for (const relative of sourceFiles) {
    const expected = await normalisedContent(path.join(source, relative));
    const actual = await normalisedContent(path.join(destination, relative), claude);
    if (expected !== actual) throw new Error(`Skill file is stale: ${path.join(destination, relative)}`);
  }
}

if (process.argv.includes("--check")) {
  await assertMatches(codexDestination);
  await assertMatches(claudeDestination, true);
  process.stdout.write("Plugin Skill copies are in sync.\n");
} else {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "launchrally-skill-sync-"));
  try {
    const codexTemporary = path.join(temporaryRoot, "codex");
    const claudeTemporary = path.join(temporaryRoot, "claude");
    await syncTo(codexTemporary, claudeTemporary);
    await rm(codexDestination, { recursive: true, force: true });
    await rm(claudeDestination, { recursive: true, force: true });
    await cp(codexTemporary, codexDestination, { recursive: true });
    await cp(claudeTemporary, claudeDestination, { recursive: true });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  process.stdout.write("Synced the canonical Skill into Codex and Claude adapters.\n");
}
