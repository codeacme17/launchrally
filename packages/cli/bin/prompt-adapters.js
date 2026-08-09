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
    display_prompt: "Which public Journeys should LaunchRally verify?",
    requirement: "Choose one or Skip",
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
        label: "Cloudflare — deployment",
        value: Object.freeze({ provider: "cloudflare", role: "deployment" }),
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
    .map((journey) => ({
      label: `${journeyLabel(journey)} (${detectedJourneys.some((candidate) => candidate.path === journey.path) ? "detected" : "recommended"})`,
      value: journey,
    }));
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

function list(values, render = String) {
  return values.length > 0 ? values.map((value) => `  - ${render(value)}`).join("\n") : "  - None";
}

function journeyLabel(journey) {
  return typeof journey === "string"
    ? journey
    : `${journey.method} ${journey.path} — ${journey.purpose}`;
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
    list(brief.core_journeys.values, journeyLabel),
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

function permissionText(permission) {
  if (permission.boundary === "public_network") {
    return [
      "Public verification",
      `Targets: ${permission.scope.targets.join(", ")}`,
      "Allow this public network read?",
    ].join("\n");
  }
  return [
    `Provider read: ${permission.scope.provider}`,
    `Target: ${permission.scope.target}`,
    `Fields: ${permission.scope.requested_fields.join(", ")}`,
    `Command: ${permission.scope.command
      ? [permission.scope.command.executable, ...permission.scope.command.arguments].join(" ")
      : "none"}`,
    "Allow this Provider read?",
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
  return [
    ...fieldOptions(field),
    ...(field.allow_custom
      ? [{ label: "Other — enter a custom value", value: customValue }]
      : []),
    ...(field.allow_skip ? [{ label: field.skip_label, value: skipValue }] : []),
  ];
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

export function createPlainPromptAdapter({ input, output, signals = process }) {
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
    async start() {
      write(output, "LaunchRally Audit");
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
          permissionDecisions[permission.permission_id] = await confirm(permissionText(permission))
            ? "approved"
            : "denied";
        }
        return { permission_decisions: permissionDecisions };
      }
      return {};
    },
    async close() {
      signals.off("SIGINT", handleInterrupt);
      readline.close();
    },
  };
}

function cancelled(value, clack, output) {
  if (!clack.isCancel(value)) return value;
  clack.cancel("Audit cancelled.", { output });
  throw new PromptCancelledError();
}

export async function createClackPromptAdapter({ input, output }) {
  const clack = await loadClack();
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
    async start() {
      clack.intro("LaunchRally Audit", common);
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
          clack.note(permissionText(permission), "Permission request", common);
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
    async close() {},
  };
}
