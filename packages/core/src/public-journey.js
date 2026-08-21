import {
  PROTECTED_JOURNEY_PATH_PATTERN,
  PROTECTED_JOURNEY_SCHEMA,
} from "@launchrally/contracts";

const DECLARED_JOURNEY = /^([a-z]+)\s+(\/\S*)(?:\s+(?:—|-)\s+(.+))?$/iu;
const AUTHENTICATION_CLASSES = new Set(["user", "staff", "signed_token"]);
const PROTECTED_JOURNEY_PURPOSE = "authenticated Core Journey";
const SAFE_PROTECTED_JOURNEY_PATH = new RegExp(PROTECTED_JOURNEY_PATH_PATTERN, "u");
const OPAQUE_PROTECTED_JOURNEY_SEGMENT = /^(?:[0-9]{8,64}|[a-f0-9]{32,64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/u;
const ABSOLUTE_TARGET = /^[a-z][a-z0-9+.-]*:\/\//iu;
const DYNAMIC_PATH_MARKER = /[:*\[\]{}$]/u;
const PROTECTED_JOURNEY_GUIDANCE = Object.freeze({
  non_get_method: "protected access supports only GET",
  root_path: "protected access requires a non-root path; classify / as Public or Exclude",
  protocol_relative_path: "protected access rejects protocol-relative paths; supply an exact same-origin path beginning with one slash",
  credentialed_target: "protected access rejects credentials; supply only an exact same-origin path",
  absolute_or_out_of_origin_target: "protected access rejects absolute or out-of-origin targets; supply an exact same-origin path beginning with one slash",
  dot_or_traversal_segment: "protected access rejects dot and traversal segments",
  empty_or_trailing_segment: "protected access rejects empty or trailing segments",
  backslash_path: "protected access rejects backslashes; use slash-delimited static segments",
  query_or_fragment: "protected access rejects queries or fragments; supply only the exact path",
  percent_encoded_path: "protected access rejects percent-encoded paths because their canonical target is ambiguous",
  dynamic_segment: "protected access requires an explicitly supplied concrete path; dynamic placeholders must be excluded",
  opaque_segment_shape: "protected access rejects obvious opaque identifier shapes such as long numeric, hexadecimal, or UUID segments",
  invalid_static_segment: "protected access requires lowercase ASCII static segments of at most 64 characters, with single hyphens or underscores only between letters or digits",
});

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
  if (journey.schema_version !== PROTECTED_JOURNEY_SCHEMA
    || journey.purpose !== PROTECTED_JOURNEY_PURPOSE
    || !AUTHENTICATION_CLASSES.has(journey.access.authentication_class)
    || (Object.hasOwn(journey.access, "anonymous_status_codes")
      && !statusCodes(journey.access.anonymous_status_codes, 300, 499))
    || !statusCodes(journey.access.authenticated_status_codes, 200, 299)) {
    return { error: "invalid_protected_journey" };
  }
  const constraint = protectedJourneyConstraint(journey.method, journey.path);
  if (constraint) {
    return {
      error: "invalid_protected_journey",
      reason_code: constraint,
      guidance: PROTECTED_JOURNEY_GUIDANCE[constraint],
    };
  }
  return { value: journey };
}

function targetHasCredentials(value, base) {
  try {
    const target = new URL(value, base);
    return Boolean(target.username || target.password);
  } catch {
    return false;
  }
}

function protectedJourneyConstraint(method, journeyPath) {
  if (method !== "GET") return "non_get_method";
  if (journeyPath === "/") return "root_path";
  if (journeyPath.startsWith("//")) {
    return targetHasCredentials(journeyPath, "https://launchrally.invalid")
      ? "credentialed_target"
      : "protocol_relative_path";
  }
  if (ABSOLUTE_TARGET.test(journeyPath)) {
    return targetHasCredentials(journeyPath)
      ? "credentialed_target"
      : "absolute_or_out_of_origin_target";
  }
  if (!journeyPath.startsWith("/")) return "absolute_or_out_of_origin_target";
  if (journeyPath.includes("\\")) return "backslash_path";
  if (journeyPath.includes("?") || journeyPath.includes("#")) {
    return "query_or_fragment";
  }
  if (journeyPath.includes("%")) return "percent_encoded_path";
  const segments = journeyPath.slice(1).split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "dot_or_traversal_segment";
  }
  if (segments.some((segment) => segment === "")) return "empty_or_trailing_segment";
  if (DYNAMIC_PATH_MARKER.test(journeyPath)) return "dynamic_segment";
  if (segments.some((segment) => OPAQUE_PROTECTED_JOURNEY_SEGMENT.test(segment))) {
    return "opaque_segment_shape";
  }
  return safeProtectedJourneyPath(journeyPath) ? null : "invalid_static_segment";
}

function safeProtectedJourneyPath(value) {
  return SAFE_PROTECTED_JOURNEY_PATH.test(value);
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
