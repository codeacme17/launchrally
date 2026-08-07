import { cp, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function copyRepositoryFixture(root, prefix, relativePaths) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), prefix));
  for (const relative of relativePaths) {
    await cp(path.join(root, relative), path.join(fixture, relative), { recursive: true });
  }
  return fixture;
}
