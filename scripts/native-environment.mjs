const PASSTHROUGH_KEYS = Object.freeze([
  "CI",
  "ComSpec",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_COLOR",
  "PATHEXT",
  "PATH",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "WINDIR",
]);

const PROXY_KEYS = Object.freeze([
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "no_proxy",
]);

function safeProxyValue(key, value) {
  if (/no_proxy/iu.test(key)) return value;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && url.username === ""
      && url.password === ""
      ? value
      : null;
  } catch {
    return null;
  }
}

export function createIsolatedNativeEnvironment(source, {
  home,
  codex_home: codexHome,
  claude_config_dir: claudeConfigDirectory,
}) {
  const environment = {};
  for (const key of PASSTHROUGH_KEYS) {
    if (typeof source[key] === "string" && source[key] !== "") {
      environment[key] = source[key];
    }
  }
  for (const key of PROXY_KEYS) {
    if (typeof source[key] !== "string" || source[key] === "") continue;
    const value = safeProxyValue(key, source[key]);
    if (value !== null) environment[key] = value;
  }
  return {
    ...environment,
    APPDATA: home,
    CLAUDE_CONFIG_DIR: claudeConfigDirectory,
    CODEX_HOME: codexHome,
    HOME: home,
    LOCALAPPDATA: home,
    NODE_OPTIONS: "",
    USERPROFILE: home,
    XDG_CACHE_HOME: home,
    XDG_CONFIG_HOME: home,
  };
}
