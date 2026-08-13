const OPTIONS_WITH_VALUES = new Set([
  "--answers",
  "--alternatives",
  "--catalog",
  "--confirm",
  "--constraints",
  "--decisions",
  "--checks",
  "--choice",
  "--cwd",
  "--gap",
  "--journey-results",
  "--graph",
  "--intent",
  "--integrations",
  "--output",
  "--package",
  "--permissions",
  "--report",
  "--recover",
  "--review-date",
  "--role",
  "--resume",
  "--scope",
  "--select",
  "--to",
]);

export function commandName(arguments_) {
  if (arguments_.includes("--version")) return "version";
  for (let index = 0; index < arguments_.length; index += 1) {
    if (OPTIONS_WITH_VALUES.has(arguments_[index])) {
      index += 1;
      continue;
    }
    if (!arguments_[index].startsWith("-")) return arguments_[index];
  }
  return "help";
}

export function optionValue(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index === -1 ? undefined : arguments_[index + 1];
}
