import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootOption = process.argv.indexOf("--root");
const root = rootOption === -1
  ? scriptRoot
  : path.resolve(process.argv[rootOption + 1] ?? "");
const tagOption = process.argv.indexOf("--tag");
const tag = tagOption === -1 ? null : process.argv[tagOption + 1];

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function assertEligible(contract, acceptance, version) {
  const promotion = contract.stable_promotion;
  const blockers = [];
  if (contract.product_status !== "complete") blockers.push("product_status");
  if (contract.release_status !== "stable") blockers.push("release_status");
  if (contract.validation_status !== "validated") blockers.push("validation_status");
  if (contract.p0_validated !== true) blockers.push("p0_validated");
  if (contract.quality_floor_status !== "satisfied") blockers.push("quality_floor_status");
  if (promotion?.status !== "approved") blockers.push("stable_promotion.status");
  if (promotion?.maintainer_e2e_status !== "complete") {
    blockers.push("stable_promotion.maintainer_e2e_status");
  }
  if (!tag || promotion?.approved_tag !== tag || tag !== `v${version}`) {
    blockers.push("stable_promotion.approved_tag");
  }
  if (
    acceptance.product_status !== contract.product_status
    || acceptance.release_status !== contract.release_status
  ) {
    blockers.push("acceptance.status");
  }
  if (acceptance.requirements?.some(({ status }) => status !== "complete")) {
    blockers.push("acceptance.requirements");
  }
  if (blockers.length > 0) fail("stable_promotion_blocked", blockers.join(", "));
}

function createPlan(release, version) {
  const packages = release.packages.map(({ name }) => name);
  return {
    status: "planned",
    strategy: "new_coherent_version",
    tag,
    version,
    packages,
    publish: packages.map((packageName) => ({
      command: "npm",
      arguments: [
        "publish",
        "--workspace",
        packageName,
        "--provenance",
        "--access",
        "public",
        "--tag",
        "latest",
      ],
    })),
    smoke: {
      command: "npm",
      arguments: ["run", "test:public-release", "--", "--dist-tag", "latest", "--json"],
    },
    github_release: {
      command: "gh",
      arguments: [
        "release",
        "create",
        tag,
        "--verify-tag",
        "--generate-notes",
        "--latest",
        "--title",
        `LaunchRally ${tag}`,
      ],
    },
  };
}

async function publicationState(plan) {
  const published = [];
  const unpublished = [];
  for (const packageName of plan.packages) {
    const packageVersion = `${packageName}@${plan.version}`;
    try {
      await execFileAsync("npm", ["view", packageVersion, "version", "--json"], {
        cwd: root,
        maxBuffer: 1024 * 1024 * 8,
      });
      published.push(packageVersion);
    } catch (error) {
      const detail = `${error.stderr ?? ""}\n${error.message ?? ""}`;
      if (!/\bE404\b|404 Not Found|No match found/u.test(detail)) {
        fail("stable_registry_preflight_failed", `${packageVersion}: ${detail.trim()}`);
      }
      unpublished.push(packageVersion);
    }
  }
  if (published.length > 0 && unpublished.length > 0) {
    fail(
      "partial_stable_publication",
      `${published.join(", ")} exist while ${unpublished.join(", ")} do not; use a new coherent version`,
    );
  }
  return published.length === plan.packages.length ? "published" : "unpublished";
}

async function run(command) {
  try {
    return await execFileAsync(command.command, command.arguments, {
      cwd: root,
      maxBuffer: 1024 * 1024 * 16,
    });
  } catch (error) {
    fail(
      "stable_promotion_command_failed",
      `${command.command} ${command.arguments.join(" ")}: ${error.stderr || error.message}`,
    );
  }
}

async function githubReleaseExists(plan) {
  try {
    await execFileAsync(
      "gh",
      ["release", "view", plan.tag, "--json", "isDraft,isPrerelease"],
      { cwd: root, maxBuffer: 1024 * 1024 * 8 },
    );
    return true;
  } catch (error) {
    const detail = `${error.stderr ?? ""}\n${error.message ?? ""}`;
    if (/release not found|HTTP 404|Not Found/u.test(detail)) return false;
    fail("stable_github_preflight_failed", detail.trim());
  }
}

function githubReleaseEditCommand(plan) {
  return {
    command: "gh",
    arguments: [
      "release",
      "edit",
      plan.tag,
      "--draft=false",
      "--prerelease=false",
      "--latest",
      "--title",
      `LaunchRally ${plan.tag}`,
    ],
  };
}

async function promote(plan) {
  const state = await publicationState(plan);
  if (state === "unpublished") {
    const published = [];
    for (const command of plan.publish) {
      try {
        await run(command);
        published.push(command.arguments[2]);
      } catch (error) {
        if (published.length > 0) {
          fail(
            "partial_stable_publication",
            `${published.join(", ")} published before failure; use a new coherent version`,
          );
        }
        throw error;
      }
    }
  }
  await run(plan.smoke);
  const releaseExists = await githubReleaseExists(plan);
  await run(releaseExists ? githubReleaseEditCommand(plan) : plan.github_release);
  return {
    status: "completed",
    strategy: plan.strategy,
    tag: plan.tag,
    version: plan.version,
    publication: state === "published" ? "resumed" : "published",
    smoke: "verified",
    github_release: releaseExists ? "reconciled" : "created",
  };
}

try {
  const [contract, acceptance, release, rootPackage] = await Promise.all([
    readJson("release/p0.json"),
    readJson("release/p0-acceptance.json"),
    readJson("release/artifacts.json"),
    readJson("package.json"),
  ]);
  assertEligible(contract, acceptance, rootPackage.version);
  const plan = createPlan(release, rootPackage.version);
  const result = process.argv.includes("--dry-run") ? plan : await promote(plan);
  process.stdout.write(
    process.argv.includes("--json")
      ? `${JSON.stringify(result)}\n`
      : process.argv.includes("--dry-run")
        ? `${plan.publish.length} packages are eligible for Stable promotion as ${tag}.\n`
        : `Promoted ${tag} to Stable.\n`,
  );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
