function scopedLabel(intendedEnvironment, noun, { capitalize = false, plural = false } = {}) {
  const environment = reviewedEnvironmentLabel(intendedEnvironment);
  const label = `${environment || "confirmed"} ${noun}${plural ? "s" : ""}`;
  return capitalize ? `${label[0].toUpperCase()}${label.slice(1)}` : label;
}

export function reviewedEnvironmentLabel(intendedEnvironment) {
  return typeof intendedEnvironment === "string"
    ? intendedEnvironment
        .replace(/[\u0000-\u001f\u007f]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
    : "";
}

export function environmentTargetLabel(intendedEnvironment, options) {
  return scopedLabel(intendedEnvironment, "target", options);
}
