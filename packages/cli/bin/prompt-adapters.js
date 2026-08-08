import { createInterface } from "node:readline/promises";
import process from "node:process";

import { PromptCancelledError } from "./human-audit.js";

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
    example: "GET / — homepage loads, GET /checkout — checkout completes",
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
    example: "monitoring, analytics",
    options: Object.freeze([
      Object.freeze({ label: "Analytics", value: "analytics" }),
      Object.freeze({ label: "Monitoring", value: "monitoring" }),
    ]),
    allow_custom: true,
  }),
});

function presentedField(field) {
  return { ...FIELD_PRESENTATION[field.field_id], ...field };
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
    `Environment: ${brief.intended_environment.value ?? "not yet confirmed"}`,
    "Production targets:",
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
    (error) => `  - ${error.field_id}: ${error.code}`,
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
  return entries;
}

function emptyFieldValue(value) {
  return value === "" || value === null || value === undefined
    || (Array.isArray(value) && value.length === 0);
}

function fieldLabel(field) {
  const current = currentFieldValue(field);
  const requirement = field.required ? "Required" : "Optional — press Enter to skip";
  return `${field.prompt} (${requirement})${current ? ` [${current}]` : ""}`;
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
  return left.provider === right.provider && left.role === right.role;
}

function fieldOptions(field) {
  return field.options.map((option) => ({
    ...option,
    label: field.candidates?.some((candidate) => sameOptionValue(candidate, option.value))
      ? `${option.label} (detected)`
      : option.label,
  }));
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
      const value = parseFieldValue(field, await ask(inputMessage(field), field));
      if (!field.required || !emptyFieldValue(value)) {
        answers[field.field_id] = value;
        break;
      }
      showError("This field is required.");
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
    const choices = [
      ...fieldOptions(field),
      ...(field.allow_custom
        ? [{ label: "Other — enter a custom value", value: customValue }]
        : []),
    ];
    if (!field.value_type.endsWith("_array")) {
      const value = await choose(fieldMessage(field), choices);
      if (value !== customValue) return value;
      while (true) {
        const custom = parseFieldValue(
          field,
          await ask(`Enter another value (Required)\nExample: ${field.example}`),
        );
        if (!emptyFieldValue(custom)) return custom;
        write(output, "This field is required.");
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
      if (!selected.includes(customValue)) return selected;
      while (true) {
        const custom = parseFieldValue(
          field,
          await ask(`Enter other values separated by commas\nExample: ${field.example}`),
        );
        if (!emptyFieldValue(custom)) {
          return [...selected.filter((value) => value !== customValue), ...custom];
        }
        write(output, "Enter at least one custom value.");
      }
    }
  };

  return {
    async start() {
      write(output, "LaunchRally Audit");
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
      if (result.status === "completed" && result.report) {
        if (!await confirm("Save the complete Audit JSON to a file?")) return {};
        const outputPath = (await ask("Save path:")).trim();
        return outputPath ? { output_path: outputPath } : {};
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
  const clack = await import("@clack/prompts");
  const common = { input, output, withGuide: false };
  const ask = async (message, field = {}) => cancelled(await clack.text({
    ...common,
    message,
    ...(currentFieldValue(field) ? { initialValue: currentFieldValue(field) } : {}),
    ...(field.example ? { placeholder: `Example: ${field.example}` } : {}),
    ...(field.required
      ? {
        validate: (value) => typeof value === "string" && value.trim()
          ? undefined
          : "This field is required.",
      }
      : {}),
  }), clack, output);
  const selectField = async (field) => {
    const customValue = "__launchrally_custom_value__";
    const options = [
      ...fieldOptions(field),
      ...(field.allow_custom
        ? [{ label: "Other — enter a custom value", value: customValue }]
        : []),
    ];
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
      return parseFieldValue(
        field,
        await ask("Enter another value (Required)", {
          ...field,
          current_value: null,
          required: true,
        }),
      );
    }

    const initialValues = (field.current_value ?? []).map((current) =>
      field.options.find((option) => sameOptionValue(option.value, current))?.value ?? current,
    );
    const selected = cancelled(await clack.multiselect({
      ...common,
      message: fieldMessage(field),
      options,
      initialValues,
      required: field.required,
    }), clack, output);
    if (!selected.includes(customValue)) return selected;
    const custom = parseFieldValue(
      field,
      await ask("Enter other values separated by commas", {
        ...field,
        current_value: [],
        required: true,
      }),
    );
    return [...selected.filter((value) => value !== customValue), ...custom];
  };

  return {
    async start() {
      clack.intro("LaunchRally Audit", common);
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
      if (result.status === "completed" && result.report) {
        const save = await clack.confirm({
          ...common,
          message: "Save the complete Audit JSON to a file?",
          initialValue: false,
        });
        if (!cancelled(save, clack, output)) return {};
        const outputPath = await ask("Save path:");
        return outputPath.trim() ? { output_path: outputPath.trim() } : {};
      }
      return {};
    },
    async close() {},
  };
}
