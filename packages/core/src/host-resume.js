import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rm } from "node:fs/promises";
import path from "node:path";

import {
  HOST_RESUME_ARTIFACT_SCHEMA,
  assertValidArchitectInteraction,
  assertValidHandoffInteraction,
  assertValidHostResumeArtifact,
} from "@launchrally/contracts";

import { sha256 } from "./local-history.js";

const HOSTS = new Set(["codex", "claude"]);
const MAX_ARTIFACT_BYTES = 256 * 1024;

async function safeArtifactHandle(selectedPath) {
  const stat = await lstat(selectedPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARTIFACT_BYTES) {
    const error = new Error("The Host Resume Artifact path is unsafe.");
    error.code = "unsafe_host_resume_artifact";
    throw error;
  }
  const handle = await open(
    selectedPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const opened = await handle.stat();
  if (
    !opened.isFile()
    || opened.dev !== stat.dev
    || opened.ino !== stat.ino
    || (process.platform !== "win32"
      && (opened.uid !== process.getuid() || (opened.mode & 0o077) !== 0))
  ) {
    await handle.close();
    const error = new Error("The Host Resume Artifact changed while it was opened.");
    error.code = "unsafe_host_resume_artifact";
    throw error;
  }
  return handle;
}

export function createHostResumeArtifact(host, interaction) {
  if (!HOSTS.has(host) || !interaction?.resume_token) {
    const error = new Error("A supported host and resumable interaction are required.");
    error.code = "invalid_host_resume_source";
    throw error;
  }
  if (interaction.operation === "architect") assertValidArchitectInteraction(interaction);
  else if (interaction.operation === "handoff") assertValidHandoffInteraction(interaction);
  else {
    const error = new Error("Only Architecture and Handoff interactions are cross-host resumable.");
    error.code = "unsupported_host_resume_operation";
    throw error;
  }
  const content = {
    schema_version: HOST_RESUME_ARTIFACT_SCHEMA,
    origin_host: host,
    operation: interaction.operation,
    state: interaction.state,
    resume_token: interaction.resume_token,
    source_refs: structuredClone(interaction.source_refs),
  };
  const artifactDigest = sha256(content);
  const artifact = {
    ...content,
    artifact_id: `host_resume_${artifactDigest.slice(7, 27)}`,
    artifact_digest: artifactDigest,
  };
  assertValidHostResumeArtifact(artifact);
  return artifact;
}

export async function writeHostResumeArtifact(selectedPath, host, interaction) {
  const artifact = createHostResumeArtifact(host, interaction);
  const target = path.resolve(selectedPath);
  await lstat(target).then(() => {
    const conflict = new Error("The Host Resume Artifact output already exists.");
    conflict.code = "host_resume_artifact_exists";
    throw conflict;
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
      const conflict = new Error("The Host Resume Artifact output already exists.");
      conflict.code = "host_resume_artifact_exists";
      throw conflict;
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
    const invalid = new Error("The Host Resume Artifact could not be read safely.");
    invalid.code = "invalid_host_resume_artifact";
    throw invalid;
  } finally {
    await handle?.close();
  }
}

export async function resumeFromHostArtifact({
  host,
  cwd,
  artifact,
  options = {},
  run_architect: runArchitect,
  run_handoff: runHandoff,
}) {
  if (!HOSTS.has(host)) {
    const error = new Error("The target host is unsupported.");
    error.code = "unsupported_host_resume_target";
    throw error;
  }
  assertValidHostResumeArtifact(artifact);
  if (artifact.origin_host === host) {
    const error = new Error("Cross-host resume requires a different supported target host.");
    error.code = "same_host_resume_artifact";
    throw error;
  }
  const resumeOptions = { ...options, resume_token: artifact.resume_token };
  if (artifact.operation === "architect") {
    if (typeof runArchitect !== "function") {
      const error = new Error("The Architecture resume capability is unavailable in this host.");
      error.code = "host_capability_unavailable";
      throw error;
    }
    const result = await runArchitect(cwd, {}, resumeOptions);
    if (result?.error === "invalid_resume_token") {
      const error = new Error("The Host Resume Artifact does not match current local state.");
      error.code = "stale_host_resume_artifact";
      throw error;
    }
    return result;
  }
  if (typeof runHandoff !== "function") {
    const error = new Error("The Handoff resume capability is unavailable in this host.");
    error.code = "host_capability_unavailable";
    throw error;
  }
  const result = await runHandoff({}, resumeOptions);
  if (result?.error === "invalid_resume_token") {
    const error = new Error("The Host Resume Artifact does not match current local state.");
    error.code = "stale_host_resume_artifact";
    throw error;
  }
  return result;
}

export async function resumeFromHostArtifactFile({ artifact_path: artifactPath, ...options }) {
  return resumeFromHostArtifact({
    ...options,
    artifact: await readHostResumeArtifact(artifactPath),
  });
}
