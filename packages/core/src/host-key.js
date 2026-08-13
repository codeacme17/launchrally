import { randomBytes, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const accountHome = os.userInfo().homedir;
export const HOST_RESUME_ROOT = path.join(accountHome, ".launchrally");
export const HOST_RESUME_DIRECTORY = path.join(HOST_RESUME_ROOT, "host-resume-v1");
const KEY_PATH = path.join(HOST_RESUME_DIRECTORY, "key");

function invalid(message) {
  const error = new Error(message);
  error.code = "unsafe_host_resume_key";
  return error;
}

export function ensurePrivateDirectory(selected) {
  try {
    mkdirSync(selected, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stat = lstatSync(selected);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (process.platform !== "win32"
      && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
  ) throw invalid("The host-owned resume registry is unsafe.");
}

export function getHostResumeKey() {
  if (process.platform === "win32") {
    const error = new Error("Cross-host resume requires a protected host key store.");
    error.code = "host_resume_unavailable";
    throw error;
  }
  ensurePrivateDirectory(HOST_RESUME_ROOT);
  ensurePrivateDirectory(HOST_RESUME_DIRECTORY);
  const temporary = path.join(HOST_RESUME_DIRECTORY, `.key-${randomUUID()}`);
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, randomBytes(32));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, KEY_PATH);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const stat = lstatSync(KEY_PATH);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 32) {
    throw invalid("The host-owned resume key is unsafe.");
  }
  const handle = openSync(KEY_PATH, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(handle);
    if (
      opened.dev !== stat.dev
      || opened.ino !== stat.ino
      || (process.platform !== "win32"
        && (opened.uid !== process.getuid() || (opened.mode & 0o077) !== 0))
    ) throw invalid("The host-owned resume key changed while it was opened.");
    return readFileSync(handle);
  } finally {
    closeSync(handle);
  }
}
