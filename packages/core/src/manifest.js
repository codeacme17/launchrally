export const MANIFEST_RELATIVE_PATH = ".launchrally/manifest.yaml";
export const LEGACY_MANIFEST_RELATIVE_PATH = ".launchrally/launch-manifest.json";

const KEY_ORDER = Object.freeze([
  "schema_version",
  "project",
  "release",
  "execution",
  "support",
  "providers",
  "name",
  "type",
  "package_manager",
  "intended_environment",
  "production_targets",
  "core_journeys",
  "source_report_id",
  "assessment",
  "public_verification",
  "layers",
  "roles",
  "decision",
  "state",
  "value",
  "reason",
  "evidence",
  "field",
  "card_id",
  "card_version",
  "capability_id",
  "provider",
  "role",
  "confirmed",
]);
const KEY_RANK = new Map(KEY_ORDER.map((key, index) => [key, index]));

function keyOrder(left, right) {
  const leftRank = KEY_RANK.get(left) ?? KEY_ORDER.length;
  const rightRank = KEY_RANK.get(right) ?? KEY_ORDER.length;
  return leftRank === rightRank ? left.localeCompare(right) : leftRank - rightRank;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort(keyOrder).map((key) => [
    key,
    canonicalValue(value[key]),
  ]));
}

function isNested(value) {
  return Array.isArray(value)
    ? value.length > 0
    : Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
}

export function serializeManifest(manifest) {
  function scalar(value) {
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "boolean" || value === null) return String(value);
    if (Array.isArray(value) && value.length === 0) return "[]";
    if (value && typeof value === "object" && Object.keys(value).length === 0) return "{}";
    throw new TypeError("Manifest values must be YAML-safe scalars, arrays, or objects.");
  }

  function lines(value, indent) {
    const padding = " ".repeat(indent);
    if (Array.isArray(value)) {
      if (value.length === 0) return [`${padding}[]`];
      return value.flatMap((item) => {
        const nested = isNested(item);
        return nested
          ? [`${padding}-`, ...lines(item, indent + 2)]
          : [`${padding}- ${scalar(item)}`];
      });
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length === 0) return [`${padding}{}`];
      return entries.flatMap(([key, item]) => {
        const nested = isNested(item);
        return nested
          ? [`${padding}${key}:`, ...lines(item, indent + 2)]
          : [`${padding}${key}: ${scalar(item)}`];
      });
    }
    return [`${padding}${scalar(value)}`];
  }

  return `${lines(canonicalValue(manifest), 0).join("\n")}\n`;
}

export function parseManifest(content) {
  const invalid = () => {
    const error = new Error("The LaunchRally Manifest YAML is invalid.");
    error.code = "invalid_manifest";
    return error;
  };
  try {
    if (typeof content !== "string" || content.includes("\t")) throw invalid();
    const trimmed = content.trim();
    if (trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid();
      return parsed;
    }
    const tokens = content.split(/\r?\n/u).flatMap((line, lineIndex) => {
      if (!line.trim() || line.trimStart().startsWith("#")) return [];
      const indent = line.length - line.trimStart().length;
      if (indent % 2 !== 0 || line.trimEnd() !== line) throw invalid();
      return [{ indent, text: line.slice(indent), lineIndex }];
    });
    if (tokens.length === 0) throw invalid();

    function parseScalar(source) {
      if (["&", "*", "!", "|", ">", "[", "{"].some((prefix) =>
        source.startsWith(prefix)) && !["[]", "{}"].includes(source)) throw invalid();
      if (source === "[]") return [];
      if (source === "{}") return {};
      if (source === "null") return null;
      if (source === "true") return true;
      if (source === "false") return false;
      if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(source)) return Number(source);
      if (source.startsWith('"')) {
        const value = JSON.parse(source);
        if (typeof value !== "string") throw invalid();
        return value;
      }
      if (source.startsWith("'") && source.endsWith("'")) {
        return source.slice(1, -1).replaceAll("''", "'");
      }
      if (!source || source.startsWith("- ") || source.includes(" #")) throw invalid();
      return source;
    }

    function parseNode(start, indent) {
      const first = tokens[start];
      if (!first || first.indent !== indent) throw invalid();
      const sequence = first.text === "-" || first.text.startsWith("- ");
      if (sequence) {
        const value = [];
        let index = start;
        while (index < tokens.length && tokens[index].indent === indent) {
          const token = tokens[index];
          if (token.text !== "-" && !token.text.startsWith("- ")) throw invalid();
          const rest = token.text.slice(1).trimStart();
          if (rest) {
            value.push(parseScalar(rest));
            index += 1;
          } else {
            const parsed = parseNode(index + 1, indent + 2);
            value.push(parsed.value);
            index = parsed.next;
          }
        }
        return { value, next: index };
      }

      const value = {};
      let index = start;
      while (index < tokens.length && tokens[index].indent === indent) {
        const token = tokens[index];
        if (token.text === "-" || token.text.startsWith("- ")) throw invalid();
        const match = token.text.match(/^([A-Za-z_][A-Za-z0-9_]*):(.*)$/u);
        if (!match || Object.hasOwn(value, match[1])) throw invalid();
        const rest = match[2].trimStart();
        if (rest) {
          value[match[1]] = parseScalar(rest);
          index += 1;
        } else {
          const parsed = parseNode(index + 1, indent + 2);
          value[match[1]] = parsed.value;
          index = parsed.next;
        }
      }
      return { value, next: index };
    }

    const parsed = parseNode(0, 0);
    if (parsed.next !== tokens.length || !parsed.value || Array.isArray(parsed.value)) {
      throw invalid();
    }
    return parsed.value;
  } catch {
    throw invalid();
  }
}
