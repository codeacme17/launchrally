export function parsePublicTargetInput(input) {
  if (typeof input !== "string" || !input.trim()) {
    return { error: "invalid_url" };
  }
  try {
    const url = new URL(input.trim());
    if (!["http:", "https:"].includes(url.protocol)) {
      return { error: "invalid_url" };
    }
    if (url.username || url.password || url.search || url.hash) {
      return { error: "unsafe_public_target" };
    }
    return { value: url.toString() };
  } catch {
    return { error: "invalid_url" };
  }
}
