import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createExternalHostEnvelope } from "./verify-p1-external-results.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

async function main() {
  const host = option("--host");
  const challenge = option("--challenge");
  const output = option("--output");
  if (output === null) throw new Error("p1_external_result_invalid: output missing");
  const { stdout } = await execFileAsync("npm", [
    "--silent",
    "run",
    "test:public-release",
    "--",
    "--dist-tag",
    "experimental",
    "--json",
  ], { cwd: root, maxBuffer: 1024 * 1024 * 32 });
  const result = JSON.parse(stdout);
  const envelope = createExternalHostEnvelope({
    host,
    challenge,
    result,
    version: result.version,
  });
  await writeFile(path.resolve(output), `${JSON.stringify(envelope, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return { status: "completed", host, output: path.resolve(output) };
}

try {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
