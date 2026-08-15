import { resumeAuthenticatedJourneyFromHost } from "@launchrally/core";

export function resumeAuthenticatedJourney(options) {
  return resumeAuthenticatedJourneyFromHost({
    ...options,
    host: "claude",
    version: "0.4.0",
  });
}
