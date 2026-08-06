function escapeExpression(character) {
  return character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function stripTrailingSpaces(line) {
  let end = line.length;
  while (end > 0 && line[end - 1] === " ") {
    let backslashes = 0;
    for (let index = end - 2; index >= 0 && line[index] === "\\"; index -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 1) break;
    end -= 1;
  }
  return line.slice(0, end);
}

function globSource(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\" && index + 1 < pattern.length) {
      index += 1;
      source += escapeExpression(pattern[index]);
    } else if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const closing = pattern.indexOf("]", index + 1);
      if (closing === -1) {
        source += "\\[";
      } else {
        let characterClass = pattern.slice(index + 1, closing);
        if (characterClass.startsWith("!")) characterClass = `^${characterClass.slice(1)}`;
        source += `[${characterClass}]`;
        index = closing;
      }
    } else {
      source += escapeExpression(character);
    }
  }
  return source;
}

export function parseIgnoreFile(content, base) {
  const rules = [];
  for (const rawLine of content.split(/\r?\n/u)) {
    let line = stripTrailingSpaces(rawLine);
    if (!line || line.startsWith("#")) continue;

    const escapedLeadingMarker = line.startsWith("\\#") || line.startsWith("\\!");
    if (escapedLeadingMarker) line = line.slice(1);
    const negated = !escapedLeadingMarker && line.startsWith("!");
    if (negated) line = line.slice(1);
    if (!line) continue;

    const anchored = line.startsWith("/");
    if (anchored) line = line.slice(1);
    if (line.endsWith("/")) line = line.slice(0, -1);
    if (!line) continue;

    const source = globSource(line);
    const hasSlash = line.includes("/");
    rules.push({
      base,
      negated,
      expression: new RegExp(
        anchored || hasSlash
          ? `^${source}(?:/.*)?$`
          : `(?:^|/)${source}(?:$|/.*)`,
        "u",
      ),
    });
  }
  return rules;
}

export function isIgnored(relativePath, rules) {
  let ignored = false;
  for (const rule of rules) {
    const withinBase = rule.base === ""
      ? relativePath
      : relativePath === rule.base
        ? ""
        : relativePath.startsWith(`${rule.base}/`)
          ? relativePath.slice(rule.base.length + 1)
          : null;
    if (withinBase !== null && rule.expression.test(withinBase)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}
