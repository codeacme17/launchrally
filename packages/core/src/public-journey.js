const DECLARED_JOURNEY = /^([a-z]+)\s+(\/\S*)(?:\s+(?:—|-)\s+(.+))?$/iu;

function safeJourneyPath(journeyPath) {
  return journeyPath.startsWith("/")
    && !journeyPath.startsWith("//")
    && !journeyPath.includes("\\")
    && !journeyPath.includes("?")
    && !journeyPath.includes("#");
}

function defaultJourneyPurpose(journeyPath) {
  return journeyPath === "/" ? "homepage loads" : `${journeyPath} loads`;
}

export function parsePublicJourneyInput(input, { allowDescription = true } = {}) {
  if (typeof input === "object" && input !== null) {
    const journey = {
      method: typeof input.method === "string" ? input.method.toUpperCase() : "",
      path: typeof input.path === "string" ? input.path.trim() : "",
      purpose: typeof input.purpose === "string" ? input.purpose.trim() : "",
    };
    return journey.method === "GET" && safeJourneyPath(journey.path) && journey.purpose
      ? { value: journey }
      : { error: "invalid_public_journey" };
  }
  if (typeof input !== "string" || !input.trim()) {
    return { error: "invalid_public_journey" };
  }
  const description = input.trim();
  const declared = description.match(DECLARED_JOURNEY);
  if (!declared) {
    return allowDescription && !/^[a-z]+\s+\//iu.test(description)
      ? { value: description }
      : { error: "invalid_public_journey" };
  }
  const journey = {
    method: declared[1].toUpperCase(),
    path: declared[2],
    purpose: declared[3]?.trim() || defaultJourneyPurpose(declared[2]),
  };
  return journey.method === "GET" && safeJourneyPath(journey.path) && journey.purpose
    ? { value: journey }
    : { error: "invalid_public_journey" };
}
