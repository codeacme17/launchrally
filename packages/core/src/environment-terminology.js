function scopedLabel(intendedEnvironment, noun, { capitalize = false, plural = false } = {}) {
  const environment = typeof intendedEnvironment === "string"
    ? intendedEnvironment.trim().replace(/\s+/gu, " ")
    : "";
  const label = `${environment || "confirmed"} ${noun}${plural ? "s" : ""}`;
  return capitalize ? `${label[0].toUpperCase()}${label.slice(1)}` : label;
}

export function environmentTargetLabel(intendedEnvironment, options) {
  return scopedLabel(intendedEnvironment, "target", options);
}

export function environmentHostLabel(intendedEnvironment, options) {
  return scopedLabel(intendedEnvironment, "host", options);
}
