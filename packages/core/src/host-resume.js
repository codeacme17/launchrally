import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

import {
  HOST_RESUME_ARTIFACT_SCHEMA,
  assertValidArchitectInteraction,
  assertValidHandoffInteraction,
  assertValidHostResumeArtifact,
} from "@launchrally/contracts";

import { loadArchitectureState, storeArchitectureState } from "./architecture-state.js";
import { loadHandoffState, storeHandoffState } from "./handoff.js";
import { sha256 } from "./local-history.js";
import { getHostResumeKey } from "./host-key.js";

const HOSTS = new Set(["codex", "claude"]);
const MAX_ARTIFACT_BYTES = 256 * 1024;

async function canonicalArtifactPath(selectedPath) {
  const parent = await realpath(path.dirname(path.resolve(selectedPath)));
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw invalid("unsafe_host_resume_artifact", "The Host Resume Artifact parent is unsafe.");
  }
  return path.join(parent, path.basename(selectedPath));
}

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

function interactionStateForState(state) {
  return state?.stage === "p1_migration_preview" ? "blueprint_review" : state?.stage;
}

async function trustedState(operation, resumeToken) {
  if (operation === "handoff") return loadHandoffState(resumeToken);
  return loadArchitectureState(resumeToken);
}

async function createArtifact(host, interaction, suppliedKey) {
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
    interactionStateForState(state) !== interaction.state
    || JSON.stringify(sourceRefsForState(state)) !== JSON.stringify(interaction.source_refs)
  ) throw invalid("invalid_host_resume_source", "The interaction does not match local state.");
  const key = suppliedKey ?? getHostResumeKey();
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

export async function createHostResumeArtifact(cwd, host, interaction) {
  void cwd;
  return createArtifact(host, interaction);
}

export async function writeHostResumeArtifact(selectedPath, cwd, host, interaction) {
  const target = await canonicalArtifactPath(selectedPath);
  const targetExists = await lstat(target).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
  if (targetExists) {
    throw invalid("host_resume_artifact_exists", "The Host Resume Artifact output exists.");
  }
  const key = getHostResumeKey();
  const artifact = await createArtifact(host, interaction, key);
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
    handle = await safeArtifactHandle(await canonicalArtifactPath(selectedPath));
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

async function verifyArtifact(artifact, suppliedKey) {
  assertValidHostResumeArtifact(artifact);
  const key = suppliedKey ?? getHostResumeKey();
  const expected = Buffer.from(attestation(key, artifactContent(artifact)));
  const actual = Buffer.from(artifact.attestation);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw invalid("invalid_host_resume_attestation", "The Host Resume Artifact is untrusted.");
  }
  const state = openState(key, artifact.portable_state);
  if (artifact.operation === "handoff") {
    if (
      interactionStateForState(state) !== artifact.state
      || JSON.stringify(sourceRefsForState(state)) !== JSON.stringify(artifact.source_refs)
    ) throw invalid("invalid_host_resume_artifact", "The Handoff state binding is invalid.");
  } else if (
    interactionStateForState(state) !== artifact.state
    || JSON.stringify(sourceRefsForState(state))
      !== JSON.stringify(artifact.source_refs)
  ) {
    throw invalid("invalid_host_resume_artifact", "The Architecture state binding is invalid.");
  }
  return state;
}

async function resumeVerifiedArtifact({
  host,
  cwd,
  artifact,
  options = {},
  run_architect: runArchitect,
  run_handoff: runHandoff,
  artifactKey,
}) {
  if (!HOSTS.has(host)) throw invalid("unsupported_host_resume_target", "Unsupported host.");
  const portableState = await verifyArtifact(artifact, artifactKey);
  if (artifact.origin_host === host) {
    throw invalid("same_host_resume_artifact", "Cross-host resume needs another host.");
  }
  if (artifact.operation === "architect") {
    const importedToken = storeArchitectureState(portableState);
    const result = await runArchitect(cwd, {}, { ...options, resume_token: importedToken });
    if (result?.error === "invalid_resume_token") {
      throw invalid("stale_host_resume_artifact", "The Architecture state is unavailable.");
    }
    return result;
  }
  const importedToken = await storeHandoffState(portableState);
  return runHandoff({}, { ...options, resume_token: importedToken }, {
    now: options.now,
  });
}

export async function resumeFromHostArtifact({
  host,
  cwd,
  artifact,
  options,
  run_architect: runArchitect,
  run_handoff: runHandoff,
}) {
  return resumeVerifiedArtifact({
    host,
    cwd,
    artifact,
    options,
    run_architect: runArchitect,
    run_handoff: runHandoff,
  });
}

export async function resumeFromHostArtifactFile({ artifact_path: artifactPath, ...options }) {
  const artifact = await readHostResumeArtifact(artifactPath);
  const key = getHostResumeKey();
  return resumeVerifiedArtifact({
    ...options,
    artifact,
    artifactKey: key,
  });
}
