import { rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TOKEN_TYPES = Object.freeze({
  init: Object.freeze({
    pattern: /^(lrinit)_([A-Za-z0-9]{6}|[A-Za-z0-9]{12})(_.+)$/u,
    directory_prefix: "launchrally-init-preview-",
  }),
  providers: Object.freeze({
    pattern: /^(lrproviders)_([A-Za-z0-9]{6}|[A-Za-z0-9]{12})(_.+)$/u,
    directory_prefix: "launchrally-providers-",
  }),
  verify: Object.freeze({
    pattern: /^(lrverify)_([A-Za-z0-9]{6}|[A-Za-z0-9]{12})(_.+)$/u,
    directory_prefix: "launchrally-verify-",
  }),
});

export async function simulateExtendedMkdtempSuffix(token, type) {
  const tokenType = TOKEN_TYPES[type];
  const match = token.match(tokenType.pattern);
  if (!match) throw new Error(`Unexpected ${type} token shape.`);
  if (match[2].length === 12) return token;
  const extendedSuffix = `XXXXXX${match[2]}`;
  await rename(
    path.join(os.tmpdir(), `${tokenType.directory_prefix}${match[2]}`),
    path.join(os.tmpdir(), `${tokenType.directory_prefix}${extendedSuffix}`),
  );
  return `${match[1]}_${extendedSuffix}${match[3]}`;
}
