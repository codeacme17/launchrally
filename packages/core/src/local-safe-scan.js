import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  classifyContentFile,
  extractContentFact,
  isEnvironmentFile,
} from "./fact-extractors.js";
import { isIgnored, parseIgnoreFile } from "./gitignore.js";

export const LOCAL_SAFE_SCAN_POLICY = "local_safe_scan/v1";

const MAX_SUPPORTED_FILE_BYTES = 256 * 1024;
const DEPENDENCY_DIRECTORIES = new Set(["node_modules", "vendor"]);
const BUILD_DIRECTORIES = new Set([
  ".cache",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "out",
  "target",
]);
const ALWAYS_IGNORED_DIRECTORIES = new Set([".git", ".hg", ".svn"]);
export const SUPPORTED_LOCKFILES = Object.freeze([
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
]);
const LOCKFILES = new Map(SUPPORTED_LOCKFILES);

function emptyExclusions() {
  return {
    ignored: 0,
    dependencies: 0,
    build_outputs: 0,
    binary: 0,
    large: 0,
    unsupported: 0,
    symlinks: 0,
    nested_repositories: 0,
    outside_root: 0,
    unreadable: 0,
  };
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function provenance(relativePath) {
  return { path: relativePath, collector: LOCAL_SAFE_SCAN_POLICY };
}

function isBinary(content) {
  if (content.includes(0)) return true;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    return [...text].some((character) => {
      const code = character.codePointAt(0);
      return (code < 32 && ![9, 10, 12, 13].includes(code)) || code === 127;
    });
  } catch {
    return true;
  }
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function scanRepository(selectedRoot) {
  const selectedPath = path.resolve(selectedRoot);
  const selectedStat = await lstat(selectedPath);
  if (selectedStat.isSymbolicLink()) {
    const error = new Error("Audit root cannot be a symlink.");
    error.code = "INVALID_AUDIT_ROOT";
    throw error;
  }
  if (!selectedStat.isDirectory()) {
    const error = new Error("Audit root is not a directory.");
    error.code = "INVALID_AUDIT_ROOT";
    throw error;
  }
  const root = await realpath(selectedPath);

  const facts = [];
  const errors = [];
  const exclusions = emptyExclusions();

  function exclude(reason) {
    exclusions[reason] += 1;
  }

  function recordError(code, relativePath) {
    errors.push({ code, path: relativePath });
    exclude(code === "outside_root" ? "outside_root" : "unreadable");
  }

  async function readSafeFile(absolutePath, relativePath, knownStat) {
    let handle;
    try {
      const currentStat = knownStat ?? await lstat(absolutePath);
      if (currentStat.isSymbolicLink()) {
        exclude("symlinks");
        return null;
      }
      if (!currentStat.isFile()) {
        exclude("unsupported");
        return null;
      }
      if (currentStat.size > MAX_SUPPORTED_FILE_BYTES) {
        exclude("large");
        return null;
      }
      const canonicalPath = await realpath(absolutePath);
      if (!isInside(root, canonicalPath)) {
        recordError("outside_root", relativePath);
        return null;
      }
      handle = await open(
        absolutePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const openedStat = await handle.stat();
      if (
        !openedStat.isFile()
        || openedStat.dev !== currentStat.dev
        || openedStat.ino !== currentStat.ino
      ) {
        recordError("outside_root", relativePath);
        return null;
      }
      if (openedStat.size > MAX_SUPPORTED_FILE_BYTES) {
        exclude("large");
        return null;
      }
      const content = await handle.readFile();
      if (isBinary(content)) {
        exclude("binary");
        return null;
      }
      return content.toString("utf8");
    } catch {
      recordError("unreadable", relativePath);
      return null;
    } finally {
      await handle?.close();
    }
  }

  async function walk(absoluteDirectory, relativeDirectory, inheritedRules) {
    let canonicalDirectory;
    let entries;
    try {
      canonicalDirectory = await realpath(absoluteDirectory);
      if (!isInside(root, canonicalDirectory)) {
        recordError("outside_root", relativeDirectory || ".");
        return;
      }
      entries = await readdir(canonicalDirectory, { withFileTypes: true });
    } catch {
      recordError("unreadable", relativeDirectory || ".");
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    let rules = inheritedRules;
    const ignoreEntry = entries.find((entry) => entry.name === ".gitignore" && entry.isFile());
    if (ignoreEntry) {
      const ignoreRelative = relativeDirectory
        ? `${relativeDirectory}/.gitignore`
        : ".gitignore";
      const ignoreContent = await readSafeFile(
        path.join(canonicalDirectory, ".gitignore"),
        ignoreRelative,
      );
      if (ignoreContent !== null) {
        rules = [...inheritedRules, ...parseIgnoreFile(ignoreContent, relativeDirectory)];
      } else {
        return;
      }
    }

    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(canonicalDirectory, entry.name);

      if (entry.isSymbolicLink()) {
        exclude("symlinks");
        continue;
      }

      if (entry.isDirectory()) {
        if (DEPENDENCY_DIRECTORIES.has(entry.name)) {
          exclude("dependencies");
          continue;
        }
        if (BUILD_DIRECTORIES.has(entry.name)) {
          exclude("build_outputs");
          continue;
        }
        if (ALWAYS_IGNORED_DIRECTORIES.has(entry.name)) {
          exclude("ignored");
          continue;
        }
        if (isIgnored(relativePath, rules)) {
          exclude("ignored");
          continue;
        }
        try {
          if (await pathExists(path.join(absolutePath, ".git"))) {
            exclude("nested_repositories");
            continue;
          }
        } catch {
          recordError("unreadable", relativePath);
          continue;
        }
        await walk(absolutePath, relativePath, rules);
        continue;
      }

      if (!entry.isFile()) {
        exclude("unsupported");
        continue;
      }

      const environmentFile = isEnvironmentFile(entry.name);
      if (!environmentFile && isIgnored(relativePath, rules)) {
        exclude("ignored");
        continue;
      }

      let stat;
      try {
        stat = await lstat(absolutePath);
      } catch {
        recordError("unreadable", relativePath);
        continue;
      }
      if (stat.size > MAX_SUPPORTED_FILE_BYTES) {
        exclude("large");
        continue;
      }

      const packageManager = LOCKFILES.get(entry.name);
      const classification = classifyContentFile(entry.name);
      if (!packageManager && !classification) {
        exclude("unsupported");
        continue;
      }

      if (packageManager && entry.name === "bun.lockb") {
        facts.push({
          kind: "lockfile",
          package_manager: packageManager,
          provenance: provenance(relativePath),
        });
        continue;
      }

      const content = await readSafeFile(absolutePath, relativePath, stat);
      if (content === null) continue;

      if (packageManager) {
        facts.push({
          kind: "lockfile",
          package_manager: packageManager,
          provenance: provenance(relativePath),
        });
      } else {
        facts.push(extractContentFact(
          classification,
          content,
          provenance(relativePath),
        ));
      }
    }
  }

  await walk(root, "", []);
  return { root: selectedPath, policy_version: LOCAL_SAFE_SCAN_POLICY, facts, exclusions, errors };
}
