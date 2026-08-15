import { runReferenceHostJourney } from "@launchrally/core";

export function runClaudeReferenceJourney(source) {
  return runReferenceHostJourney({ ...source, host: "claude" });
}
