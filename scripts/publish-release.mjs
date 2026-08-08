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
const rootPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = rootPackage.version;
const commands = release.packages.map((artifact) => ({
  command: "npm",
  arguments: [
    "publish",
    "--workspace",
    artifact.name,
    "--provenance",
    "--access",
    "public",
    "--tag",
    "experimental",
  ],
}));
const plan = {
  packages: release.packages.map((artifact) => artifact.name),
  commands,
};

async function assertVersionIsUnpublished() {
  const existing = [];
  for (const packageName of plan.packages) {
    const packageVersion = `${packageName}@${version}`;
    try {
      await execFileAsync("npm", ["view", packageVersion, "version", "--json"], {
        cwd: root,
        maxBuffer: 1024 * 1024 * 8,
      });
      existing.push(packageVersion);
    } catch (error) {
      const detail = error.stderr || error.message;
      if (!/\bE404\b|404 Not Found/u.test(detail)) {
        throw new Error(`release_registry_preflight_failed: ${packageVersion}: ${detail}`);
      }
    }
  }
  if (existing.length > 0) {
    throw new Error(
      `release_version_already_exists: ${existing.join(", ")}; publish every package under a new coherent version`,
    );
  }
}

async function publishRelease() {
  await assertVersionIsUnpublished();
  const published = [];
  for (const { command, arguments: arguments_ } of commands) {
    const packageName = arguments_[arguments_.indexOf("--workspace") + 1];
    const packageVersion = `${packageName}@${version}`;
    try {
      const { stdout, stderr } = await execFileAsync(command, arguments_, {
        cwd: root,
        maxBuffer: 1024 * 1024 * 8,
      });
      process.stdout.write(stdout);
      process.stderr.write(stderr);
      published.push(packageVersion);
    } catch (error) {
      if (published.length > 0) {
        throw new Error(
          `partial_publication: ${published.join(", ")} published before ${packageVersion} failed; publish every package under a new coherent version before retrying\n${error.stderr || error.message}`,
        );
      }
      throw new Error(`release_publish_failed: ${packageVersion}: ${error.stderr || error.message}`);
    }
  }
}

if (process.argv.includes("--dry-run")) {
  process.stdout.write(
    process.argv.includes("--json")
      ? `${JSON.stringify(plan)}\n`
      : `${commands.map(({ command, arguments: arguments_ }) => (
        [command, ...arguments_].join(" ")
      )).join("\n")}\n`,
  );
} else {
  try {
    await publishRelease();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
