import {
  createHostResumeArtifact,
  resumeFromHostArtifact,
  resumeFromHostArtifactFile,
  runArchitectureJourney,
  runHandoff,
  writeHostResumeArtifact,
} from "@launchrally/core";

export function createResumeArtifact(interaction, cwd = process.cwd()) {
  return createHostResumeArtifact(cwd, "claude", interaction);
}

export function saveResumeArtifact(selectedPath, interaction, cwd = process.cwd()) {
  return writeHostResumeArtifact(selectedPath, cwd, "claude", interaction);
}

export function resumeArtifact({ cwd, artifact, options }) {
  return resumeFromHostArtifact({
    host: "claude",
    cwd,
    artifact,
    options,
    run_architect: runArchitectureJourney,
    run_handoff: runHandoff,
  });
}

export function resumeArtifactFile({ cwd, artifact_path: artifactPath, options }) {
  return resumeFromHostArtifactFile({
    host: "claude",
    cwd,
    artifact_path: artifactPath,
    options,
    run_architect: runArchitectureJourney,
    run_handoff: runHandoff,
  });
}
