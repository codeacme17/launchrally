import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SLSA_PROVENANCE = "https://slsa.dev/provenance/v1";
const GITHUB_WORKFLOW_BUILD =
  "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const REPOSITORY = "https://github.com/codeacme17/launchrally";
const WORKFLOW = ".github/workflows/release.yml";

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function exactKeys(value, expected, owner) {
  const actual = Object.keys(value ?? {}).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    fail("p1_candidate_invalid", `${owner}: ${actual.join(",")}`);
  }
}

function sha512Hex(integrity) {
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    fail("p1_candidate_invalid", "integrity");
  }
  const bytes = Buffer.from(integrity.slice("sha512-".length), "base64");
  if (bytes.length !== 64 || `sha512-${bytes.toString("base64")}` !== integrity) {
    fail("p1_candidate_invalid", "integrity");
  }
  return bytes.toString("hex");
}

function packagePurl(name, version) {
  return `pkg:npm/${name.replace(/^@/u, "%40")}@${version}`;
}

function assertCandidate(candidate) {
  exactKeys(candidate, [
    "channel",
    "p0_stable_version",
    "packages",
    "schema_version",
    "stable_channel",
    "tag",
    "version",
  ], "candidate");
  if (
    candidate.schema_version !== "launchrally.dev/p1-release-candidate/v1"
    || !/^\d+\.\d+\.\d+$/u.test(candidate.version ?? "")
    || candidate.tag !== `v${candidate.version}`
    || candidate.channel !== "experimental"
    || candidate.stable_channel !== "latest"
    || !/^\d+\.\d+\.\d+$/u.test(candidate.p0_stable_version ?? "")
    || !Array.isArray(candidate.packages)
    || candidate.packages.length === 0
  ) fail("p1_candidate_invalid", "identity");
  const names = new Set();
  for (const artifact of candidate.packages) {
    exactKeys(artifact, ["integrity", "name", "shasum"], artifact?.name ?? "package");
    if (
      typeof artifact.name !== "string"
      || names.has(artifact.name)
      || !/^[a-f0-9]{40}$/u.test(artifact.shasum ?? "")
    ) fail("p1_candidate_invalid", artifact?.name ?? "package");
    sha512Hex(artifact.integrity);
    names.add(artifact.name);
  }
}

export function verifyExperimentalCandidateBindings({ candidate, rootPackage, p0, p1 }) {
  assertCandidate(candidate);
  const publication = p1?.experimental_publication;
  if (
    rootPackage?.version !== candidate.version
    || p0?.release_status !== "stable"
    || p0?.stable_promotion?.approved_tag !== `v${candidate.p0_stable_version}`
    || p1?.release_status !== "experimental"
    || p1?.publication_status !== "not_published"
    || publication?.candidate_tag !== candidate.tag
    || publication?.candidate_manifest !== "release/p1-release-candidate.json"
    || publication?.channel !== candidate.channel
    || publication?.stable_channel !== candidate.stable_channel
    || publication?.p0_stable_tag !== p0.stable_promotion.approved_tag
  ) fail("p1_candidate_identity_mismatch", "release candidate and governance records differ");
  return {
    version: candidate.version,
    tag: candidate.tag,
    channel: candidate.channel,
    p0_latest: candidate.p0_stable_version,
  };
}

function assertProvenance(candidate, artifact, record, expectedCommit) {
  const provenance = record.provenance;
  const workflow = provenance?.predicate?.buildDefinition?.externalParameters?.workflow;
  const dependencies = provenance?.predicate?.buildDefinition?.resolvedDependencies;
  const subject = provenance?.subject?.find(
    ({ name }) => name === packagePurl(artifact.name, candidate.version),
  );
  if (
    record.dist?.attestations?.provenance?.predicateType !== SLSA_PROVENANCE
    || provenance?._type !== "https://in-toto.io/Statement/v1"
    || provenance?.predicateType !== SLSA_PROVENANCE
    || provenance?.predicate?.buildDefinition?.buildType !== GITHUB_WORKFLOW_BUILD
    || workflow?.repository !== REPOSITORY
    || workflow?.path !== WORKFLOW
    || workflow?.ref !== `refs/tags/${candidate.tag}`
    || provenance?.predicate?.runDetails?.builder?.id
      !== "https://github.com/actions/runner/github-hosted"
    || subject?.digest?.sha512 !== sha512Hex(artifact.integrity)
    || !Array.isArray(dependencies)
    || !dependencies.some(({ uri, digest }) => (
      uri === `git+${REPOSITORY}@refs/tags/${candidate.tag}`
      && digest?.gitCommit === expectedCommit
    ))
  ) fail("p1_published_provenance_mismatch", artifact.name);
}

export function verifyPublishedExperimentalRelease({ candidate, published, expectedCommit }) {
  assertCandidate(candidate);
  if (!/^[a-f0-9]{40}$/u.test(expectedCommit ?? "")) {
    fail("p1_published_provenance_mismatch", "tag commit");
  }
  if (!Array.isArray(published) || published.length !== candidate.packages.length) {
    fail("p1_published_roster_mismatch", "package count");
  }
  const records = new Map(published.map((record) => [record.name, record]));
  if (records.size !== published.length) fail("p1_published_roster_mismatch", "duplicates");
  for (const artifact of candidate.packages) {
    const record = records.get(artifact.name);
    if (!record) fail("p1_published_roster_mismatch", artifact.name);
    if (
      record.dist?.integrity !== artifact.integrity
      || record.dist?.shasum !== artifact.shasum
    ) fail("p1_published_digest_mismatch", artifact.name);
    if (record.dist_tags?.[candidate.channel] !== candidate.version) {
      fail("p1_experimental_channel_mismatch", artifact.name);
    }
    if (record.dist_tags?.[candidate.stable_channel] !== candidate.p0_stable_version) {
      fail("p1_stable_channel_changed", artifact.name);
    }
    assertProvenance(candidate, artifact, record, expectedCommit);
  }
  return {
    status: "completed",
    version: candidate.version,
    tag: candidate.tag,
    channel: candidate.channel,
    p0_latest: candidate.p0_stable_version,
    packages: candidate.packages.map(({ name }) => name),
    digests: "candidate_matches_published",
    provenance: "github_release_workflow_verified",
  };
}

async function json(relativePath) {
  return JSON.parse(await readFile(path.join(scriptRoot, relativePath), "utf8"));
}

async function command(commandName, arguments_) {
  try {
    return await execFileAsync(commandName, arguments_, {
      cwd: scriptRoot,
      maxBuffer: 1024 * 1024 * 16,
    });
  } catch (error) {
    fail(
      "p1_external_verification_command_failed",
      `${commandName} ${arguments_.join(" ")}: ${error.stderr || error.message}`,
    );
  }
}

async function verifyCandidate(candidate) {
  const [release, rootPackage, p0, p1] = await Promise.all([
    json("release/artifacts.json"),
    json("package.json"),
    json("release/p0.json"),
    json("release/p1.json"),
  ]);
  verifyExperimentalCandidateBindings({ candidate, rootPackage, p0, p1 });
  const expectedNames = release.packages.map(({ name }) => name);
  if (JSON.stringify(candidate.packages.map(({ name }) => name)) !== JSON.stringify(expectedNames)) {
    fail("p1_candidate_invalid", "package roster");
  }
  const cache = path.join(os.tmpdir(), `launchrally-p1-pack-${process.pid}`);
  const computed = [];
  for (const name of expectedNames) {
    const { stdout } = await command("npm", [
      "pack",
      "--workspace",
      name,
      "--json",
      "--dry-run",
      "--cache",
      cache,
    ]);
    const [artifact] = JSON.parse(stdout);
    computed.push({ name, integrity: artifact.integrity, shasum: artifact.shasum });
  }
  if (JSON.stringify(computed) !== JSON.stringify(candidate.packages)) {
    fail("p1_candidate_digest_mismatch", "committed candidate does not match npm pack");
  }
  return {
    status: "completed",
    phase: "candidate",
    version: candidate.version,
    tag: candidate.tag,
    packages: expectedNames,
    digests: "npm_pack_matches_candidate",
  };
}

function decodeProvenance(attestations, packageName) {
  const attestation = attestations?.attestations?.find(
    ({ predicateType }) => predicateType === SLSA_PROVENANCE,
  );
  const payload = attestation?.bundle?.dsseEnvelope?.payload;
  if (typeof payload !== "string") fail("p1_published_provenance_mismatch", packageName);
  try {
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch {
    fail("p1_published_provenance_mismatch", packageName);
  }
}

async function publishedRecord(artifact, candidate) {
  const { stdout: distOutput } = await command("npm", [
    "view",
    `${artifact.name}@${candidate.version}`,
    "dist",
    "dist-tags",
    "--json",
  ]);
  const metadata = JSON.parse(distOutput);
  const attestationUrl = new URL(metadata.dist?.attestations?.url ?? "");
  if (attestationUrl.protocol !== "https:" || attestationUrl.hostname !== "registry.npmjs.org") {
    fail("p1_published_provenance_mismatch", artifact.name);
  }
  const response = await fetch(attestationUrl, { redirect: "error" });
  if (!response.ok) fail("p1_published_provenance_mismatch", artifact.name);
  const attestations = await response.json();
  return {
    name: artifact.name,
    dist: metadata.dist,
    dist_tags: metadata["dist-tags"],
    provenance: decodeProvenance(attestations, artifact.name),
  };
}

async function main() {
  const phaseIndex = process.argv.indexOf("--phase");
  const phase = phaseIndex === -1 ? "candidate" : process.argv[phaseIndex + 1];
  const candidate = await json("release/p1-release-candidate.json");
  if (phase === "candidate") return verifyCandidate(candidate);
  if (phase !== "published") fail("p1_external_verification_phase_invalid", phase ?? "missing");
  const [{ stdout: commitOutput }, published] = await Promise.all([
    command("git", ["rev-parse", `${candidate.tag}^{commit}`]),
    Promise.all(candidate.packages.map((artifact) => publishedRecord(artifact, candidate))),
  ]);
  return verifyPublishedExperimentalRelease({
    candidate,
    published,
    expectedCommit: commitOutput.trim(),
  });
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const result = await main();
    process.stdout.write(
      process.argv.includes("--json")
        ? `${JSON.stringify(result)}\n`
        : `Verified ${result.packages.length} Phase 1 ${result.phase ?? "published"} artifacts.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
