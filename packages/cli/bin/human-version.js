import { terminalSafeText } from "./human-architect.js";

function styledText(value, style, enabled) {
  return enabled ? `\u001B[${style}m${value}\u001B[0m` : value;
}

function nextActionLabel(authority) {
  const action = authority?.next_action;
  if (!action) return "unavailable";
  if (action.operation === "none") return "none";
  return action.operation ?? "unavailable";
}

export function renderHumanVersion(result, { styled = false } = {}) {
  const authority = result.authority ?? {};
  const engineLabel = authority.source === "project_toolchain"
    ? "Project Engine"
    : "Selected Engine";
  return [
    styledText("LaunchRally Version", "1;36", styled),
    `Launcher: ${styledText(terminalSafeText(result.launcher_version), "1", styled)}`,
    `${engineLabel}: ${styledText(terminalSafeText(result.cli_version ?? authority.engine?.version), "1", styled)}`,
    `Authority: ${styledText(terminalSafeText(authority.state), "1", styled)} (${terminalSafeText(authority.source)})`,
    `Compatibility: ${terminalSafeText(authority.engine?.compatibility)}`,
    `Materialization: ${terminalSafeText(authority.materialization?.state)}`,
    `Next action: ${terminalSafeText(nextActionLabel(authority))}`,
  ].join("\n");
}
