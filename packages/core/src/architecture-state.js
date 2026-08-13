import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_TOKEN = /^lrarchitect_([A-Za-z0-9]{6}|[A-Za-z0-9]{12})_([A-Za-z0-9_-]{43})$/u;

function statePath(token) {
  const match = typeof token === "string" ? token.match(STATE_TOKEN) : null;
  return match
    ? path.join(os.tmpdir(), `launchrally-architect-${match[1]}`, `${match[2]}.json`)
    : null;
}

export function storeArchitectureState(state) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "launchrally-architect-"));
  const directoryToken = path.basename(directory).slice("launchrally-architect-".length);
  const fileToken = randomBytes(32).toString("base64url");
  writeFileSync(path.join(directory, `${fileToken}.json`), `${JSON.stringify(state)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return `lrarchitect_${directoryToken}_${fileToken}`;
}

export function loadArchitectureState(token) {
  const selected = statePath(token);
  if (!selected) return null;
  try {
    return JSON.parse(readFileSync(selected, "utf8"));
  } catch {
    return null;
  }
}
