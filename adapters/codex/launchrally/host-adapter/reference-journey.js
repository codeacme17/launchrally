import { runReferenceHostJourney } from "@launchrally/core";

export function runCodexReferenceJourney(source) {
  return runReferenceHostJourney({ ...source, host: "codex" });
}
