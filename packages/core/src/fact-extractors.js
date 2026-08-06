import path from "node:path";

const SOURCE_EXTENSIONS = new Map([
  [".cjs", "javascript"],
  [".css", "css"],
  [".html", "html"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".less", "less"],
  [".mjs", "javascript"],
  [".scss", "scss"],
  [".svelte", "svelte"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".vue", "vue"],
]);
const CONFIG_EXTENSIONS = new Set([".json", ".toml", ".yaml", ".yml"]);

export function isEnvironmentFile(name) {
  return /^\.env(?:\..+)?$/u.test(name);
}

function configFormat(name) {
  const lowerName = name.toLowerCase();
  if (
    lowerName === ".gitignore"
    || lowerName === "dockerfile"
    || /^(?:compose|docker-compose)(?:\..+)?$/u.test(lowerName)
    || /^(?:astro|eslint|next|nuxt|prettier|rollup|svelte|tsconfig|vite|webpack)\./u.test(lowerName)
  ) {
    return path.extname(lowerName).slice(1) || "text";
  }
  const extension = path.extname(lowerName);
  return CONFIG_EXTENSIONS.has(extension) ? extension.slice(1) : null;
}

export function classifyContentFile(name) {
  if (isEnvironmentFile(name)) return { kind: "environment_variables" };
  if (name === "package.json") return { kind: "package_manifest" };

  const language = SOURCE_EXTENSIONS.get(path.extname(name).toLowerCase());
  if (language) return { kind: "source_file", language };

  const format = configFormat(name);
  return format ? { kind: "configuration_file", format } : null;
}

function scriptNames(scripts) {
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return [];
  return Object.keys(scripts)
    .filter((name) => typeof name === "string" && name.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function environmentNames(content) {
  const names = new Set();
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u);
    if (match) names.add(match[1]);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

export function extractContentFact(classification, content, provenance) {
  if (classification.kind === "environment_variables") {
    return {
      kind: classification.kind,
      names: environmentNames(content),
      provenance,
    };
  }

  if (classification.kind === "package_manifest") {
    try {
      const manifest = JSON.parse(content);
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error();
      return {
        kind: classification.kind,
        status: "valid",
        ...(typeof manifest.name === "string" && manifest.name.length > 0
          ? { name: manifest.name }
          : {}),
        script_names: scriptNames(manifest.scripts),
        provenance,
      };
    } catch {
      return {
        kind: classification.kind,
        status: "invalid",
        script_names: [],
        provenance,
      };
    }
  }

  return { ...classification, provenance };
}
