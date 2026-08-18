import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { assertValidReportPackage } from "@launchrally/contracts";

import { acquireOwnedLock, ensureOwnedLockDirectory } from "./exclusive-lock.js";
import { renderReportMarkdown } from "./reporting.js";
import { isSafeEvidenceArtifact } from "./evidence-artifact.js";

const REPORT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DIGEST = /^sha256:([a-f0-9]{64})$/u;
const REPORT_RECORD_PATH = /^\.launchrally\/reports\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/record\.json$/u;

export function canonicalJson(value) {
  function canonical(candidate) {
    if (Array.isArray(candidate)) return candidate.map(canonical);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(Object.keys(candidate).sort().map((key) => [
        key,
        canonical(candidate[key]),
      ]));
    }
    return candidate;
  }
  return JSON.stringify(canonical(value));
}

export function sha256(value) {
  const content = typeof value === "string" || Buffer.isBuffer(value)
    ? value
    : canonicalJson(value);
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function reportDirectory(reportId) {
  if (!REPORT_ID.test(reportId)) {
    const error = new Error("The Report ID cannot be represented as a safe local history path.");
    error.code = "unsafe_report_id";
    throw error;
  }
  return `.launchrally/reports/${reportId}`;
}

function evidencePath(digest) {
  const match = digest.match(DIGEST);
  if (!match) {
    const error = new Error("The Evidence address is not a SHA-256 digest.");
    error.code = "invalid_evidence_address";
    throw error;
  }
  return `.launchrally/evidence/sha256/${match[1]}.json`;
}

function referencedEvidenceDigests(report) {
  return [
    ...report.results.public_evidence_refs,
    ...(report.results.authenticated_journey_evidence_refs ?? []),
    ...report.results.provider_evidence_refs,
    ...report.results.checks.flatMap((check) => [
      ...check.applicability.evidence,
      ...check.evidence,
    ]),
  ].map(({ digest }) => digest);
}

function assertPersistableReportPackage(reportPackage) {
  assertValidReportPackage({
    status: "completed",
    operation: "audit",
    ...reportPackage,
  });
  const { report, report_view: reportView, evidence_index: evidenceIndex } = reportPackage;
  if (
    reportView.report_id !== report.report_id
    || reportView.report_schema_version !== report.schema_version
    || reportView.generated_at !== report.created_at
    || reportView.format !== "markdown"
    || reportView.content !== renderReportMarkdown(report)
  ) {
    const error = new Error("The Report View is not derived from the canonical Record.");
    error.code = "invalid_report_view";
    throw error;
  }
  const referenced = referencedEvidenceDigests(report);
  const indexed = evidenceIndex.entries.map(({ digest }) => digest);
  if (
    new Set(referenced).size !== new Set(indexed).size
    || new Set(indexed).size !== indexed.length
    || referenced.some((digest) => !indexed.includes(digest))
    || indexed.some((digest) => !referenced.includes(digest))
    || evidenceIndex.entries.some((entry) =>
      entry.normalized_artifact?.kind !== entry.evidence_kind)
  ) {
    const error = new Error("The Evidence Index contains unreferenced or inconsistent artifacts.");
    error.code = "invalid_evidence_index";
    throw error;
  }
  if (evidenceIndex.entries.some((entry) => !isSafeEvidenceArtifact(entry.normalized_artifact))) {
    const error = new Error("The Evidence Index contains a non-allowlisted artifact.");
    error.code = "unsafe_evidence_artifact";
    throw error;
  }
}

export function createHistoryFiles(reportPackage, options = {}) {
  assertPersistableReportPackage(reportPackage);
  const { report, report_view: reportView, evidence_index: evidenceIndex } = reportPackage;
  const directory = reportDirectory(report.report_id);
  const recordContent = `${canonicalJson(report)}\n`;
  const recordDigest = sha256(recordContent);
  const files = [
    { path: `${directory}/record.json`, content: recordContent },
    { path: `${directory}/record.sha256`, content: `${recordDigest}\n` },
    { path: `${directory}/view.md`, content: reportView.content },
    { path: `${directory}/evidence-index.json`, content: `${canonicalJson(evidenceIndex)}\n` },
  ];
  if (options.include_cache !== false) {
    files.push({
      path: ".launchrally/cache/current-report.json",
      content: `${canonicalJson({
        schema_version: "launchrally.dev/local-history-pointer/v1",
        report_id: report.report_id,
        record_digest: recordDigest,
      })}\n`,
    });
  }
  for (const entry of evidenceIndex.entries) {
    const artifactContent = canonicalJson(entry.normalized_artifact);
    if (sha256(entry.normalized_artifact) !== entry.digest) {
      const error = new Error(`Evidence ${entry.digest} does not match its normalized artifact.`);
      error.code = "evidence_digest_mismatch";
      throw error;
    }
    files.push({ path: evidencePath(entry.digest), content: artifactContent });
  }
  return { files, record_digest: recordDigest };
}

export function isLocalHistoryPath(relativePath) {
  return /^\.launchrally\/(?:reports\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/(?:record\.json|record\.sha256|view\.md|evidence-index\.json)|evidence\/sha256\/[a-f0-9]{64}\.json|cache\/current-report\.json)$/u
    .test(relativePath);
}

export function isImmutableHistoryPath(relativePath) {
  return /^\.launchrally\/(?:reports\/|evidence\/sha256\/)/u.test(relativePath);
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertRepositoryRoot(root) {
  const resolved = path.resolve(root);
  const selected = await lstat(resolved);
  if (!selected.isDirectory() || selected.isSymbolicLink()) {
    const error = new Error("Local history requires the explicit canonical repository root.");
    error.code = "repository_scope_mismatch";
    throw error;
  }
  return realpath(resolved);
}

function repositoryRelativePath(root, selectedPath) {
  if (typeof selectedPath !== "string" || selectedPath.length === 0) return null;
  const candidate = path.isAbsolute(selectedPath)
    ? path.resolve(selectedPath)
    : path.resolve(root, selectedPath);
  const relative = path.relative(path.resolve(root), candidate);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join("/");
}

export function isLocalHistoryReference(root, selectedPath) {
  const relativePath = repositoryRelativePath(root, selectedPath);
  return REPORT_RECORD_PATH.test(relativePath ?? "")
    || relativePath === ".launchrally/cache/current-report.json";
}

async function assertNoSymlink(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        const error = new Error(`Local history refuses symlinked path: ${relativePath}`);
        error.code = "unsafe_history_path";
        throw error;
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function operations(overrides = {}) {
  return {
    mkdir,
    write_file: (target, content, options) => writeFile(target, content, options),
    link,
    rename,
    remove: (target, options) => rm(target, options),
    ...overrides,
  };
}

async function writeImmutable(target, content, ops, temporary) {
  const existing = await readOptional(target);
  if (existing !== null) {
    if (existing === content) return { state: "existing" };
    const error = new Error(`Immutable local history collision at ${target}.`);
    error.code = "history_collision";
    throw error;
  }
  await ops.mkdir(path.dirname(target), { recursive: true });
  try {
    await ops.mkdir(path.dirname(temporary), { recursive: true });
    await ops.write_file(temporary, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await ops.link(temporary, target);
    const created = await lstat(target);
    return { state: "created", dev: created.dev, ino: created.ino };
  } catch (error) {
    let linkedByThisWrite = null;
    try {
      const [temporaryStat, targetStat] = await Promise.all([lstat(temporary), lstat(target)]);
      if (temporaryStat.dev === targetStat.dev && temporaryStat.ino === targetStat.ino) {
        linkedByThisWrite = { state: "created", dev: targetStat.dev, ino: targetStat.ino };
      }
    } catch {
      // The temporary file or destination was not present.
    }
    if (linkedByThisWrite && await readOptional(target) === content) return linkedByThisWrite;
    if (await readOptional(target) === content) return { state: "existing" };
    throw error;
  }
}

function reportFiles(reportId, files) {
  return files.filter(({ path: relative }) =>
    relative.startsWith(`${reportDirectory(reportId)}/`));
}

async function reportBundleState(repositoryRoot, reportId, files) {
  await assertNoSymlink(repositoryRoot, reportDirectory(reportId));
  const directory = path.join(repositoryRoot, reportDirectory(reportId));
  let children;
  try {
    children = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
  const expected = reportFiles(reportId, files).map(({ path: relative }) =>
    path.basename(relative)).sort();
  const actual = children.map(({ name }) => name).sort();
  if (
    children.some((entry) => !entry.isFile() || entry.isSymbolicLink())
    || JSON.stringify(actual) !== JSON.stringify(expected)
  ) return "different";
  for (const file of reportFiles(reportId, files)) {
    if (await readOptional(path.join(repositoryRoot, file.path)) !== file.content) {
      return "different";
    }
  }
  return "identical";
}

async function committedLocalHistoryState(repositoryRoot, reportId, expectedDigest) {
  const relativeDirectory = reportDirectory(reportId);
  await assertNoSymlink(repositoryRoot, relativeDirectory);
  const directory = path.join(repositoryRoot, relativeDirectory);
  let children;
  try {
    children = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
  const expectedChildren = ["evidence-index.json", "record.json", "record.sha256", "view.md"];
  if (
    children.some((child) => !child.isFile() || child.isSymbolicLink())
    || JSON.stringify(children.map(({ name }) => name).sort()) !== JSON.stringify(expectedChildren)
  ) return "invalid";
  let recordContent;
  let sidecar;
  let viewContent;
  let evidenceIndex;
  try {
    recordContent = await readFile(path.join(directory, "record.json"), "utf8");
    sidecar = await readFile(path.join(directory, "record.sha256"), "utf8");
    viewContent = await readFile(path.join(directory, "view.md"), "utf8");
    evidenceIndex = JSON.parse(
      await readFile(path.join(directory, "evidence-index.json"), "utf8"),
    );
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return "invalid";
    throw error;
  }
  if (
    sha256(recordContent) !== expectedDigest
    || sidecar !== `${expectedDigest}\n`
  ) return "invalid";

  let files;
  try {
    const report = JSON.parse(recordContent);
    const derived = createHistoryFiles({
      report,
      report_view: {
        schema_version: "launchrally.dev/report-view/v2",
        report_id: report.report_id,
        report_schema_version: report.schema_version,
        generated_at: report.created_at,
        format: "markdown",
        content: viewContent,
      },
      evidence_index: evidenceIndex,
    }, { include_cache: false });
    if (derived.record_digest !== expectedDigest) return "invalid";
    files = derived.files;
  } catch {
    return "invalid";
  }
  if (await reportBundleState(repositoryRoot, reportId, files) !== "identical") return "invalid";
  for (const file of files.filter(({ path: relative }) => relative.includes("/evidence/"))) {
    await assertNoSymlink(repositoryRoot, file.path);
    const target = path.join(repositoryRoot, file.path);
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || await readFile(target, "utf8") !== file.content) {
        return "invalid";
      }
    } catch (error) {
      if (error?.code === "ENOENT") return "invalid";
      throw error;
    }
  }
  return "valid";
}

export async function committedLocalHistoryStatus(root, reportId, expectedDigest) {
  const repositoryRoot = await assertRepositoryRoot(root);
  return committedLocalHistoryState(repositoryRoot, reportId, expectedDigest);
}

export async function loadLocalHistoryReportPackage(root, selectedPath) {
  const repositoryRoot = await assertRepositoryRoot(root);
  const relativePath = repositoryRelativePath(repositoryRoot, selectedPath);
  const match = relativePath?.match(REPORT_RECORD_PATH);
  if (!match) {
    const error = new Error(
      "Plan local history input must be a repository-bounded .launchrally/reports/<report-id>/record.json path.",
    );
    error.code = "invalid_local_history_report_path";
    throw error;
  }
  const reportId = match[1];
  const relativeDirectory = reportDirectory(reportId);
  await Promise.all([
    "record.json",
    "record.sha256",
    "view.md",
    "evidence-index.json",
  ].map((name) => assertNoSymlink(repositoryRoot, `${relativeDirectory}/${name}`)));
  const directory = path.join(repositoryRoot, relativeDirectory);
  let recordContent;
  let expectedDigest;
  let viewContent;
  let evidenceIndex;
  try {
    [recordContent, expectedDigest, viewContent, evidenceIndex] = await Promise.all([
      readFile(path.join(directory, "record.json"), "utf8"),
      readFile(path.join(directory, "record.sha256"), "utf8").then((value) => value.trim()),
      readFile(path.join(directory, "view.md"), "utf8"),
      readFile(path.join(directory, "evidence-index.json"), "utf8").then(JSON.parse),
    ]);
  } catch (error) {
    const invalid = new Error(
      "The immutable Report package is missing, incomplete, or unreadable; run full Verify again.",
    );
    invalid.code = "invalid_local_history_report";
    invalid.cause = error;
    throw invalid;
  }
  if (!DIGEST.test(expectedDigest) || sha256(recordContent) !== expectedDigest) {
    const error = new Error(
      "The immutable Report Record digest does not match; restore history or run full Verify again.",
    );
    error.code = "invalid_local_history_report";
    throw error;
  }
  let reportPackage;
  try {
    const report = JSON.parse(recordContent);
    if (report.report_id !== reportId) throw new Error("Report ID does not match its directory.");
    reportPackage = {
      report,
      report_view: {
        schema_version: "launchrally.dev/report-view/v2",
        report_id: report.report_id,
        report_schema_version: report.schema_version,
        generated_at: report.created_at,
        format: "markdown",
        content: viewContent,
      },
      evidence_index: evidenceIndex,
    };
    const derived = createHistoryFiles(reportPackage, { include_cache: false });
    if (derived.record_digest !== expectedDigest) throw new Error("Record digest changed.");
  } catch (error) {
    const invalid = new Error(
      "The immutable Report package is invalid or internally inconsistent; restore history or run full Verify again.",
    );
    invalid.code = "invalid_local_history_report";
    invalid.cause = error;
    throw invalid;
  }
  if (await committedLocalHistoryState(repositoryRoot, reportId, expectedDigest) !== "valid") {
    const error = new Error(
      "The immutable Report package or referenced Evidence is incomplete or tampered; restore history or run full Verify again.",
    );
    error.code = "invalid_local_history_report";
    throw error;
  }
  return {
    status: "completed",
    operation: "audit",
    ...reportPackage,
  };
}

async function evidenceIsReferenced(repositoryRoot, digest) {
  const reportsRoot = path.join(repositoryRoot, ".launchrally", "reports");
  let reports;
  try {
    reports = await readdir(reportsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  for (const report of reports) {
    if (!report.isDirectory() || report.isSymbolicLink() || !REPORT_ID.test(report.name)) {
      const error = new Error("Visible Report history has an invalid type.");
      error.code = "history_collision";
      throw error;
    }
    let recordDigest;
    try {
      recordDigest = (await readFile(
        path.join(reportsRoot, report.name, "record.sha256"),
        "utf8",
      )).trim();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const collision = new Error("Visible Report Evidence cannot be validated during recovery.");
      collision.code = "history_collision";
      throw collision;
    }
    if (
      !DIGEST.test(recordDigest)
      || await committedLocalHistoryState(repositoryRoot, report.name, recordDigest) !== "valid"
    ) {
      const collision = new Error("Visible Report history is semantically inconsistent.");
      collision.code = "history_collision";
      throw collision;
    }
    const index = JSON.parse(await readFile(
      path.join(reportsRoot, report.name, "evidence-index.json"),
      "utf8",
    ));
    if (index.entries.some((entry) => entry.digest === digest)) return true;
  }
  return false;
}

async function removeExactCreation(target, content, creation, ops) {
  if (creation.state !== "created") return;
  try {
    const current = await lstat(target);
    if (
      current.isFile()
      && !current.isSymbolicLink()
      && current.dev === creation.dev
      && current.ino === creation.ino
      && await readOptional(target) === content
    ) await ops.remove(target, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function recoverHistoryTransactions(repositoryRoot, ops) {
  const transactionsRoot = path.join(repositoryRoot, ".launchrally", "transactions");
  let pending = [];
  try {
    pending = await readdir(transactionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const entry of pending) {
    const match = entry.name.match(/^report-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/u);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) {
      const error = new Error("A local history transaction has an invalid name or type.");
      error.code = "invalid_history_transaction";
      throw error;
    }
    const transactionId = match[1];
    const transactionPath = path.join(transactionsRoot, entry.name);
    await assertNoSymlink(repositoryRoot, path.relative(repositoryRoot, transactionPath));
    let journal;
    try {
      journal = JSON.parse(await readFile(path.join(transactionPath, "transaction.json"), "utf8"));
    } catch {
      const error = new Error("A local history transaction is invalid and was preserved.");
      error.code = "invalid_history_transaction";
      throw error;
    }
    const children = await readdir(transactionPath, { withFileTypes: true });
    const childNames = children.map(({ name }) => name).sort();
    const bundleEntry = children.find(({ name }) => name === "bundle");
    if (
      journal?.schema_version !== "launchrally.dev/local-history-transaction/v1"
      || JSON.stringify(Object.keys(journal).sort()) !== JSON.stringify([
        "new_evidence",
        "owner_pid",
        "record_digest",
        "report_id",
        "schema_version",
        "state",
        "transaction_id",
      ])
      || journal.transaction_id !== transactionId
      || !REPORT_ID.test(journal.report_id)
      || journal.state !== "staging"
      || !Number.isInteger(journal.owner_pid)
      || journal.owner_pid < 1
      || !DIGEST.test(journal.record_digest)
      || !Array.isArray(journal.new_evidence)
      || journal.new_evidence.some((candidate) =>
        !candidate
        || typeof candidate !== "object"
        || JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(["digest", "path"])
        || !DIGEST.test(candidate.digest)
        || candidate.path !== evidencePath(candidate.digest))
      || new Set(journal.new_evidence.map(({ digest }) => digest)).size
        !== journal.new_evidence.length
      || children.some((child) => !["bundle", "evidence", "transaction.json"].includes(child.name))
      || children.some((child) => child.name === "transaction.json" && !child.isFile())
      || (bundleEntry && !bundleEntry.isDirectory())
    ) {
      const error = new Error("A local history transaction is invalid and was preserved.");
      error.code = "invalid_history_transaction";
      throw error;
    }
    if (bundleEntry) {
      const bundleChildren = await readdir(path.join(transactionPath, "bundle"), {
        withFileTypes: true,
      });
      const allowedBundle = new Set([
        "record.json",
        "record.sha256",
        "view.md",
        "evidence-index.json",
      ]);
      if (bundleChildren.some((child) =>
        !child.isFile() || child.isSymbolicLink() || !allowedBundle.has(child.name))) {
        const error = new Error("A staged Report bundle has an invalid shape and was preserved.");
        error.code = "invalid_history_transaction";
        throw error;
      }
    }
    const stagedEvidenceEntry = children.find(({ name }) => name === "evidence");
    if (stagedEvidenceEntry) {
      if (!stagedEvidenceEntry.isDirectory() || stagedEvidenceEntry.isSymbolicLink()) {
        const error = new Error("A staged Evidence directory has an invalid shape.");
        error.code = "invalid_history_transaction";
        throw error;
      }
      const stagedEvidence = await readdir(
        path.join(transactionPath, "evidence"),
        { withFileTypes: true },
      );
      const allowedEvidence = new Set(journal.new_evidence.map(({ digest }) =>
        `${digest.slice(7)}.json`));
      if (stagedEvidence.some((child) =>
        !child.isFile() || child.isSymbolicLink() || !allowedEvidence.has(child.name))) {
        const error = new Error("Staged Evidence has an invalid shape and was preserved.");
        error.code = "invalid_history_transaction";
        throw error;
      }
    }
    if (processIsAlive(journal.owner_pid)) {
      const error = new Error("Another writer has a live local-history transaction.");
      error.code = "history_transaction_busy";
      throw error;
    }
    const committedState = await committedLocalHistoryState(
      repositoryRoot,
      journal.report_id,
      journal.record_digest,
    );
    if (committedState === "invalid") {
      const error = new Error("Visible Report history is incomplete or tampered; recovery stopped.");
      error.code = "history_collision";
      throw error;
    }
    if (committedState === "missing") {
      for (const candidate of journal.new_evidence) {
        const target = path.join(repositoryRoot, candidate.path);
        const staged = path.join(transactionPath, "evidence", `${candidate.digest.slice(7)}.json`);
        let targetStat;
        let stagedStat;
        try {
          [targetStat, stagedStat] = await Promise.all([lstat(target), lstat(staged)]);
        } catch (error) {
          if (error?.code === "ENOENT" && await readOptional(target) === null) continue;
          const invalid = new Error("Evidence creation ownership cannot be proven.");
          invalid.code = "invalid_history_transaction";
          throw invalid;
        }
        if (
          targetStat.isSymbolicLink()
          || stagedStat.isSymbolicLink()
          || targetStat.dev !== stagedStat.dev
          || targetStat.ino !== stagedStat.ino
          || sha256(await readFile(target, "utf8")) !== candidate.digest
          || await evidenceIsReferenced(repositoryRoot, candidate.digest)
        ) {
          const invalid = new Error("Transaction Evidence is shared or not owned by this transaction.");
          invalid.code = "invalid_history_transaction";
          throw invalid;
        }
        await ops.remove(target, { force: true });
      }
    }
    await ops.remove(transactionPath, { recursive: true, force: true });
  }
}

async function persistLocalHistoryLocked(root, reportPackage, dependencies = {}) {
  const repositoryRoot = await assertRepositoryRoot(root);
  const ops = operations(dependencies.file_operations);
  const { files, record_digest: recordDigest } = createHistoryFiles(reportPackage, {
    include_cache: dependencies.include_cache !== false,
  });
  for (const file of files) await assertNoSymlink(repositoryRoot, file.path);
  await assertNoSymlink(repositoryRoot, ".launchrally/transactions");
  const reportId = reportPackage.report.report_id;
  const transactionsRoot = path.join(repositoryRoot, ".launchrally", "transactions");
  await recoverHistoryTransactions(repositoryRoot, ops);
  const finalDirectory = path.join(repositoryRoot, reportDirectory(reportId));
  const initialBundleState = await reportBundleState(repositoryRoot, reportId, files);
  if (initialBundleState === "different") {
    const error = new Error(`Report ID ${reportId} collides with different local history.`);
    error.code = "history_collision";
    throw error;
  }

  const evidenceFiles = files.filter(({ path: relative }) => relative.includes("/evidence/"));
  if (initialBundleState === "missing") {
    const transactionId = randomUUID();
    const transactionRoot = path.join(transactionsRoot, `report-${transactionId}`);
    const stagedBundle = path.join(transactionRoot, "bundle");
    const stagedEvidence = path.join(transactionRoot, "evidence");
    const createdEvidence = [];
    let committed = false;
    try {
      await ops.mkdir(transactionsRoot, { recursive: true });
      await ops.mkdir(transactionRoot, { recursive: false });
      const newEvidence = [];
      for (const file of evidenceFiles) {
        if (await readOptional(path.join(repositoryRoot, file.path)) === null) {
          newEvidence.push({ path: file.path, digest: `sha256:${path.basename(file.path, ".json")}` });
        }
      }
      await ops.write_file(
        path.join(transactionRoot, "transaction.json"),
        `${canonicalJson({
          schema_version: "launchrally.dev/local-history-transaction/v1",
          transaction_id: transactionId,
          report_id: reportId,
          record_digest: recordDigest,
          new_evidence: newEvidence,
          state: "staging",
          owner_pid: process.pid,
        })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await ops.mkdir(stagedBundle, { recursive: true });
      for (const file of evidenceFiles) {
        const target = path.join(repositoryRoot, file.path);
        const creation = await writeImmutable(
          target,
          file.content,
          ops,
          path.join(stagedEvidence, path.basename(file.path)),
        );
        if (creation.state === "created") createdEvidence.push({ target, file, creation });
      }
      for (const file of reportFiles(reportId, files)) {
        await ops.write_file(
          path.join(stagedBundle, path.basename(file.path)),
          file.content,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
      }
      await ops.mkdir(path.dirname(finalDirectory), { recursive: true });
      try {
        await ops.rename(stagedBundle, finalDirectory);
        committed = true;
      } catch (error) {
        const destinationState = await reportBundleState(repositoryRoot, reportId, files);
        if (destinationState === "identical") {
          committed = true;
        } else if (destinationState === "different") {
          const collision = new Error(
            `Report ID ${reportId} collides with different or partial local history.`,
          );
          collision.code = "history_collision";
          throw collision;
        } else {
          throw error;
        }
      }
    } catch (error) {
      if (!committed) {
        let evidenceCleanupFailed = false;
        for (const creation of createdEvidence.reverse()) {
          try {
            await removeExactCreation(
              creation.target,
              creation.file.content,
              creation.creation,
              ops,
            );
          } catch {
            evidenceCleanupFailed = true;
          }
        }
        if (!evidenceCleanupFailed) {
          await ops.remove(transactionRoot, { recursive: true, force: true }).catch(() => {});
        }
      } else {
        await ops.remove(transactionRoot, { recursive: true, force: true }).catch(() => {});
      }
      throw error;
    }
    await ops.remove(transactionRoot, { recursive: true, force: true }).catch(() => {});
  } else {
    if (await committedLocalHistoryState(repositoryRoot, reportId, recordDigest) !== "valid") {
      const error = new Error("Existing Report history is incomplete or tampered.");
      error.code = "history_collision";
      throw error;
    }
  }

  const cache = files.find(({ path: relative }) => relative.includes("/cache/"));
  let cacheUpdated = false;
  if (cache) {
    const cacheTarget = path.join(repositoryRoot, cache.path);
    const cacheTemporary = `${cacheTarget}.tmp-${randomUUID()}`;
    cacheUpdated = true;
    try {
      await ops.mkdir(path.dirname(cacheTarget), { recursive: true });
      await ops.write_file(cacheTemporary, cache.content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await ops.rename(cacheTemporary, cacheTarget);
    } catch (error) {
      await ops.remove(cacheTemporary, { force: true }).catch(() => {});
      cacheUpdated = false;
    }
  }
  return {
    report_id: reportId,
    record_digest: recordDigest,
    report_path: `${reportDirectory(reportId)}/record.json`,
    cache_updated: cacheUpdated,
  };
}

export async function persistLocalHistory(root, reportPackage, dependencies = {}) {
  const repositoryRoot = await assertRepositoryRoot(root);
  const ops = operations(dependencies.file_operations);
  await assertNoSymlink(repositoryRoot, ".launchrally/locks/owners");
  const launchrallyRoot = await ensureOwnedLockDirectory(
    path.join(repositoryRoot, ".launchrally"),
    ops,
  );
  if (launchrallyRoot !== path.join(repositoryRoot, ".launchrally")) {
    const error = new Error("The LaunchRally history root was redirected.");
    error.code = "unsafe_history_path";
    throw error;
  }
  const lockRoot = await ensureOwnedLockDirectory(path.join(launchrallyRoot, "locks"), ops);
  if (lockRoot !== path.join(launchrallyRoot, "locks")) {
    const error = new Error("The LaunchRally lock root was redirected.");
    error.code = "unsafe_history_path";
    throw error;
  }
  let release;
  try {
    release = await acquireOwnedLock(
      lockRoot,
      "history-writer",
      ops,
    );
  } catch (error) {
    if (error?.code === "owned_lock_busy") error.code = "history_writer_busy";
    if (error?.code === "invalid_owned_lock") error.code = "invalid_history_writer_lock";
    throw error;
  }
  try {
    return await persistLocalHistoryLocked(root, reportPackage, dependencies);
  } finally {
    await release();
  }
}
