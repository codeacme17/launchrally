import { createInterface } from "node:readline/promises";

import { PromptCancelledError } from "./human-audit.js";

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

async function collectAnswers(result, ask) {
  const answers = {};
  for (const field of result.request.fields) {
    const current = currentFieldValue(field);
    const suffix = current ? ` [${current}]` : "";
    const value = await ask(`${field.prompt}${suffix}`);
    answers[field.field_id] = parseFieldValue(field, value);
  }
  return answers;
}

export function createPlainPromptAdapter({ input, output }) {
  const controller = new AbortController();
  const readline = createInterface({ input, output, terminal: false });
  input.on("SIGINT", () => controller.abort());

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

  return {
    async start() {
      write(output, "LaunchRally Audit");
    },
    async respond(result) {
      if (result.status === "needs_input") {
        write(output, inputStateText(result));
        return { answers: await collectAnswers(result, ask) };
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
  const ask = async (message, initialValue = "") => cancelled(await clack.text({
    ...common,
    message,
    ...(initialValue ? { initialValue } : {}),
  }), clack, output);

  return {
    async start() {
      clack.intro("LaunchRally Audit", common);
    },
    async respond(result) {
      if (result.status === "needs_input") {
        clack.note(inputStateText(result), "Audit Brief", common);
        return { answers: await collectAnswers(result, ask) };
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
