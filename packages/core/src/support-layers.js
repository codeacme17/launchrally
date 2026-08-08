export const SUPPORT_LAYER_CATEGORIES = Object.freeze([
  "analytics",
  "observability",
]);

const SUPPORT_LAYER_ALIASES = new Map([
  ["analytics", "analytics"],
  ["monitoring", "observability"],
  ["observability", "observability"],
  ["posthog", "analytics"],
  ["posthog analytics", "analytics"],
  ["sentry", "observability"],
  ["sentry observability", "observability"],
]);

export function normalizeSupportLayer(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim().toLowerCase().replaceAll(/\s+/gu, " ");
  return SUPPORT_LAYER_ALIASES.get(normalized) ?? null;
}

export function normalizeSupportLayers(values) {
  if (!Array.isArray(values)) return null;
  const normalized = values.map(normalizeSupportLayer);
  if (normalized.some((value) => value === null)) return null;
  return [...new Set(normalized)].sort();
}

export function supportLayerIsSelected(values, category) {
  return normalizeSupportLayers(values)?.includes(category) ?? false;
}
