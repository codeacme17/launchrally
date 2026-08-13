import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  HOST_RESUME_ARTIFACT_SCHEMA,
  assertValidArchitectInteraction,
  assertValidHandoffInteraction,
  assertValidHostResumeArtifact,
} from "@launchrally/contracts";

import { loadArchitectureState } from "./architecture-state.js";
import { loadHandoffState } from "./handoff.js";
import { sha256 } from "./local-history.js";

const HOSTS = new Set(["codex", "claude"]);
const MAX_ARTIFACT_BYTES = 256 * 1024;
const KEY_PATH = ".launchrally/phase-1/transactions/.host-resume-key";

function invalid(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function safeArtifactHandle(selectedPath) {
  const stat = await lstat(selectedPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARTIFACT_BYTES) {
    throw invalid("unsafe_host_resume_artifact", "The Host Resume Artifact path is unsafe.");
  }
  const handle = await open(selectedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const opened = await handle.stat();
  if (
    !opened.isFile()
    || opened.dev !== stat.dev
    || opened.ino !== stat.ino
    || (process.platform !== "win32"
      && (opened.uid !== process.getuid() || (opened.mode & 0o077) !== 0))
  ) {
    await handle.close();
    throw invalid(
      "unsafe_host_resume_artifact",
      "The Host Resume Artifact changed while it was opened.",
    );
  }
  return handle;
}

async function resumeKey(cwd) {
  const selected = path.join(path.resolve(cwd), KEY_PATH);
  const stat = await lstat(selected);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 32) {
    throw invalid("host_resume_unavailable", "Phase 1 host resume is not available.");
  }
  const handle = await open(selected, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== stat.dev
      || opened.ino !== stat.ino
      || (process.platform !== "win32"
        && (opened.uid !== process.getuid() || (opened.mode & 0o077) !== 0))
    ) throw invalid("host_resume_unavailable", "Phase 1 host resume is not available.");
    return handle.readFile();
  } finally {
    await handle.close();
  }
}

function artifactContent(artifact) {
  return Object.fromEntries(Object.entries(artifact).filter(([key]) =>
    !["artifact_id", "artifact_digest", "attestation"].includes(key)));
}

function attestation(key, content) {
  return createHmac("sha256", key).update(JSON.stringify(content)).digest("base64url");
}

function sealState(key, state) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(state), "utf8"),
    cipher.final(),
  ]);
  return {
    algorithm: "aes-256-gcm",
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

function openState(key, sealed) {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(sealed.nonce, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
    return JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8"));
  } catch {
    throw invalid("invalid_host_resume_attestation", "The portable state is untrusted.");
  }
}

function sourceRefsForState(state) {
  return structuredClone(state?.source_refs ?? []);
}

async function trustedState(operation, resumeToken) {
  if (operation === "handoff") return loadHandoffState(resumeToken);
  return loadArchitectureState(resumeToken);
}

export async function createHostResumeArtifact(cwd, host, interaction) {
  if (!HOSTS.has(host) || !interaction?.resume_token) {
    throw invalid("invalid_host_resume_source", "A supported resumable interaction is required.");
  }
  if (interaction.operation === "architect") assertValidArchitectInteraction(interaction);
  else if (interaction.operation === "handoff") assertValidHandoffInteraction(interaction);
  else throw invalid(
    "unsupported_host_resume_operation",
    "Only Architecture and Handoff interactions are cross-host resumable.",
  );
  const state = await trustedState(interaction.operation, interaction.resume_token);
  if (!state) {
    throw invalid("stale_host_resume_artifact", "The local interaction state is unavailable.");
  }
  if (
    state.stage !== interaction.state
    || JSON.stringify(sourceRefsForState(state)) !== JSON.stringify(interaction.source_refs)
  ) throw invalid("invalid_host_resume_source", "The interaction does not match local state.");
  const key = await resumeKey(cwd);
  const content = {
    schema_version: HOST_RESUME_ARTIFACT_SCHEMA,
    origin_host: host,
    operation: interaction.operation,
    state: interaction.state,
    resume_token: interaction.resume_token,
    source_refs: structuredClone(interaction.source_refs),
    portable_state: sealState(key, state),
  };
  const artifactDigest = sha256(content);
  const artifact = {
    ...content,
    artifact_id: `host_resume_${artifactDigest.slice(7, 27)}`,
    artifact_digest: artifactDigest,
    attestation: attestation(key, content),
  };
  const bytes = Buffer.byteLength(`${JSON.stringify(artifact)}\n`);
  if (bytes > MAX_ARTIFACT_BYTES) {
    throw invalid("host_resume_artifact_too_large", "The Host Resume Artifact is too large.");
  }
  assertValidHostResumeArtifact(artifact);
  return artifact;
}

export async function writeHostResumeArtifact(selectedPath, cwd, host, interaction) {
  const artifact = await createHostResumeArtifact(cwd, host, interaction);
  const target = path.resolve(selectedPath);
  await lstat(target).then(() => {
    throw invalid("host_resume_artifact_exists", "The Host Resume Artifact output exists.");
  }, (error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  const temporary = `${target}.tmp-${randomUUID()}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, target);
    await rm(temporary);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    if (error?.code === "EEXIST") {
      throw invalid("host_resume_artifact_exists", "The Host Resume Artifact output exists.");
    }
    throw error;
  }
  return artifact;
}

export async function readHostResumeArtifact(selectedPath) {
  let handle;
  try {
    handle = await safeArtifactHandle(path.resolve(selectedPath));
    const artifact = JSON.parse(await handle.readFile("utf8"));
    assertValidHostResumeArtifact(artifact);
    return artifact;
  } catch (error) {
    if (["invalid_host_resume_artifact", "unsafe_host_resume_artifact"].includes(error?.code)) {
      throw error;
    }
    throw invalid("invalid_host_resume_artifact", "The Host Resume Artifact could not be read.");
  } finally {
    await handle?.close();
  }
}

async function verifyArtifact(cwd, artifact) {
  assertValidHostResumeArtifact(artifact);
  const key = await resumeKey(cwd);
  const expected = Buffer.from(attestation(key, artifactContent(artifact)));
  const actual = Buffer.from(artifact.attestation);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw invalid("invalid_host_resume_attestation", "The Host Resume Artifact is untrusted.");
  }
  const state = openState(key, artifact.portable_state);
  if (artifact.operation === "handoff") {
    if (
      state?.stage !== artifact.state
      || JSON.stringify(sourceRefsForState(state)) !== JSON.stringify(artifact.source_refs)
    ) throw invalid("invalid_host_resume_artifact", "The Handoff state binding is invalid.");
  } else if (
    state?.stage !== artifact.state
    || JSON.stringify(sourceRefsForState(state))
      !== JSON.stringify(artifact.source_refs)
  ) {
    throw invalid("invalid_host_resume_artifact", "The Architecture state binding is invalid.");
  }
  return state;
}

export async function resumeFromHostArtifact({
  host,
  cwd,
  artifact,
  options = {},
  run_architect: runArchitect,
  run_handoff: runHandoff,
}) {
  if (!HOSTS.has(host)) throw invalid("unsupported_host_resume_target", "Unsupported host.");
  const portableState = await verifyArtifact(cwd, artifact);
  if (artifact.origin_host === host) {
    throw invalid("same_host_resume_artifact", "Cross-host resume needs another host.");
  }
  const resumeOptions = { ...options, resume_token: artifact.resume_token };
  if (artifact.operation === "architect") {
    const result = await runArchitect(cwd, {}, resumeOptions, {
      load_state: (token) => token === artifact.resume_token
        ? structuredClone(portableState)
        : null,
    });
    if (result?.error === "invalid_resume_token") {
      throw invalid("stale_host_resume_artifact", "The Architecture state is unavailable.");
    }
    return result;
  }
  return runHandoff({}, resumeOptions, {
    load_state: async (token) => token === artifact.resume_token
      ? structuredClone(portableState)
      : null,
    save_state: async () => true,
    now: options.now,
  });
}

export async function resumeFromHostArtifactFile({ artifact_path: artifactPath, ...options }) {
  return resumeFromHostArtifact({
    ...options,
    artifact: await readHostResumeArtifact(artifactPath),
  });
}
