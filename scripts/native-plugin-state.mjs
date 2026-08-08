export function hasClaudeInstalledPlugin(state, pluginId, version) {
  return Array.isArray(state?.installed) && state.installed.some((entry) => (
    entry?.id === pluginId && entry?.version === version
  ));
}
