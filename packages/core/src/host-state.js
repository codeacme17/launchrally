import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  HOST_RESUME_DIRECTORY,
  ensurePrivateDirectory,
  getHostResumeKey,
} from "./host-key.js";

const TOKEN = /^lr(architect|handoff)_([A-Za-z0-9_-]{43})$/u;

function stateDirectory(kind) {
  return path.join(HOST_RESUME_DIRECTORY, `${kind}-states`);
}

function selectedState(kind, token) {
  const match = typeof token === "string" ? token.match(TOKEN) : null;
  return match?.[1] === kind ? path.join(stateDirectory(kind), `${match[2]}.json`) : null;
}

function seal(state) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getHostResumeKey(), nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
  return {
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

function openState(value) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    getHostResumeKey(),
    Buffer.from(value.nonce, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8"));
}

function safeRead(selected) {
  const stat = lstatSync(selected);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  const handle = openSync(selected, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(handle);
    if (
      opened.dev !== stat.dev
      || opened.ino !== stat.ino
      || (process.platform !== "win32"
        && (opened.uid !== process.getuid() || (opened.mode & 0o077) !== 0))
    ) return null;
    return JSON.parse(readFileSync(handle, "utf8"));
  } finally {
    closeSync(handle);
  }
}

export function storeHostState(kind, state) {
  const directory = stateDirectory(kind);
  getHostResumeKey();
  ensurePrivateDirectory(directory);
  const id = randomBytes(32).toString("base64url");
  const selected = path.join(directory, `${id}.json`);
  const handle = openSync(selected, "wx", 0o600);
  try {
    writeFileSync(handle, `${JSON.stringify(seal(state))}\n`, "utf8");
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  return `lr${kind}_${id}`;
}

export function loadHostState(kind, token) {
  const selected = selectedState(kind, token);
  if (!selected) return null;
  try {
    return openState(safeRead(selected));
  } catch {
    return null;
  }
}

export function saveHostState(kind, state, token) {
  const selected = selectedState(kind, token);
  if (!selected) return false;
  const temporary = `${selected}.tmp-${randomUUID()}`;
  try {
    const handle = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(handle, `${JSON.stringify(seal(state))}\n`, "utf8");
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temporary, selected);
    return true;
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
