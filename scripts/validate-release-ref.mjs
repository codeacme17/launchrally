import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootOption = process.argv.indexOf("--root");
const root = rootOption === -1
  ? process.cwd()
  : path.resolve(process.argv[rootOption + 1] ?? "");
const tagOption = process.argv.indexOf("--tag");
const tag = tagOption === -1 ? "" : process.argv[tagOption + 1] ?? "";
const allowPromotionHead = process.argv.includes("--allow-promotion-head");

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

async function git(arguments_) {
  try {
    const { stdout } = await execFileAsync("git", arguments_, { cwd: root });
    return stdout.trim();
  } catch (error) {
    fail("release_ref_unavailable", error.stderr?.trim() || error.message);
  }
}

async function validateReleaseRef() {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tag)) {
    fail("release_ref_invalid_tag", tag || "missing tag");
  }
  const tagRef = `refs/tags/${tag}`;
  const tagType = await git(["cat-file", "-t", tagRef]);
  if (tagType !== "tag") fail("release_tag_not_annotated", `${tag} is ${tagType}`);

  const tagCommit = await git(["rev-parse", `${tagRef}^{commit}`]);
  const headCommit = await git(["rev-parse", "HEAD^{commit}"]);
  const mainCommit = await git(["rev-parse", "refs/remotes/origin/main^{commit}"]);
  if (tagCommit !== headCommit) {
    fail("release_tag_checkout_mismatch", `${tagCommit} != ${headCommit}`);
  }
  if (!allowPromotionHead && tagCommit !== mainCommit) {
    fail("release_tag_not_on_main", `${tagCommit} != ${mainCommit}`);
  }
  return {
    status: "completed",
    tag,
    tag_type: "annotated",
    commit: tagCommit,
    main_commit: mainCommit,
  };
}

try {
  const result = await validateReleaseRef();
  process.stdout.write(
    process.argv.includes("--json")
      ? `${JSON.stringify(result)}\n`
      : allowPromotionHead
        ? `Validated annotated promotion tag ${result.tag}.\n`
        : `Validated annotated release tag ${result.tag} on origin/main.\n`,
  );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
