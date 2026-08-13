import {
  createHostResumeArtifact,
  resumeFromHostArtifact,
  resumeFromHostArtifactFile,
  runArchitectureJourney,
  runHandoff,
  writeHostResumeArtifact,
} from "@launchrally/core";

export function createResumeArtifact(interaction, cwd = process.cwd()) {
  return createHostResumeArtifact(cwd, "codex", interaction);
}

export function saveResumeArtifact(selectedPath, interaction, cwd = process.cwd()) {
  return writeHostResumeArtifact(selectedPath, cwd, "codex", interaction);
}

export function resumeArtifact({ cwd, artifact, options }) {
  return resumeFromHostArtifact({
    host: "codex",
    cwd,
    artifact,
    options,
    run_architect: runArchitectureJourney,
    run_handoff: runHandoff,
  });
}

export function resumeArtifactFile({ cwd, artifact_path: artifactPath, options }) {
  return resumeFromHostArtifactFile({
    host: "codex",
    cwd,
    artifact_path: artifactPath,
    options,
    run_architect: runArchitectureJourney,
    run_handoff: runHandoff,
  });
}
