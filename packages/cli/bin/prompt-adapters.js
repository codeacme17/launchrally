import { register } from "node:module";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { styleText } from "node:util";

import {
  environmentTargetLabel,
  parsePublicJourneyInput,
  parsePublicTargetInput,
  reviewedEnvironmentLabel,
  SUPPORT_LAYER_CATEGORIES,
} from "@launchrally/core";

import { PromptCancelledError } from "./human-audit.js";
import { renderHumanInit, renderHumanInitFullPreview } from "./human-init.js";

function styleTextSupportsArrays() {
  try {
    styleText(["strikethrough", "dim"], "");
    return true;
  } catch (error) {
    if (error?.code !== "ERR_INVALID_ARG_VALUE") throw error;
    return false;
  }
}

let clackPromise;

function loadClack() {
  if (clackPromise) return clackPromise;
  // Clack 1.7 composes styles with an array, added to Node in 20.13. Route only
  // Clack's node:util import through a shim on the supported Node 20.12 floor.
  if (!styleTextSupportsArrays()) {
    register(new URL("./clack-node20-loader.js", import.meta.url));
  }
  clackPromise = import("@clack/prompts");
  return clackPromise;
}

const FIELD_PRESENTATION = Object.freeze({
  intended_environment: Object.freeze({
    required: true,
    example: "production",
    options: Object.freeze([
      Object.freeze({ label: "Production", value: "production" }),
      Object.freeze({ label: "Staging", value: "staging" }),
      Object.freeze({ label: "Preview", value: "preview" }),
    ]),
    allow_custom: true,
  }),
  production_targets: Object.freeze({
    required: true,
    example: "https://app.example.com, https://www.example.com",
  }),
  core_journeys: Object.freeze({
    required: true,
    display_prompt: "Classify detected routes before LaunchRally verifies them",
    requirement: "Route discovery does not establish access. Public authorizes an anonymous GET and asserts a 200-299 response; protected access keeps anonymous and authenticated verification separate.",
    example: "GET /, GET /checkout — checkout completes",
    allow_custom: true,
    allow_skip: true,
    skip_label: "Skip public Journey verification — creates a Verification Gap",
  }),
  provider_roles: Object.freeze({
    required: false,
    example: "vercel:deployment, sentry:observability",
    options: Object.freeze([
      Object.freeze({
        label: "Clerk — authentication",
        value: Object.freeze({ provider: "clerk", role: "authentication" }),
      }),
      Object.freeze({
        label: "Cloudflare — deployment",
        value: Object.freeze({ provider: "cloudflare", role: "deployment" }),
      }),
      Object.freeze({
        label: "Neon — data",
        value: Object.freeze({ provider: "neon", role: "data" }),
      }),
      Object.freeze({
        label: "Netlify — deployment",
        value: Object.freeze({ provider: "netlify", role: "deployment" }),
      }),
      Object.freeze({
        label: "PostHog — analytics",
        value: Object.freeze({ provider: "posthog", role: "analytics" }),
      }),
      Object.freeze({
        label: "Resend — email",
        value: Object.freeze({ provider: "resend", role: "email" }),
      }),
      Object.freeze({
        label: "Sentry — observability",
        value: Object.freeze({ provider: "sentry", role: "observability" }),
      }),
      Object.freeze({
        label: "Stripe — payments",
        value: Object.freeze({ provider: "stripe", role: "payments" }),
      }),
      Object.freeze({
        label: "Supabase — data",
        value: Object.freeze({ provider: "supabase", role: "data" }),
      }),
      Object.freeze({
        label: "Vercel — deployment",
        value: Object.freeze({ provider: "vercel", role: "deployment" }),
      }),
    ]),
    allow_custom: true,
  }),
  support_layers: Object.freeze({
    required: false,
    example: "observability, analytics",
    options: Object.freeze(SUPPORT_LAYER_CATEGORIES.map((value) => Object.freeze({
      label: `${value[0].toUpperCase()}${value.slice(1)}`,
      value,
    }))),
    allow_custom: true,
  }),
});

function journeyOptions(candidates = []) {
  const detectedJourneys = candidates
    .map((candidate) => parsePublicJourneyInput(candidate, { allowDescription: false }).value)
    .filter((candidate) => typeof candidate === "object");
  const byPath = new Map(detectedJourneys.map((candidate) => [candidate.path, candidate]));
  if (!byPath.has("/")) {
    byPath.set("/", { method: "GET", path: "/", purpose: "homepage loads" });
  }
  return [...byPath.values()]
    .sort((left, right) =>
      left.path === "/" ? -1 : right.path === "/" ? 1 : left.path.localeCompare(right.path),
    )
    .map((journey) => {
      const detected = detectedJourneys.some((candidate) => candidate.path === journey.path);
      return {
        label: `${journeyLabel(journey)} (${detected ? "detected" : "recommended"})`,
        value: journey,
        detected,
      };
    });
}

function presentedField(field) {
  const presented = { ...FIELD_PRESENTATION[field.field_id], ...field };
  if (field.field_id === "core_journeys" && !field.options) {
    presented.options = journeyOptions(field.candidates);
  }
  return presented;
}

function write(output, value) {
  output.write(`${value}\n`);
}

function completedActivityLabel(label) {
  return `${String(label).replace(/(?:…|\.\.\.)$/u, "").trim()}.`;
}

const INIT_CONFIRMATION_OPTIONS = Object.freeze([
  Object.freeze({ label: "Confirm", value: "confirm" }),
  Object.freeze({ label: "Decline", value: "decline" }),
  Object.freeze({ label: "View full preview", value: "view_full_preview" }),
]);

async function collectInitConfirmation({ chooseDecision, showFullPreview }) {
  while (true) {
    const confirmation = await chooseDecision(INIT_CONFIRMATION_OPTIONS);
    if (confirmation !== "view_full_preview") return { confirmation };
    showFullPreview();
  }
}

async function runPromptActivity({
  label,
  operation,
  signal,
  delayMs,
  start,
  complete,
  fail,
  cancel,
}) {
  let active = false;
  const activate = () => {
    active = true;
    start(label);
  };
  const timer = delayMs <= 0 ? (activate(), undefined) : setTimeout(activate, delayMs);
  let handleAbort;
  const abort = signal && new Promise((resolve, reject) => {
    handleAbort = () => reject(new PromptCancelledError());
    if (signal.aborted) handleAbort();
    else signal.addEventListener("abort", handleAbort, { once: true });
  });

  const operationPromise = Promise.resolve().then(() => operation(signal));
  try {
    const value = await (abort ? Promise.race([operationPromise, abort]) : operationPromise);
    if (active) complete(completedActivityLabel(label));
    return value;
  } catch (error) {
    if (error instanceof PromptCancelledError || signal?.aborted) {
      cancel(completedActivityLabel(label), active);
      try {
        await operationPromise;
      } catch {
        // The cancellation state is authoritative after all work has settled.
      }
      throw new PromptCancelledError();
    } else {
      fail(completedActivityLabel(label), active);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (handleAbort) signal.removeEventListener("abort", handleAbort);
  }
}

function list(values, render = String) {
  return values.length > 0 ? values.map((value) => `  - ${render(value)}`).join("\n") : "  - None";
}

function journeyLabel(journey) {
  return typeof journey === "string"
    ? journey
    : `${journey.method} ${journey.path} — ${journey.purpose}`;
}

function journeyAccessLabel(journey) {
  if (typeof journey === "string") {
    return `${journey} [access: descriptive; anonymous: not executable; authenticated: not applicable]`;
  }
  if (!journey.access) {
    return `${journeyLabel(journey)} [access: public; anonymous: 200-299; authenticated: not applicable]`;
  }
  const anonymous = journey.access.anonymous_status_codes?.join("/") ?? "not probed";
  const authenticated = journey.access.authenticated_status_codes.join("/");
  return `${journeyLabel(journey)} [access: ${journey.access.authentication_class}; anonymous: ${anonymous}; authenticated: ${authenticated}]`;
}

function providerLabel(role) {
  return `${role.provider}:${role.role}`;
}

function auditBriefText(result) {
  const brief = result.audit_brief;
  const lines = [
    "Audit Brief",
    `Environment: ${reviewedEnvironmentLabel(
      brief.intended_environment.value,
    ) || "not yet confirmed"}`,
    `${environmentTargetLabel(brief.intended_environment.value, { capitalize: true, plural: true })}:`,
    list(brief.production_targets.values),
    "Core journeys:",
    list(brief.core_journeys.values, journeyAccessLabel),
    "Provider roles:",
    list(brief.provider_roles.values, providerLabel),
    "Support layers:",
    list(brief.support_layers.values),
  ];
  if (brief.planned_checks) {
    lines.push(
      "Planned Checks:",
      list(brief.planned_checks, (check) => `${check.check_id} [${check.permission_id}]`),
    );
  }
  return lines.join("\n");
}

function inputStateText(result) {
  const brief = result.audit_brief;
  const candidates = [
    ...brief.provider_roles.candidates.map((role) => `Provider role: ${providerLabel(role)}`),
    ...brief.support_layers.candidates.map((layer) => `Support layer: ${layer}`),
  ];
  const errors = result.request.validation_errors.map(
    (error) => `  - ${error.field_id}: ${error.code}${
      error.guidance ? ` — ${error.guidance}` : ""
    }`,
  );
  return [
    "Needs input",
    `Project: ${brief.project.name} (${brief.project.type})`,
    ...(candidates.length > 0 ? ["Inferred candidates (not confirmed):", ...candidates.map((item) => `  - ${item}`)] : []),
    ...(errors.length > 0 ? ["Input errors:", ...errors] : []),
  ].join("\n");
}

function protectedJourneyDeclaration(permissionJourney, auditBrief) {
  const declarations = auditBrief?.core_journeys?.values ?? [];
  let pathname;
  try {
    pathname = new URL(permissionJourney.target).pathname;
  } catch {
    return undefined;
  }
  return declarations.find((journey) =>
    journey
    && typeof journey === "object"
    && journey.method === permissionJourney.method
    && journey.path === pathname
    && journey.access?.authentication_class === permissionJourney.authentication_class);
}

function authenticatedPermissionText(permission, auditBrief) {
  const scope = permission.scope ?? {};
  const journeys = Array.isArray(scope.journeys) ? scope.journeys : [];
  const journeyLines = journeys.length > 0
    ? journeys.flatMap((journey) => {
      const declaration = protectedJourneyDeclaration(journey, auditBrief);
      const anonymousStatuses = declaration?.access?.anonymous_status_codes;
      const authenticatedStatuses = journey.expected_status_codes;
      return [
        `  - ${journey.method ?? "Method unavailable"} ${journey.target ?? "Target unavailable"}`,
        `    Authentication class: ${journey.authentication_class ?? "unavailable"}`,
        `    Anonymous expected status: ${Array.isArray(anonymousStatuses) && anonymousStatuses.length > 0
          ? anonymousStatuses.join(", ")
          : "not declared"}`,
        `    Authenticated expected status: ${Array.isArray(authenticatedStatuses) && authenticatedStatuses.length > 0
          ? authenticatedStatuses.join(", ")
          : "unavailable"}`,
      ];
    })
    : ["  - No authenticated Journey targets were supplied."];
  return [
    "Authenticated Core Journey verification",
    "Safe read-only targets:",
    ...journeyLines,
    `Runner/adapter version: ${scope.adapter_version ?? "unavailable"}`,
    `Retained normalized fields: ${Array.isArray(scope.requested_fields) && scope.requested_fields.length > 0
      ? scope.requested_fields.join(", ")
      : "unavailable"}`,
    "Authentication remains user-managed; credentials, session material, response bodies, and account identifiers are not retained.",
    "Allow these authenticated Core Journey reads?",
  ].join("\n");
}

function permissionText(permission, auditBrief) {
  if (permission.boundary === "public_network") {
    return [
      "Public verification",
      `Targets: ${permission.scope.targets.join(", ")}`,
      "Allow this public network read?",
    ].join("\n");
  }
  if (permission.boundary === "authenticated_network_read") {
    return authenticatedPermissionText(permission, auditBrief);
  }
  const provider = permission.scope?.provider ?? "unavailable";
  const target = permission.scope?.target ?? "unavailable";
  const requestedFields = Array.isArray(permission.scope?.requested_fields)
    ? permission.scope.requested_fields
    : [];
  return [
    `Provider read: ${provider}`,
    `Target: ${target}`,
    `Fields: ${requestedFields.length > 0 ? requestedFields.join(", ") : "unavailable"}`,
    "Commands:",
    list(
      permission.scope?.commands
        ?? (permission.scope?.command ? [permission.scope.command] : []),
      (command) => [command.executable, ...command.arguments].join(" "),
    ),
    "Allow this Provider read?",
  ].join("\n");
}

function initPermissionText(permission) {
  const command = permission.commands[0];
  return [
    "LaunchRally Init requires an npm registry read after the offline cache attempt failed.",
    `Source: ${permission.source}`,
    `Package: ${permission.package}@${permission.version}`,
    `Temporary target: ${permission.temporary_target}`,
    `Command: ${[command.executable, ...command.arguments].join(" ")}`,
    "Lifecycle scripts remain disabled.",
  ].join("\n");
}

function currentFieldValue(field) {
  if (field.value_type === "string") return field.current_value ?? "";
  if (!Array.isArray(field.current_value) || field.current_value.length === 0) return "";
  if (field.value_type === "provider_role_array") {
    return field.current_value.map(providerLabel).join(", ");
  }
  if (field.value_type === "journey_array") {
    return field.current_value.map(journeyLabel).join(", ");
  }
  return field.current_value.join(", ");
}

function parseFieldValue(field, value) {
  const trimmed = value.trim();
  if (!trimmed && field.current_value !== null && field.current_value !== undefined) {
    return field.current_value;
  }
  if (field.value_type === "string") return trimmed;
  const entries = trimmed
    ? trimmed.split(",").map((entry) => entry.trim()).filter(Boolean)
    : [];
  if (field.value_type === "provider_role_array") {
    return entries.map((entry) => {
      const separator = entry.indexOf(":");
      return separator === -1
        ? { provider: entry, role: "" }
        : { provider: entry.slice(0, separator).trim(), role: entry.slice(separator + 1).trim() };
    });
  }
  if (field.value_type === "journey_array") {
    return entries.map((entry) => {
      const parsed = parsePublicJourneyInput(entry, { allowDescription: false });
      return parsed.value ?? entry;
    });
  }
  return entries;
}

function fieldInputError(field, value) {
  const input = String(value ?? "").trim();
  if (field.required && !input) return "This field is required.";
  if (!input) return undefined;
  const entries = input.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (field.value_type === "url_array") {
    const error = entries.map((entry) => parsePublicTargetInput(entry).error).find(Boolean);
    if (error === "unsafe_public_target") {
      return "Use a public URL without credentials, query parameters, or fragments.";
    }
    if (error) {
      return "Enter a valid public http or https URL, for example: https://app.example.com.";
    }
  }
  if (field.value_type !== "journey_array") return undefined;
  const safe = entries.every((entry) =>
    !parsePublicJourneyInput(entry, { allowDescription: false }).error,
  );
  return safe
    ? undefined
    : "Use a safe GET Journey, for example: GET / or GET /checkout — checkout completes.";
}

function emptyFieldValue(value) {
  return value === "" || value === null || value === undefined
    || (Array.isArray(value) && value.length === 0);
}

function fieldLabel(field) {
  const current = currentFieldValue(field);
  const requirement = field.requirement
    ?? (field.required ? "Required" : "Optional — press Enter to skip");
  return `${field.display_prompt ?? field.prompt} (${requirement})${current ? ` [${current}]` : ""}`;
}

function fieldMessage(field) {
  return [
    fieldLabel(field),
    ...(field.example ? [`Example: ${field.example}`] : []),
  ].join("\n");
}

function sameOptionValue(left, right) {
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return left === right;
  }
  if ("provider" in left || "provider" in right) {
    return left.provider === right.provider && left.role === right.role;
  }
  if ("path" in left || "path" in right) {
    return left.method === right.method
      && left.path === right.path
      && left.purpose === right.purpose;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function fieldOptions(field) {
  return field.options.map((option) => ({
    ...option,
    label: field.candidates?.some((candidate) => sameOptionValue(candidate, option.value))
      ? `${option.label} (detected)`
      : option.label,
  }));
}

function selectionOptions(field, { customValue, skipValue }) {
  const options = fieldOptions(field);
  return [
    ...options,
    ...(field.allow_custom
      ? [{ label: "Other — enter a custom value", value: customValue }]
      : []),
    ...(field.allow_skip ? [{ label: field.skip_label, value: skipValue }] : []),
  ];
}

const PUBLIC_JOURNEY_ACCESS_CHOICE = Object.freeze({
  label: "Public — authorize anonymous GET; expect 200-299",
  value: "public",
});
const PROTECTED_JOURNEY_ACCESS_CHOICES = Object.freeze([
  Object.freeze({
    label: "User — anonymous expect 401/403/404; authenticated expect 200",
    value: "user",
  }),
  Object.freeze({
    label: "Staff — anonymous expect 401/403/404; authenticated expect 200",
    value: "staff",
  }),
  Object.freeze({
    label: "Signed token — anonymous expect 401/403/404; authenticated expect 200",
    value: "signed_token",
  }),
]);
const EXCLUDE_JOURNEY_ACCESS_CHOICE = Object.freeze({
  label: "Exclude — do not verify this route",
  value: "exclude",
});

function classifiedJourney(journey, accessClass) {
  if (accessClass === "exclude") return null;
  if (accessClass === "public") return journey;
  return {
    schema_version: "launchrally.dev/protected-journey/v1",
    method: journey.method,
    path: journey.path,
    purpose: "authenticated Core Journey",
    access: {
      authentication_class: accessClass,
      anonymous_status_codes: [401, 403, 404],
      authenticated_status_codes: [200],
    },
  };
}

function journeyAccessChoices(journey) {
  const protectedSupported = !parsePublicJourneyInput(
    classifiedJourney(journey, "user"),
    { allowDescription: false },
  ).error;
  return [
    PUBLIC_JOURNEY_ACCESS_CHOICE,
    ...(protectedSupported ? PROTECTED_JOURNEY_ACCESS_CHOICES : []),
    EXCLUDE_JOURNEY_ACCESS_CHOICE,
  ];
}

async function classifyDetectedJourneys(field, selectAccess) {
  const detected = fieldOptions(field).filter((option) => option.detected);
  if (detected.length === 0) return null;
  const classified = [];
  for (const option of detected) {
    const choices = journeyAccessChoices(option.value);
    const protectedSupported = choices.length > 2;
    const accessClass = await selectAccess(
      `Route discovery does not establish access. Classify ${journeyLabel(option.value)} (classification required${protectedSupported ? "" : "; protected access is unsupported for this path"})`,
      choices,
    );
    const journey = classifiedJourney(option.value, accessClass);
    if (journey) classified.push(journey);
  }
  return { classified, detected: detected.map((option) => option.value) };
}

function retainedCurrentJourneys(field, detected) {
  return (field.current_value ?? []).filter((current) =>
    !detected.some((candidate) =>
      typeof current === "object"
      && current !== null
      && current.method === candidate.method
      && current.path === candidate.path,
    ),
  );
}

function protectedJourneys(journeys) {
  return journeys.filter((journey) =>
    typeof journey === "object"
    && journey !== null
    && typeof journey.access?.authentication_class === "string",
  );
}

function resolveMultiSelection(selected, { customValue, skipValue }) {
  const skip = selected.includes(skipValue);
  const custom = selected.includes(customValue);
  const values = selected.filter((value) => value !== skipValue && value !== customValue);
  if (skip && (custom || values.length > 0)) {
    return { error: "Skip cannot be combined with another Journey." };
  }
  return { skip, custom, values };
}

function completedMultiSelection(resolution) {
  if (resolution.skip) return { done: true, value: [] };
  if (!resolution.custom) return { done: true, value: resolution.values };
  return { done: false };
}

function reportDestinationOptions(request) {
  return [
    { label: `Use suggested path — ${request.suggested_path}`, value: "suggested" },
    ...(request.file_picker_available
      ? [{ label: "Open the system file picker", value: "file_picker" }]
      : []),
    { label: "Enter a custom path", value: "custom" },
    { label: "Do not save", value: "cancel" },
  ];
}

function reportCollisionOptions() {
  return [
    { label: "Overwrite the existing file", value: "overwrite" },
    { label: "Choose another path", value: "choose_another" },
    { label: "Do not save", value: "cancel" },
  ];
}

async function collectAnswers(
  result,
  ask,
  showError = () => {},
  selectField,
  inputMessage = fieldMessage,
) {
  const answers = {};
  for (const requestedField of result.request.fields) {
    const field = presentedField(requestedField);
    if (field.options?.length > 0 && selectField) {
      answers[field.field_id] = await selectField(field);
      continue;
    }
    while (true) {
      const raw = await ask(inputMessage(field), field);
      const error = fieldInputError(field, raw);
      const value = parseFieldValue(field, raw);
      if (!error && (!field.required || !emptyFieldValue(value))) {
        answers[field.field_id] = value;
        break;
      }
      showError(error ?? "This field is required.");
    }
  }
  return answers;
}

export function createPlainPromptAdapter({
  input,
  output,
  signals = process,
  activityDelayMs = 120,
}) {
  const controller = new AbortController();
  const readline = createInterface({ input, output, terminal: false });
  const handleInterrupt = () => controller.abort();
  signals.on("SIGINT", handleInterrupt);

  const ask = async (message) => {
    try {
      return await readline.question(`${message} `, { signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") throw new PromptCancelledError();
      throw error;
    }
  };
  const choose = async (message, choices) => {
    write(output, message);
    choices.forEach((choice, index) => write(output, `${index + 1}. ${choice.label}`));
    while (true) {
      const value = (await ask(`Choose 1-${choices.length}:`)).trim();
      const selected = choices[Number(value) - 1];
      if (selected) return selected.value;
      write(output, `Enter a number from 1 to ${choices.length}.`);
    }
  };
  const confirm = async (message) => {
    while (true) {
      const value = (await ask(`${message} [y/N]`)).trim().toLowerCase();
      if (value === "" || value === "n" || value === "no") return false;
      if (value === "y" || value === "yes") return true;
      write(output, "Enter y or n. The default is no.");
    }
  };
  const selectField = async (field) => {
    const customValue = Symbol("custom-value");
    const skipValue = Symbol("skip-value");
    const choices = selectionOptions(field, {
      customValue,
      skipValue,
    });
    if (field.field_id === "core_journeys") {
      const classification = await classifyDetectedJourneys(field, choose);
      if (classification) {
        const retained = retainedCurrentJourneys(field, classification.detected);
        const action = await choose("Continue, add another Journey, or explicitly skip public Journey verification", [
          { label: "Continue with classified Journeys", value: "continue" },
          { label: "Other — enter a custom value", value: "custom" },
          { label: field.skip_label, value: "skip" },
        ]);
        if (action === "skip") {
          return protectedJourneys([...classification.classified, ...retained]);
        }
        if (action === "continue") return [...classification.classified, ...retained];
        while (true) {
          const raw = await ask(`Enter other values separated by commas\nExample: ${field.example}`);
          const error = fieldInputError({ ...field, required: true }, raw);
          const custom = parseFieldValue(field, raw);
          if (!error && !emptyFieldValue(custom)) {
            return [...classification.classified, ...retained, ...custom];
          }
          write(output, error ?? "Enter at least one custom value.");
        }
      }
    }
    if (!field.value_type.endsWith("_array")) {
      const value = await choose(fieldMessage(field), choices);
      if (value !== customValue) return value;
      while (true) {
        const raw = await ask(`Enter another value (Required)\nExample: ${field.example}`);
        const error = fieldInputError({ ...field, required: true }, raw);
        const custom = parseFieldValue(field, raw);
        if (!error && !emptyFieldValue(custom)) return custom;
        write(output, error ?? "This field is required.");
      }
    }

    write(output, fieldMessage(field));
    choices.forEach((choice, index) => write(output, `${index + 1}. ${choice.label}`));
    while (true) {
      const raw = (await ask(
        field.required
          ? "Select one or more numbers separated by commas:"
          : "Select numbers separated by commas, or press Enter for none:",
      )).trim();
      if (!raw && !field.required) return [];
      const indexes = [...new Set(raw.split(",").map((value) => Number(value.trim()) - 1))];
      if (indexes.length === 0 || indexes.some((index) => !choices[index])) {
        write(output, `Enter numbers from 1 to ${choices.length}, separated by commas.`);
        continue;
      }
      const selected = indexes.map((index) => choices[index].value);
      const resolution = resolveMultiSelection(selected, {
        customValue,
        skipValue,
      });
      if (resolution.error) {
        write(output, resolution.error);
        continue;
      }
      const completed = completedMultiSelection(resolution);
      if (completed.done) return completed.value;
      while (true) {
        const raw = await ask(`Enter other values separated by commas\nExample: ${field.example}`);
        const error = fieldInputError({ ...field, required: true }, raw);
        const custom = parseFieldValue(field, raw);
        if (!error && !emptyFieldValue(custom)) {
          return [...resolution.values, ...custom];
        }
        write(output, error ?? "Enter at least one custom value.");
      }
    }
  };

  return {
    async start(operation = "audit") {
      write(output, operation === "init" ? "LaunchRally Init" : "LaunchRally Audit");
    },
    async activity(label, operation) {
      return runPromptActivity({
        label,
        operation,
        signal: controller.signal,
        delayMs: activityDelayMs,
        start: (message) => write(output, `Working: ${message}`),
        complete: (message) => write(output, `Completed: ${message}`),
        fail: (message) => write(output, `Failed: ${message}`),
        cancel: (message) => write(output, `Cancelled: ${message}`),
      });
    },
    async reportSave(request) {
      if (request.phase === "choose") {
        if (request.notice) write(output, request.notice);
        if (!request.save_confirmed
          && !await confirm("Save the complete Audit JSON to a file?")) return {};
        const selected = await choose(
          "Choose where to save the complete Report:",
          reportDestinationOptions(request),
        );
        if (selected === "suggested") {
          return { output_path: request.suggested_path, suggested: true };
        }
        if (selected === "file_picker") return { file_picker: true };
        if (selected === "custom") {
          while (true) {
            const outputPath = (await ask("Save path:")).trim();
            if (outputPath) return { output_path: outputPath };
            write(output, "Enter a non-empty Report path.");
          }
        }
        return {};
      }
      if (request.phase === "confirm") {
        write(output, `Exact Report destination: ${request.resolved_path}`);
        if (request.collision) {
          write(output, "A file already exists at this destination.");
          return {
            decision: await choose("Choose how to continue:", reportCollisionOptions()),
          };
        }
        return await confirm("Write the complete Report to this path?")
          ? { decision: "save" }
          : { decision: "cancel" };
      }
      return {};
    },
    async respond(result) {
      if (result.status === "needs_input") {
        write(output, inputStateText(result));
        return {
          answers: await collectAnswers(
            result,
            ask,
            (message) => write(output, message),
            selectField,
          ),
        };
      }
      if (result.status === "needs_confirmation") {
        write(output, auditBriefText(result));
        return {
          confirmation: await choose(result.request.prompt, [
            { label: "Confirm", value: "confirm" },
            { label: "Revise", value: "revise" },
            { label: "Cancel", value: "cancel" },
          ]),
        };
      }
      if (result.status === "needs_permission") {
        const permissionDecisions = {};
        for (const permission of result.request.permissions) {
          permissionDecisions[permission.permission_id] = await confirm(
            permissionText(permission, result.audit_brief),
          )
            ? "approved"
            : "denied";
        }
        return { permission_decisions: permissionDecisions };
      }
      return {};
    },
    async respondInit(result, context = {}) {
      if (result.status === "needs_permission") {
        const permissionDecisions = {};
        for (const permission of result.request.permissions) {
          write(output, initPermissionText(permission));
          permissionDecisions[permission.id] = await confirm(
            `Approve ${permission.id}?`,
          ) ? "approved" : "denied";
        }
        return { permission_decisions: permissionDecisions };
      }
      if (result.status === "needs_confirmation") {
        write(output, renderHumanInit(result, context));
        return collectInitConfirmation({
          chooseDecision: (options) => choose(result.request.prompt, options),
          showFullPreview: () => write(output, renderHumanInitFullPreview(result, context)),
        });
      }
      return {};
    },
    async close() {
      signals.off("SIGINT", handleInterrupt);
      readline.close();
    },
  };
}

function cancelled(value, clack, output, operation = "Audit") {
  if (!clack.isCancel(value)) return value;
  clack.cancel(`${operation} cancelled.`, { output });
  throw new PromptCancelledError();
}

export async function createClackPromptAdapter({
  input,
  output,
  signals = process,
  activityDelayMs = 120,
}) {
  const clack = await loadClack();
  const controller = new AbortController();
  const handleInterrupt = () => controller.abort();
  signals.on("SIGINT", handleInterrupt);
  const common = { input, output, withGuide: false };
  const ask = async (message, field = {}) => cancelled(await clack.text({
    ...common,
    message,
    ...(currentFieldValue(field) ? { initialValue: currentFieldValue(field) } : {}),
    ...(field.example ? { placeholder: `Example: ${field.example}` } : {}),
    ...((field.required || field.value_type === "journey_array")
      ? { validate: (value) => fieldInputError(field, value) }
      : {}),
  }), clack, output);
  const selectField = async (field) => {
    const customValue = "__launchrally_custom_value__";
    const skipValue = "__launchrally_skip_value__";
    const options = selectionOptions(field, {
      customValue,
      skipValue,
    });
    if (field.field_id === "core_journeys") {
      const classification = await classifyDetectedJourneys(
        field,
        async (message, choices) => cancelled(await clack.select({
          ...common,
          message,
          options: choices,
        }), clack, output),
      );
      if (classification) {
        const retained = retainedCurrentJourneys(field, classification.detected);
        const action = cancelled(await clack.select({
          ...common,
          message: "Continue, add another Journey, or explicitly skip public Journey verification",
          options: [
            { label: "Continue with classified Journeys", value: "continue" },
            { label: "Other — enter a custom value", value: "custom" },
            { label: field.skip_label, value: "skip" },
          ],
        }), clack, output);
        if (action === "skip") {
          return protectedJourneys([...classification.classified, ...retained]);
        }
        if (action === "continue") return [...classification.classified, ...retained];
        const raw = await ask("Enter other values separated by commas", {
          ...field,
          current_value: [],
          required: true,
        });
        const custom = parseFieldValue(field, raw);
        return [...classification.classified, ...retained, ...custom];
      }
    }
    if (!field.value_type.endsWith("_array")) {
      const selected = cancelled(await clack.select({
        ...common,
        message: fieldMessage(field),
        options,
        initialValue: field.current_value
          ?? field.options[0]?.value
          ?? customValue,
      }), clack, output);
      if (selected !== customValue) return selected;
      const raw = await ask("Enter another value (Required)", {
        ...field,
        current_value: null,
        required: true,
      });
      return parseFieldValue(field, raw);
    }

    let initialValues = (field.current_value ?? []).map((current) =>
      field.options.find((option) => sameOptionValue(option.value, current))?.value ?? current,
    );
    while (true) {
      const selected = cancelled(await clack.multiselect({
        ...common,
        message: fieldMessage(field),
        options,
        initialValues,
        required: field.required,
      }), clack, output);
      const resolution = resolveMultiSelection(selected, {
        customValue,
        skipValue,
      });
      if (resolution.error) {
        clack.note(resolution.error, "Invalid selection", common);
        initialValues = [];
        continue;
      }
      const completed = completedMultiSelection(resolution);
      if (completed.done) return completed.value;
      const raw = await ask("Enter other values separated by commas", {
        ...field,
        current_value: [],
        required: true,
      });
      const custom = parseFieldValue(field, raw);
      return [...resolution.values, ...custom];
    }
  };

  return {
    async start(operation = "audit") {
      clack.intro(operation === "init" ? "LaunchRally Init" : "LaunchRally Audit", common);
    },
    async activity(label, operation) {
      const completionLabel = completedActivityLabel(label);
      const spinner = clack.spinner({
        ...common,
        signal: controller.signal,
        cancelMessage: `Cancelled: ${completionLabel}`,
        errorMessage: `Failed: ${completionLabel}`,
      });
      return runPromptActivity({
        label,
        operation,
        signal: controller.signal,
        delayMs: activityDelayMs,
        start: (message) => spinner.start(message),
        complete: (message) => spinner.stop(`Completed: ${message}`),
        fail: (message, active) => active
          ? spinner.error(`Failed: ${message}`)
          : clack.log.error(`Failed: ${message}`, common),
        cancel: (message, active) => active
          ? spinner.cancel(`Cancelled: ${message}`)
          : clack.cancel(`Cancelled: ${message}`, common),
      });
    },
    async reportSave(request) {
      if (request.phase === "choose") {
        if (request.notice) clack.note(request.notice, "System file picker", common);
        if (!request.save_confirmed) {
          const save = await clack.confirm({
            ...common,
            message: "Save the complete Audit JSON to a file?",
            initialValue: false,
          });
          if (!cancelled(save, clack, output)) return {};
        }
        const selected = cancelled(await clack.select({
          ...common,
          message: "Choose where to save the complete Report:",
          options: reportDestinationOptions(request),
          initialValue: "suggested",
        }), clack, output);
        if (selected === "suggested") {
          return { output_path: request.suggested_path, suggested: true };
        }
        if (selected === "file_picker") return { file_picker: true };
        if (selected === "custom") {
          const outputPath = await ask("Save path:", { required: true });
          return { output_path: outputPath.trim() };
        }
        return {};
      }
      if (request.phase === "confirm") {
        clack.note(
          `Exact Report destination: ${request.resolved_path}`,
          "Report save",
          common,
        );
        if (request.collision) {
          clack.note(
            "A file already exists at this destination.",
            "Existing file",
            common,
          );
          const decision = await clack.select({
            ...common,
            message: "Choose how to continue:",
            options: reportCollisionOptions(),
            initialValue: "choose_another",
          });
          return { decision: cancelled(decision, clack, output) };
        }
        const save = await clack.confirm({
          ...common,
          message: "Write the complete Report to this path?",
          initialValue: false,
        });
        return cancelled(save, clack, output)
          ? { decision: "save" }
          : { decision: "cancel" };
      }
      return {};
    },
    async respond(result) {
      if (result.status === "needs_input") {
        clack.note(inputStateText(result), "Audit Brief", common);
        return {
          answers: await collectAnswers(result, ask, undefined, selectField, fieldLabel),
        };
      }
      if (result.status === "needs_confirmation") {
        clack.note(auditBriefText(result), "Complete plan preview", common);
        const confirmation = await clack.select({
          ...common,
          message: result.request.prompt,
          options: [
            { label: "Confirm", value: "confirm" },
            { label: "Revise", value: "revise" },
            { label: "Cancel", value: "cancel" },
          ],
          initialValue: "confirm",
        });
        return { confirmation: cancelled(confirmation, clack, output) };
      }
      if (result.status === "needs_permission") {
        const permissionDecisions = {};
        for (const permission of result.request.permissions) {
          clack.note(
            permissionText(permission, result.audit_brief),
            "Permission request",
            common,
          );
          const approved = await clack.confirm({
            ...common,
            message: "Approve this permission?",
            initialValue: false,
          });
          permissionDecisions[permission.permission_id] = cancelled(approved, clack, output)
            ? "approved"
            : "denied";
        }
        return { permission_decisions: permissionDecisions };
      }
      return {};
    },
    async respondInit(result, context = {}) {
      if (result.status === "needs_permission") {
        const permissionDecisions = {};
        for (const permission of result.request.permissions) {
          clack.note(initPermissionText(permission), "Permission request", common);
          const approved = await clack.confirm({
            ...common,
            message: `Approve ${permission.id}?`,
            initialValue: false,
          });
          permissionDecisions[permission.id] = cancelled(approved, clack, output, "Init")
            ? "approved"
            : "denied";
        }
        return { permission_decisions: permissionDecisions };
      }
      if (result.status === "needs_confirmation") {
        clack.note(renderHumanInit(result, context), "Initialization decision summary", common);
        return collectInitConfirmation({
          chooseDecision: async (options) => cancelled(await clack.select({
            ...common,
            message: result.request.prompt,
            options,
            initialValue: "decline",
          }), clack, output, "Init"),
          showFullPreview: () => clack.note(
            renderHumanInitFullPreview(result, context),
            "Full exact initialization preview",
            common,
          ),
        });
      }
      return {};
    },
    async close() {
      signals.off("SIGINT", handleInterrupt);
    },
  };
}
