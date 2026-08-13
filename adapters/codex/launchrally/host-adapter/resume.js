import {
  createHostResumeArtifact,
  resumeFromHostArtifact,
  resumeFromHostArtifactFile,
  runArchitectureJourney,
  runHandoff,
  writeHostResumeArtifact,
} from "@launchrally/core";

export function createResumeArtifact(interaction) {
  return createHostResumeArtifact("codex", interaction);
}

export function saveResumeArtifact(selectedPath, interaction) {
  return writeHostResumeArtifact(selectedPath, "codex", interaction);
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
