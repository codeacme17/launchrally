import path from "node:path";

export function isRepositoryRelativePath(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)
    && path.posix.normalize(value) === value
    && !value.split("/").includes("..");
}

export function walkValidationValue(value, visitor) {
  if (typeof value === "string") {
    visitor.string?.(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const nested of value) walkValidationValue(nested, visitor);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    visitor.key?.(key);
    walkValidationValue(nested, visitor);
  }
}

export function assertAppendOnlyLog(current, baseline, onChanged) {
  if (
    current.schema_version !== baseline.schema_version
    || current.collection_mode !== baseline.collection_mode
    || !Array.isArray(current.entries)
    || !Array.isArray(baseline.entries)
    || current.entries.length < baseline.entries.length
  ) {
    onChanged("reviewed Validation Log metadata or entries changed");
    return;
  }
  for (const [index, entry] of baseline.entries.entries()) {
    if (JSON.stringify(current.entries[index]) !== JSON.stringify(entry)) {
      onChanged(`entry ${index} differs from reviewed history`);
      return;
    }
  }
}
