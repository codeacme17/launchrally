import { randomUUID } from "node:crypto";
import { lstat, link, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const LOCK_SCHEMA = "launchrally.dev/owned-lock/v1";
const TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const NAME = /^[a-z][a-z0-9-]{0,63}$/u;

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function lockOperations(overrides = {}) {
  return {
    mkdir,
    write_file: (target, content, options) => writeFile(target, content, options),
    link,
    remove: (target, options) => rm(target, options),
    ...overrides,
  };
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function lockRecord(target) {
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid_lock_type");
  const content = await readFile(target, "utf8");
  const value = JSON.parse(content);
  if (
    value?.schema_version !== LOCK_SCHEMA
    || !NAME.test(value.name)
    || !TOKEN.test(value.token)
    || !Number.isInteger(value.owner_pid)
    || value.owner_pid < 1
  ) throw new Error("invalid_lock_record");
  return { stat, content, value };
}

export async function ensureOwnedLockDirectory(target, overrides = {}) {
  const ops = lockOperations(overrides);
  const canonicalParent = await realpath(path.dirname(path.resolve(target)));
  const canonicalTarget = path.join(canonicalParent, path.basename(target));
  try {
    const existing = await lstat(canonicalTarget);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      const error = new Error("The lock directory is not a real directory.");
      error.code = "invalid_owned_lock";
      throw error;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    try {
      await ops.mkdir(canonicalTarget, { recursive: false, mode: 0o700 });
    } catch (mkdirError) {
      if (mkdirError?.code !== "EEXIST") throw mkdirError;
    }
    const created = await lstat(canonicalTarget);
    if (!created.isDirectory() || created.isSymbolicLink()) {
      const invalid = new Error("The lock directory was redirected during creation.");
      invalid.code = "invalid_owned_lock";
      throw invalid;
    }
  }
  return canonicalTarget;
}

export async function acquireOwnedLock(root, name, overrides = {}) {
  if (!NAME.test(name)) throw new Error("invalid_lock_name");
  const ops = lockOperations(overrides);
  const token = randomUUID();
  const lockRoot = await ensureOwnedLockDirectory(root, overrides);
  const owners = await ensureOwnedLockDirectory(path.join(lockRoot, "owners"), overrides);
  const canonical = path.join(lockRoot, `${name}.lock`);
  const owner = path.join(owners, `${name}-${token}.lock`);
  const content = `${JSON.stringify({
    schema_version: LOCK_SCHEMA,
    name,
    token,
    owner_pid: process.pid,
  })}\n`;
  await ops.write_file(owner, content, { encoding: "utf8", flag: "wx", mode: 0o600 });

  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await ops.link(owner, canonical);
        return async () => {
          let canonicalReleased = false;
          for (let releaseAttempt = 0; releaseAttempt < 2; releaseAttempt += 1) {
            try {
              const [current, owned] = await Promise.all([
                lockRecord(canonical),
                lockRecord(owner),
              ]);
              if (
                current.content !== content
                || owned.content !== content
                || !sameFile(current.stat, owned.stat)
              ) break;
              await ops.remove(canonical, { force: false });
              canonicalReleased = true;
              break;
            } catch (error) {
              if (error?.code === "ENOENT") {
                canonicalReleased = true;
                break;
              }
            }
          }
          if (canonicalReleased) await ops.remove(owner, { force: true }).catch(() => {});
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }

      let current;
      try {
        current = await lockRecord(canonical);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        const invalid = new Error("The lock is invalid and was preserved.");
        invalid.code = "invalid_owned_lock";
        throw invalid;
      }
      if (current.value.name !== name) {
        const invalid = new Error("The lock name is invalid and was preserved.");
        invalid.code = "invalid_owned_lock";
        throw invalid;
      }
      const currentOwner = path.join(
        owners,
        `${name}-${current.value.token}.lock`,
      );
      let currentOwnerRecord;
      let reconstructedOwner = false;
      try {
        currentOwnerRecord = await lockRecord(currentOwner);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          const invalid = new Error("The lock owner is invalid and was preserved.");
          invalid.code = "invalid_owned_lock";
          throw invalid;
        }
        if (processIsAlive(current.value.owner_pid)) {
          const busy = new Error("The recorded lock owner is still alive.");
          busy.code = "owned_lock_busy";
          throw busy;
        }
        try {
          await ops.link(canonical, currentOwner);
          reconstructedOwner = true;
          currentOwnerRecord = await lockRecord(currentOwner);
        } catch (linkError) {
          if (!["EEXIST", "ENOENT"].includes(linkError?.code)) throw linkError;
          continue;
        }
      }
      if (
        currentOwnerRecord.content !== current.content
        || !sameFile(currentOwnerRecord.stat, current.stat)
      ) {
        if (reconstructedOwner) {
          try {
            const reconstructed = await lockRecord(currentOwner);
            if (
              reconstructed.content === currentOwnerRecord.content
              && sameFile(reconstructed.stat, currentOwnerRecord.stat)
            ) await ops.remove(currentOwner, { force: false });
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
          continue;
        }
        const invalid = new Error("The lock owner does not match and was preserved.");
        invalid.code = "invalid_owned_lock";
        throw invalid;
      }
      if (processIsAlive(current.value.owner_pid)) {
        const busy = new Error("Another owner holds the lock.");
        busy.code = "owned_lock_busy";
        throw busy;
      }

      try {
        await ops.remove(currentOwner, { force: false });
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      let claimed;
      try {
        claimed = await lockRecord(canonical);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (claimed.content === current.content && sameFile(claimed.stat, current.stat)) {
        try {
          await ops.remove(canonical, { force: false });
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    }
    const busy = new Error("The lock could not be acquired safely.");
    busy.code = "owned_lock_busy";
    throw busy;
  } catch (error) {
    await ops.remove(owner, { force: true }).catch(() => {});
    throw error;
  }
}
