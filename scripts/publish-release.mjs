import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const release = JSON.parse(await readFile(
  path.join(root, "release/artifacts.json"),
  "utf8",
));
const commands = release.packages.map((artifact) => ({
  command: "npm",
  arguments: [
    "publish",
    "--workspace",
    artifact.name,
    "--provenance",
    "--access",
    "public",
  ],
}));
const plan = {
  packages: release.packages.map((artifact) => artifact.name),
  commands,
};

if (process.argv.includes("--dry-run")) {
  process.stdout.write(
    process.argv.includes("--json")
      ? `${JSON.stringify(plan)}\n`
      : `${commands.map(({ command, arguments: arguments_ }) => (
        [command, ...arguments_].join(" ")
      )).join("\n")}\n`,
  );
} else {
  for (const { command, arguments: arguments_ } of commands) {
    try {
      const { stdout, stderr } = await execFileAsync(command, arguments_, {
        cwd: root,
        maxBuffer: 1024 * 1024 * 8,
      });
      process.stdout.write(stdout);
      process.stderr.write(stderr);
    } catch (error) {
      process.stderr.write(error.stderr || `${error.message}\n`);
      process.exitCode = 1;
      break;
    }
  }
}
