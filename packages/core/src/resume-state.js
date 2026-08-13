import { createHash, timingSafeEqual } from "node:crypto";

export function encodeResumeState(state) {
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  const digest = createHash("sha256").update(payload).digest("base64url");
  return `${payload}.${digest}`;
}

export function decodeResumeState(token, predicate) {
  if (typeof token !== "string") return null;
  const [payload, suppliedDigest, extra] = token.split(".");
  if (!payload || !suppliedDigest || extra !== undefined) return null;
  const expected = createHash("sha256").update(payload).digest();
  let actual;
  try {
    actual = Buffer.from(suppliedDigest, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return predicate(state) ? state : null;
  } catch {
    return null;
  }
}
