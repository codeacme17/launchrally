import { constants as fsConstants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

async function destinationWithCanonicalParent(destination) {
  try {
    const parent = await realpath(path.dirname(destination));
    return path.join(parent, path.basename(destination));
  } catch {
    return path.resolve(destination);
  }
}

async function canonicalLaunchRallyRoot(cwd) {
  const launchRallyRoot = path.resolve(cwd, ".launchrally");
  try {
    return await realpath(launchRallyRoot);
  } catch {
    return destinationWithCanonicalParent(launchRallyRoot);
  }
}

function comparablePath(value, platform) {
  return ["darwin", "win32"].includes(platform) ? value.toLowerCase() : value;
}

function isPathWithin(root, candidate, platform) {
  const relative = path.relative(
    comparablePath(root, platform),
    comparablePath(candidate, platform),
  );
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function isLaunchRallyDestination(
  cwd,
  destination,
  { platform = process.platform, signal } = {},
) {
  signal?.throwIfAborted();
  const lexicalLaunchRallyRoot = path.resolve(cwd, ".launchrally");
  const lexicalCandidate = path.resolve(destination);
  if (isPathWithin(lexicalLaunchRallyRoot, lexicalCandidate, platform)) return true;

  const launchRallyRoot = await canonicalLaunchRallyRoot(cwd);
  signal?.throwIfAborted();
  const candidate = await destinationWithCanonicalParent(destination);
  signal?.throwIfAborted();
  return isPathWithin(launchRallyRoot, candidate, platform);
}

export async function inspectReportDestination(destination, { signal } = {}) {
  signal?.throwIfAborted();
  if (destination.includes("\0")) return { valid: false, reason: "invalid_path" };

  const parent = path.dirname(destination);
  let parentStat;
  try {
    parentStat = await stat(parent);
  } catch {
    signal?.throwIfAborted();
    return { valid: false, reason: "parent_unavailable" };
  }
  signal?.throwIfAborted();
  if (!parentStat.isDirectory()) return { valid: false, reason: "parent_not_directory" };
  try {
    await access(parent, fsConstants.W_OK);
  } catch {
    signal?.throwIfAborted();
    return { valid: false, reason: "parent_not_writable" };
  }
  signal?.throwIfAborted();

  let destinationStat;
  try {
    destinationStat = await lstat(destination);
  } catch (error) {
    signal?.throwIfAborted();
    return error?.code === "ENOENT"
      ? { valid: true, collision: false }
      : { valid: false, reason: "destination_unavailable" };
  }
  if (destinationStat.isSymbolicLink() || !destinationStat.isFile()) {
    return { valid: false, reason: "destination_not_file" };
  }
  try {
    await access(destination, fsConstants.W_OK);
  } catch {
    signal?.throwIfAborted();
    return { valid: false, reason: "destination_not_writable" };
  }
  signal?.throwIfAborted();
  return { valid: true, collision: true };
}
