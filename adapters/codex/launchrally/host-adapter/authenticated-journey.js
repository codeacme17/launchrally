import { resumeAuthenticatedJourneyFromHost } from "@launchrally/core";

export function resumeAuthenticatedJourney(options) {
  return resumeAuthenticatedJourneyFromHost({
    ...options,
    host: "codex",
    version: "0.4.1",
  });
}
