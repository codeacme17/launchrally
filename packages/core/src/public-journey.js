import { PROTECTED_JOURNEY_SCHEMA } from "@launchrally/contracts";

const DECLARED_JOURNEY = /^([a-z]+)\s+(\/\S*)(?:\s+(?:—|-)\s+(.+))?$/iu;
const AUTHENTICATION_CLASSES = new Set(["user", "staff", "signed_token"]);
const PROTECTED_JOURNEY_PURPOSE = "authenticated Core Journey";
const SAFE_PROTECTED_PATH_SEGMENTS = new Set([
  "account", "accounts", "admin", "api", "app", "billing", "checkout",
  "authorize", "control", "dashboard", "files", "guardian", "health", "home", "inbox", "me",
  "orders", "organization", "organizations", "portal", "private", "profile",
  "protected", "session", "settings", "staff", "status", "team", "teams",
  "uploads", "user", "users", "v1", "v2", "v3", "workspace", "workspaces",
]);

function exactKeys(value, expected) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function statusCodes(value, minimum, maximum) {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 10
    && new Set(value).size === value.length
    && value.every((status) => Number.isInteger(status) && status >= minimum && status <= maximum);
}

function parseProtectedJourney(input) {
  if (!exactKeys(input, ["schema_version", "method", "path", "purpose", "access"])) {
    return { error: "invalid_protected_journey" };
  }
  const accessKeys = Object.keys(input.access ?? {});
  if (
    !accessKeys.every((key) => [
      "authentication_class",
      "anonymous_status_codes",
      "authenticated_status_codes",
    ].includes(key))
    || !["authentication_class", "authenticated_status_codes"].every(
      (key) => accessKeys.includes(key),
    )
  ) {
    return { error: "invalid_protected_journey" };
  }
  const journey = {
    schema_version: input.schema_version,
    method: typeof input.method === "string" ? input.method.toUpperCase() : "",
    path: typeof input.path === "string" ? input.path.trim() : "",
    purpose: typeof input.purpose === "string" && input.purpose.trim()
      ? PROTECTED_JOURNEY_PURPOSE
      : "",
    access: {
      authentication_class: input.access.authentication_class,
      ...(Object.hasOwn(input.access, "anonymous_status_codes")
        ? { anonymous_status_codes: input.access.anonymous_status_codes }
        : {}),
      authenticated_status_codes: input.access.authenticated_status_codes,
    },
  };
  return journey.schema_version === PROTECTED_JOURNEY_SCHEMA
    && journey.method === "GET"
    && safeJourneyPath(journey.path)
    && safeProtectedJourneyPath(journey.path)
    && journey.purpose === PROTECTED_JOURNEY_PURPOSE
    && AUTHENTICATION_CLASSES.has(journey.access.authentication_class)
    && (!Object.hasOwn(journey.access, "anonymous_status_codes")
      || statusCodes(journey.access.anonymous_status_codes, 300, 499))
    && statusCodes(journey.access.authenticated_status_codes, 200, 299)
    ? { value: journey }
    : { error: "invalid_protected_journey" };
}

function safeProtectedJourneyPath(value) {
  if (
    !safeJourneyPath(value)
    || value === "/"
    || value.endsWith("/")
    || value.includes("%")
  ) return false;
  return value.split("/").filter(Boolean).every((segment) =>
    SAFE_PROTECTED_PATH_SEGMENTS.has(segment));
}

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
    if (Object.hasOwn(input, "schema_version")) return parseProtectedJourney(input);
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
