import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED_PACKAGES = [
  "@launchrally/claude-plugin",
  "@launchrally/cli",
  "@launchrally/codex-plugin",
  "@launchrally/contracts",
  "@launchrally/core",
];
const REQUIRED_SCENARIOS = [
  "denied_write",
  "missing_executor",
  "partial_receipt",
  "stale_architecture",
];
const CLEAN_HOST_FIELDS = [
  "manual_secret_transfer",
  "sensitive_persistence",
  "unauthorized_install",
  "unauthorized_login",
  "unauthorized_upload",
  "unauthorized_write",
];
const HOSTS = ["cli", "codex", "claude"];
const HOST_ADAPTERS = {
  cli: "@launchrally/cli",
  codex: "@launchrally/codex-plugin",
  claude: "@launchrally/claude-plugin",
};
const ENVELOPE_SCHEMA = "launchrally.dev/p1-external-host-result/v1";
const EVIDENCE_SCHEMA = "launchrally.dev/p1-external-verification/v1";
const PUBLICATION_JOBS = ["prerelease", "public-smoke", "publish"];

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function exactKeys(value, expected) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function validUrl(value, expectedPath) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "github.com"
      && url.port === ""
      && url.username === ""
      && url.password === ""
      && url.pathname === expectedPath
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}

function packageUrl(name, version) {
  return `https://www.npmjs.com/package/${name}/v/${version}`;
}

function assertPublicResult(host, result, version) {
  const p1 = result?.p1_exact_artifacts;
  const clean = p1?.clean_host;
  const expectedPackages = EXPECTED_PACKAGES.map((name) => `${name}@${version}`).sort();
  if (
    result?.status !== "completed"
    || result.source !== "public_registry"
    || result.version !== version
    || JSON.stringify([...(result.exact_packages ?? [])].sort())
      !== JSON.stringify(expectedPackages)
    || result.cli_smoke?.cli_version !== version
    || result.installation_journeys?.full_journey !== "plan_handoff_verify_completed"
    || !p1?.product_journeys?.includes("astro-hosted-web")
    || REQUIRED_SCENARIOS.some((scenario) => !p1?.scenarios?.includes(scenario))
    || p1?.fresh_verify?.receipt_claims !== "verification_required"
    || p1?.fresh_verify?.successful_downstream !== "environment_bound_machine_evidence"
    || p1?.fresh_verify?.unsuccessful_downstream !== "environment_bound_no_go"
    || JSON.stringify(Object.keys(clean ?? {}).sort()) !== JSON.stringify(CLEAN_HOST_FIELDS)
    || CLEAN_HOST_FIELDS.some((field) => clean[field] !== false)
    || (host !== "cli"
      && p1?.native_host_journeys?.[host]?.agent_execution
        !== "p1_external_verification_required")
  ) fail("p1_external_result_invalid", host);
}

function envelopePayload(envelope) {
  const { signature, ...payload } = envelope;
  return payload;
}

function attestationPayload(attestation) {
  const { signature, ...payload } = attestation;
  return payload;
}

function assertHostAttestation(attestation, version) {
  if (
    !exactKeys(attestation, [
      "adapter_package",
      "agent_execution",
      "challenge_digest",
      "host",
      "public_key",
      "public_result_digest",
      "recorded_at",
      "signature",
      "version",
    ])
    || !HOSTS.includes(attestation.host)
    || attestation.version !== version
    || attestation.adapter_package !== `${HOST_ADAPTERS[attestation.host]}@${version}`
    || attestation.agent_execution !== "challenge_response_captured"
    || !/^sha256:[a-f0-9]{64}$/u.test(attestation.challenge_digest ?? "")
    || !/^sha256:[a-f0-9]{64}$/u.test(attestation.public_result_digest ?? "")
    || !Number.isFinite(Date.parse(attestation.recorded_at ?? ""))
  ) fail("p1_external_evidence_invalid", attestation?.host ?? "host");
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(attestation.public_key, "base64"),
      format: "der",
      type: "spki",
    });
  } catch {
    fail("p1_external_evidence_invalid", attestation.host);
  }
  if (!verify(
    null,
    Buffer.from(JSON.stringify(attestationPayload(attestation))),
    publicKey,
    Buffer.from(attestation.signature, "base64"),
  )) fail("p1_external_evidence_invalid", attestation.host);
}

export function createExternalHostEnvelope({
  host,
  challenge,
  result,
  version,
  recordedAt = new Date().toISOString(),
}) {
  if (!HOSTS.includes(host) || !/^[a-f0-9]{64}$/u.test(challenge ?? "")) {
    fail("p1_external_result_invalid", host ?? "host");
  }
  assertPublicResult(host, result, version);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyValue = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const attestationPayloadValue = {
    host,
    version,
    adapter_package: `${HOST_ADAPTERS[host]}@${version}`,
    agent_execution: "challenge_response_captured",
    recorded_at: recordedAt,
    challenge_digest: digest(challenge),
    public_result_digest: digest(result),
    public_key: publicKeyValue,
  };
  const hostAttestation = {
    ...attestationPayloadValue,
    signature: sign(
      null,
      Buffer.from(JSON.stringify(attestationPayloadValue)),
      privateKey,
    ).toString("base64"),
  };
  const payload = {
    schema_version: ENVELOPE_SCHEMA,
    host,
    version,
    adapter_package: `${HOST_ADAPTERS[host]}@${version}`,
    challenge,
    recorded_at: recordedAt,
    agent_execution: "challenge_response_captured",
    unresolved_runner_state: host === "cli"
      ? "not_applicable"
      : "p1_external_verification_required",
    public_result_digest: digest(result),
    public_result: result,
    public_key: publicKeyValue,
    host_attestation: hostAttestation,
  };
  return {
    ...payload,
    signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString("base64"),
  };
}

function assertHostEnvelope(expectedHost, envelope, version) {
  if (
    !exactKeys(envelope, [
      "adapter_package",
      "agent_execution",
      "challenge",
      "host",
      "host_attestation",
      "public_key",
      "public_result",
      "public_result_digest",
      "recorded_at",
      "schema_version",
      "signature",
      "unresolved_runner_state",
      "version",
    ])
    || envelope.schema_version !== ENVELOPE_SCHEMA
    || envelope.host !== expectedHost
    || envelope.version !== version
    || envelope.adapter_package !== `${HOST_ADAPTERS[expectedHost]}@${version}`
    || !/^[a-f0-9]{64}$/u.test(envelope.challenge ?? "")
    || !Number.isFinite(Date.parse(envelope.recorded_at ?? ""))
    || envelope.agent_execution !== "challenge_response_captured"
    || envelope.unresolved_runner_state !== (expectedHost === "cli"
      ? "not_applicable"
      : "p1_external_verification_required")
    || envelope.public_result_digest !== digest(envelope.public_result)
  ) fail("p1_external_result_invalid", expectedHost);
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(envelope.public_key, "base64"),
      format: "der",
      type: "spki",
    });
  } catch {
    fail("p1_external_result_invalid", expectedHost);
  }
  if (!verify(
    null,
    Buffer.from(JSON.stringify(envelopePayload(envelope))),
    publicKey,
    Buffer.from(envelope.signature, "base64"),
  )) fail("p1_external_result_invalid", expectedHost);
  assertHostAttestation(envelope.host_attestation, version);
  if (
    envelope.host_attestation.host !== expectedHost
    || envelope.host_attestation.public_key !== envelope.public_key
    || envelope.host_attestation.public_result_digest !== envelope.public_result_digest
    || envelope.host_attestation.challenge_digest !== digest(envelope.challenge)
  ) fail("p1_external_result_invalid", expectedHost);
  assertPublicResult(expectedHost, envelope.public_result, version);
  return {
    ...envelope.host_attestation,
    envelope_digest: digest(envelope),
  };
}

function evidencePayload(record) {
  const { verification_digest: verificationDigest, ...payload } = record;
  return payload;
}

function expectedPackageRecords(candidate, version) {
  const packages = [...(candidate?.packages ?? [])]
    .sort((left, right) => left.name.localeCompare(right.name));
  if (
    candidate?.version !== version
    || candidate.tag !== `v${version}`
    || candidate.channel !== "experimental"
    || JSON.stringify(packages.map(({ name }) => name))
      !== JSON.stringify([...EXPECTED_PACKAGES].sort())
    || packages.some(({ integrity, shasum }) => (
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity ?? "")
      || !/^[a-f0-9]{40}$/u.test(shasum ?? "")
    ))
  ) fail("p1_external_evidence_invalid", "candidate packages");
  return packages.map(({ name, integrity, shasum }) => ({
    name,
    version,
    url: packageUrl(name, version),
    integrity,
    shasum,
    provenance: "slsa_v1_verified",
  }));
}

export function externalReviewBody({ version, hosts }) {
  return [
    "LaunchRally P1 External Verification v1",
    `version: ${version}`,
    ...HOSTS.map((host) => `${host}: ${hosts.find((entry) => entry.host === host)?.envelope_digest}`),
    "observation: independently_observed_native_invocations",
  ].join("\n");
}

export function createExternalReviewTemplate({ version, results }) {
  return externalReviewBody({ version, hosts: capturedHostResults(version, results) });
}

function assertIndependentReview(review, version, hosts) {
  if (
    !exactKeys(review, ["body", "created_at", "release_actor", "reviewer", "url"])
    || !/^https:\/\/github\.com\/codeacme17\/launchrally\/issues\/141#issuecomment-[0-9]+$/u
      .test(review.url ?? "")
    || !/^[A-Za-z0-9-]+$/u.test(review.reviewer ?? "")
    || !/^[A-Za-z0-9-]+$/u.test(review.release_actor ?? "")
    || review.reviewer.toLowerCase() === review.release_actor.toLowerCase()
    || !Number.isFinite(Date.parse(review.created_at ?? ""))
    || review.body.trim() !== externalReviewBody({ version, hosts })
    || hosts.some(({ recorded_at: recordedAt }) => (
      Date.parse(review.created_at) < Date.parse(recordedAt)
    ))
  ) fail("p1_external_independent_review_invalid", review?.url ?? "missing");
}

function assertPublishedWorkflow(workflow, version) {
  if (
    !exactKeys(workflow, [
      "actor",
      "conclusion",
      "event",
      "head_branch",
      "head_sha",
      "path",
      "url",
    ])
    || !/^https:\/\/github\.com\/codeacme17\/launchrally\/actions\/runs\/[0-9]+$/u
      .test(workflow.url ?? "")
    || workflow.conclusion !== "success"
    || workflow.event !== "push"
    || workflow.head_branch !== `v${version}`
    || !/^[a-f0-9]{40}$/u.test(workflow.head_sha ?? "")
    || workflow.path !== ".github/workflows/release.yml"
    || !/^[A-Za-z0-9-]+$/u.test(workflow.actor ?? "")
  ) fail("p1_external_workflow_invalid", workflow?.url ?? "missing");
}

async function defaultGitHubApi(endpoint) {
  const { stdout } = await execFileAsync("gh", ["api", endpoint]);
  return JSON.parse(stdout);
}

function commentFromApi(comment, reviewUrl) {
  if (
    comment?.issue_url !== "https://api.github.com/repos/codeacme17/launchrally/issues/141"
    || comment.html_url !== reviewUrl
  ) fail("p1_external_independent_review_invalid", reviewUrl);
  return {
    url: reviewUrl,
    reviewer: comment.user?.login,
    created_at: comment.created_at,
    body: comment.body,
  };
}

function workflowFromApi(workflow, workflowUrl) {
  const normalized = {
    url: workflowUrl,
    actor: workflow?.actor?.login,
    conclusion: workflow?.conclusion,
    event: workflow?.event,
    head_branch: workflow?.head_branch,
    head_sha: workflow?.head_sha,
    path: workflow?.path,
  };
  if (workflow?.html_url !== workflowUrl || workflow?.status !== "completed") {
    fail("p1_external_workflow_invalid", workflowUrl);
  }
  return normalized;
}

function assertPublicationJobs(response) {
  const jobs = [...(response?.jobs ?? [])]
    .filter(({ name }) => PUBLICATION_JOBS.includes(name))
    .map(({ conclusion, name, status }) => ({ conclusion, name, status }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (
    JSON.stringify(jobs.map(({ name }) => name)) !== JSON.stringify(PUBLICATION_JOBS)
    || jobs.some(({ conclusion, status }) => status !== "completed" || conclusion !== "success")
  ) fail("p1_external_workflow_jobs_invalid", "publication jobs");
  return jobs;
}

async function dereferenceTag(githubApi, version) {
  let object = (await githubApi(
    `repos/codeacme17/launchrally/git/ref/tags/v${version}`,
  ))?.object;
  for (let depth = 0; depth < 4 && object?.type === "tag"; depth += 1) {
    object = (await githubApi(
      `repos/codeacme17/launchrally/git/tags/${object.sha}`,
    ))?.object;
  }
  if (object?.type !== "commit" || !/^[a-f0-9]{40}$/u.test(object.sha ?? "")) {
    fail("p1_external_tag_invalid", `v${version}`);
  }
  return object.sha;
}

async function verifyPublicationAuthority({
  candidate,
  githubApi,
  version,
  workflowId,
  workflow,
}) {
  const [jobsResponse, candidateResponse, tagCommit] = await Promise.all([
    githubApi(`repos/codeacme17/launchrally/actions/runs/${workflowId}/jobs?per_page=100`),
    githubApi(
      `repos/codeacme17/launchrally/contents/release/p1-release-candidate.json?ref=${workflow.head_sha}`,
    ),
    dereferenceTag(githubApi, version),
  ]);
  let candidateAtCommit;
  try {
    if (candidateResponse?.encoding !== "base64") throw new Error("invalid encoding");
    candidateAtCommit = JSON.parse(Buffer.from(candidateResponse.content, "base64").toString("utf8"));
  } catch {
    fail("p1_external_candidate_commit_invalid", workflow.head_sha);
  }
  if (
    tagCommit !== workflow.head_sha
    || JSON.stringify(candidateAtCommit) !== JSON.stringify(candidate)
  ) fail("p1_external_candidate_commit_invalid", workflow.head_sha);
  return assertPublicationJobs(jobsResponse);
}

export function verifyExternalEvidenceRecord(record, { candidate = null } = {}) {
  if (
    !exactKeys(record, [
      "channel",
      "hosts",
      "packages",
      "publication_jobs",
      "release_url",
      "release_actor",
      "release_commit",
      "review_body",
      "review_url",
      "reviewed_at",
      "reviewer",
      "schema_version",
      "status",
      "tag",
      "verification_digest",
      "verified_at",
      "version",
      "workflow_url",
    ])
    || record?.schema_version !== EVIDENCE_SCHEMA
    || !/^\d+\.\d+\.\d+$/u.test(record.version ?? "")
    || record.tag !== `v${record.version}`
    || record.channel !== "experimental"
    || !["pending", "completed"].includes(record.status)
  ) fail("p1_external_evidence_invalid", "identity");
  if (record.status === "pending") {
    if (
      record.verified_at !== null
      || record.workflow_url !== null
      || record.release_url !== null
      || record.release_actor !== null
      || record.release_commit !== null
      || record.review_body !== null
      || record.review_url !== null
      || record.reviewed_at !== null
      || record.reviewer !== null
      || JSON.stringify(record.hosts) !== "[]"
      || JSON.stringify(record.packages) !== "[]"
      || JSON.stringify(record.publication_jobs) !== "[]"
      || record.verification_digest !== null
    ) fail("p1_external_evidence_invalid", "pending state");
    return { status: "pending", version: record.version };
  }
  if (
    !Number.isFinite(Date.parse(record.verified_at ?? ""))
    || !/^https:\/\/github\.com\/codeacme17\/launchrally\/actions\/runs\/[0-9]+$/u
      .test(record.workflow_url ?? "")
    || !validUrl(record.release_url, `/codeacme17/launchrally/releases/tag/${record.tag}`)
    || !/^https:\/\/github\.com\/codeacme17\/launchrally\/issues\/141#issuecomment-[0-9]+$/u
      .test(record.review_url ?? "")
    || !/^[A-Za-z0-9-]+$/u.test(record.reviewer ?? "")
    || !/^[A-Za-z0-9-]+$/u.test(record.release_actor ?? "")
    || !/^[a-f0-9]{40}$/u.test(record.release_commit ?? "")
    || record.reviewer.toLowerCase() === record.release_actor.toLowerCase()
    || !Number.isFinite(Date.parse(record.reviewed_at ?? ""))
    || record.review_body !== externalReviewBody({ version: record.version, hosts: record.hosts })
    || JSON.stringify(record.hosts?.map(({ host }) => host)) !== JSON.stringify(HOSTS)
    || new Set(record.hosts?.map(({ challenge_digest: challenge }) => challenge)).size
      !== HOSTS.length
    || new Set(record.hosts?.map(({ envelope_digest: envelope }) => envelope)).size
      !== HOSTS.length
    || record.hosts.some(({ recorded_at: recordedAt }) => (
      Date.parse(record.reviewed_at) < Date.parse(recordedAt)
    ))
    || Date.parse(record.verified_at) < Date.parse(record.reviewed_at)
    || record.hosts.some((host) => (
      !exactKeys(host, [
        "adapter_package",
        "agent_execution",
        "challenge_digest",
        "envelope_digest",
        "host",
        "independent_observation",
        "public_key",
        "public_result_digest",
        "recorded_at",
        "signature",
        "version",
      ])
      || !HOSTS.includes(host.host)
      || host.version !== record.version
      || host.adapter_package !== `${HOST_ADAPTERS[host.host]}@${record.version}`
      || host.agent_execution !== "challenge_response_captured"
      || host.independent_observation !== "verified"
      || !/^sha256:[a-f0-9]{64}$/u.test(host.challenge_digest ?? "")
      || !/^sha256:[a-f0-9]{64}$/u.test(host.envelope_digest ?? "")
      || !/^sha256:[a-f0-9]{64}$/u.test(host.public_result_digest ?? "")
      || !Number.isFinite(Date.parse(host.recorded_at ?? ""))
    ))
    || !Array.isArray(record.packages)
    || JSON.stringify(record.publication_jobs) !== JSON.stringify(PUBLICATION_JOBS.map((name) => ({
      conclusion: "success",
      name,
      status: "completed",
    })))
    || candidate === null
    || JSON.stringify(record.packages)
      !== JSON.stringify(expectedPackageRecords(candidate, record.version))
    || record.verification_digest !== digest(evidencePayload(record))
  ) fail("p1_external_evidence_invalid", "completed state");
  for (const host of record.hosts) {
    const {
      envelope_digest: envelopeDigest,
      independent_observation: independentObservation,
      ...attestation
    } = host;
    assertHostAttestation(attestation, record.version);
  }
  return { status: "completed", version: record.version, hosts: HOSTS };
}

export async function verifyExternalEvidenceWithGitHub(record, {
  candidate,
  githubApi = defaultGitHubApi,
} = {}) {
  const verified = verifyExternalEvidenceRecord(record, { candidate });
  if (verified.status !== "completed") return verified;
  const commentId = record.review_url.match(/#issuecomment-([0-9]+)$/u)?.[1];
  const workflowId = record.workflow_url.match(/\/actions\/runs\/([0-9]+)$/u)?.[1];
  const [commentResponse, workflowResponse] = await Promise.all([
    githubApi(`repos/codeacme17/launchrally/issues/comments/${commentId}`),
    githubApi(`repos/codeacme17/launchrally/actions/runs/${workflowId}`),
  ]);
  const workflow = workflowFromApi(workflowResponse, record.workflow_url);
  assertPublishedWorkflow(workflow, record.version);
  const publicationJobs = await verifyPublicationAuthority({
    candidate,
    githubApi,
    version: record.version,
    workflowId,
    workflow,
  });
  const review = {
    ...commentFromApi(commentResponse, record.review_url),
    release_actor: workflow.actor,
  };
  assertIndependentReview(review, record.version, record.hosts);
  if (
    review.reviewer !== record.reviewer
    || review.release_actor !== record.release_actor
    || review.created_at !== record.reviewed_at
    || review.body.trim() !== record.review_body
    || workflow.head_sha !== record.release_commit
    || JSON.stringify(publicationJobs) !== JSON.stringify(record.publication_jobs)
  ) fail("p1_external_public_evidence_drift", record.review_url);
  return verified;
}

export function verifyExternalPhase1Results({
  version,
  results,
  workflow,
  releaseUrl,
  candidate,
  publicationJobs,
  review,
  verifiedAt = new Date().toISOString(),
}) {
  if (!/^\d+\.\d+\.\d+$/u.test(version ?? "")) {
    fail("p1_external_result_invalid", "version");
  }
  if (Object.keys(results ?? {}).sort().join(",") !== [...HOSTS].sort().join(",")) {
    fail("p1_external_result_invalid", "host roster");
  }
  const capturedHosts = capturedHostResults(version, results);
  assertPublishedWorkflow(workflow, version);
  assertIndependentReview(review, version, capturedHosts);
  if (review.release_actor !== workflow.actor) {
    fail("p1_external_independent_review_invalid", review.url);
  }
  const hosts = capturedHosts.map((host) => ({
    ...host,
    independent_observation: "verified",
  }));
  const payload = {
    schema_version: EVIDENCE_SCHEMA,
    status: "completed",
    version,
    tag: `v${version}`,
    channel: "experimental",
    verified_at: verifiedAt,
    workflow_url: workflow.url,
    release_url: releaseUrl,
    review_url: review.url,
    review_body: review.body.trim(),
    reviewer: review.reviewer,
    release_actor: review.release_actor,
    release_commit: workflow.head_sha,
    reviewed_at: review.created_at,
    packages: expectedPackageRecords(candidate, version),
    publication_jobs: publicationJobs,
    hosts,
  };
  const record = { ...payload, verification_digest: digest(payload) };
  verifyExternalEvidenceRecord(record, { candidate });
  return record;
}

function capturedHostResults(version, results) {
  if (Object.keys(results ?? {}).sort().join(",") !== [...HOSTS].sort().join(",")) {
    fail("p1_external_result_invalid", "host roster");
  }
  const challenges = new Set();
  return HOSTS.map((host) => {
    const summary = assertHostEnvelope(host, results[host], version);
    if (challenges.has(results[host].challenge)) {
      fail("p1_external_result_invalid", "challenge reuse");
    }
    challenges.add(results[host].challenge);
    return summary;
  });
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

async function main() {
  const evidencePath = option("--evidence");
  if (evidencePath !== null) {
    const [record, candidate] = await Promise.all([
      readFile(path.resolve(evidencePath), "utf8").then(JSON.parse),
      readFile(path.join(scriptRoot, "release/p1-release-candidate.json"), "utf8")
        .then(JSON.parse),
    ]);
    const verified = verifyExternalEvidenceRecord(record, { candidate });
    if (process.argv.includes("--require-complete") && verified.status !== "completed") {
      fail("p1_external_verification_pending", record.status);
    }
    return verified.status === "completed"
      ? verifyExternalEvidenceWithGitHub(record, { candidate })
      : verified;
  }
  const version = option("--version");
  const results = {};
  for (const host of HOSTS) {
    const resultPath = option(`--${host}`);
    if (resultPath === null) fail("p1_external_result_invalid", `${host} result missing`);
    results[host] = JSON.parse(await readFile(path.resolve(resultPath), "utf8"));
  }
  const capturedHosts = capturedHostResults(version, results);
  if (process.argv.includes("--review-template")) {
    return { review_template: createExternalReviewTemplate({ version, results }) };
  }
  const reviewUrl = option("--review-url");
  const workflowUrl = option("--workflow-url");
  const commentId = reviewUrl?.match(
    /^https:\/\/github\.com\/codeacme17\/launchrally\/issues\/141#issuecomment-([0-9]+)$/u,
  )?.[1];
  const workflowId = workflowUrl?.match(
    /^https:\/\/github\.com\/codeacme17\/launchrally\/actions\/runs\/([0-9]+)$/u,
  )?.[1];
  if (commentId === undefined || workflowId === undefined) {
    fail("p1_external_independent_review_invalid", reviewUrl ?? "missing");
  }
  const [commentResponse, workflowResponse, candidate] = await Promise.all([
    defaultGitHubApi(`repos/codeacme17/launchrally/issues/comments/${commentId}`),
    defaultGitHubApi(`repos/codeacme17/launchrally/actions/runs/${workflowId}`),
    readFile(path.join(scriptRoot, "release/p1-release-candidate.json"), "utf8")
      .then(JSON.parse),
  ]);
  const workflow = workflowFromApi(workflowResponse, workflowUrl);
  assertPublishedWorkflow(workflow, version);
  const publicationJobs = await verifyPublicationAuthority({
    candidate,
    githubApi: defaultGitHubApi,
    version,
    workflowId,
    workflow,
  });
  const comment = commentFromApi(commentResponse, reviewUrl);
  const record = verifyExternalPhase1Results({
    version,
    results,
    workflow,
    releaseUrl: option("--release-url"),
    candidate,
    publicationJobs,
    review: {
      url: reviewUrl,
      reviewer: comment.reviewer,
      release_actor: workflow.actor,
      created_at: comment.created_at,
      body: comment.body,
    },
  });
  const output = option("--output");
  if (output !== null) {
    await writeFile(path.resolve(output), `${JSON.stringify(record, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  }
  return record;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const result = await main();
    process.stdout.write(
      result.review_template !== undefined
        ? `${result.review_template}\n`
        : process.argv.includes("--json")
        ? `${JSON.stringify(result)}\n`
        : `External Phase 1 verification is ${result.status}.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
