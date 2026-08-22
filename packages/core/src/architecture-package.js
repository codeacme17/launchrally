import { randomUUID } from "node:crypto";
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

import {
  ARCHITECTURE_BLUEPRINT_SCHEMA,
  ARCHITECTURE_PACKAGE_SCHEMA,
  ARCHITECTURE_RECORD_SCHEMA,
  CAPABILITY_CATALOG_SCHEMA,
  CAPABILITY_GRAPH_SCHEMA,
  DESKTOP_SHARED_BACKEND_SCHEMA,
  INTEGRATION_CONTRACT_SCHEMA,
  PRODUCT_INTENT_PROFILE_SCHEMA,
  PROVIDER_KNOWLEDGE_SCHEMA,
  TASK_GRAPH_SCHEMA,
  assertValidArchitectureBlueprint,
  assertValidArchitecturePackage,
  assertValidArchitectureRecord,
  assertValidCapabilityCatalog,
  assertValidCapabilityGraph,
  assertValidDesktopSharedBackend,
  assertValidIntegrationContract,
  assertValidProductIntentProfile,
  assertValidTaskGraph,
} from "@launchrally/contracts";

import { acquireOwnedLock, ensureOwnedLockDirectory } from "./exclusive-lock.js";
import { resolveExecutionAuthority } from "./execution-authority.js";
import { canonicalJson, sha256 } from "./local-history.js";
import { decodeResumeState, encodeResumeState } from "./resume-state.js";

const DEPENDENT_SEMANTICS = new Set(["architecture_record", "task_graph"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PROVIDER_KNOWLEDGE_ID = /^knowledge_[a-f0-9]{16,64}$/u;
const REFERENCE_SCHEMA = /^launchrally\.dev\/[a-z0-9-]+\/v[1-9][0-9]*$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const PERSISTENCE_STATE_VERSION = "architecture-package-persistence/v1";
const SENSITIVE_STRING = /(?:\b(?:api[_-]?key|authorization|bearer|credential|password|passphrase|private[_-]?key|secret|session[_-]?token)\b|\bsk_(?:live|test)_[A-Za-z0-9]+|https?:\/\/[^\s]+@|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/iu;
const RETENTION = Object.freeze({
  raw_provider_output_retained: false,
  receipt_payload_retained: false,
  sensitive_data_retained: false,
});
const STORAGE = Object.freeze({
  shareable_intent_separate: true,
  local_history_immutable: true,
  automatically_staged: false,
  automatically_committed: false,
});

function reference(id, schemaVersion, value) {
  return { id, schema_version: schemaVersion, digest: sha256(value) };
}

function suppliedReferenceIsValid(value) {
  return IDENTIFIER.test(value?.id ?? "")
    && REFERENCE_SCHEMA.test(value?.schema_version ?? "")
    && DIGEST.test(value?.digest ?? "");
}

function assertProviderKnowledgeReferences(references) {
  if (!Array.isArray(references) || references.some((value) =>
    !suppliedReferenceIsValid(value)
    || !PROVIDER_KNOWLEDGE_ID.test(value.id)
    || value.schema_version !== PROVIDER_KNOWLEDGE_SCHEMA)) {
    const error = new Error("Provider Knowledge bindings must use opaque digest-derived identifiers.");
    error.code = "invalid_architecture_record";
    throw error;
  }
}

function buildConfirmedDecisions(blueprint, results) {
  const decisionById = new Map(blueprint.decisions.map((decision) => [
    decision.decision_id,
    decision,
  ]));
  if (!Array.isArray(results) || results.some(({ decision_id: decisionId, response }) =>
    !decisionById.has(decisionId) || !["confirm", "reject"].includes(response))) {
    const error = new Error("Architecture decision confirmations are incomplete or invalid.");
    error.code = "invalid_architecture_decisions";
    throw error;
  }
  const duplicateIds = results.map(({ decision_id: decisionId }) => decisionId);
  if (
    new Set(duplicateIds).size !== duplicateIds.length
    || duplicateIds.length !== decisionById.size
    || [...decisionById].some(([decisionId]) => !duplicateIds.includes(decisionId))
  ) {
    const error = new Error("Architecture decision confirmations contain duplicates.");
    error.code = "invalid_architecture_decisions";
    throw error;
  }
  const confirmed = results.filter(({ response }) => response === "confirm").map((result) => {
    const decision = decisionById.get(result.decision_id);
    return {
      decision_id: decision.decision_id,
      decision_revision: blueprint.revision,
      capability_id: decision.capability_id,
      implementation_path: decision.implementation_path,
      confirmation: "explicit_user_confirmation",
      status: decision.action,
    };
  });
  if (confirmed.length === 0) {
    const error = new Error("At least one Architecture decision must be explicitly confirmed.");
    error.code = "no_confirmed_architecture_decisions";
    throw error;
  }
  return confirmed;
}

function buildDependencyIndex(input, confirmed, recordId, taskGraph, desktopTopology) {
  const confirmedIds = new Set(confirmed.map(({ decision_id: decisionId }) => decisionId));
  const dependencies = input.dependencies ?? [];
  if (
    !Array.isArray(dependencies)
    || dependencies.length !== confirmedIds.size
    || new Set(dependencies.map(({ source_id: sourceId }) => sourceId)).size !== dependencies.length
    || dependencies.some(({ source_id: sourceId }) => !confirmedIds.has(sourceId))
  ) {
    const error = new Error("Every confirmed Architecture decision requires one dependency declaration.");
    error.code = "invalid_architecture_dependencies";
    throw error;
  }
  const edges = dependencies.map((dependency) => {
    const semantics = dependency.dependent_semantics;
    const evidenceIds = dependency.evidence_ids;
    if (
      !Array.isArray(semantics)
      || semantics.length === 0
      || new Set(semantics).size !== semantics.length
      || semantics.some((name) => !DEPENDENT_SEMANTICS.has(name))
      || (semantics.includes("task_graph") && taskGraph === null)
      || !Array.isArray(evidenceIds)
      || new Set(evidenceIds).size !== evidenceIds.length
      || evidenceIds.some((id) => !IDENTIFIER.test(id))
    ) {
      const error = new Error("An Architecture dependency declaration is incomplete or invalid.");
      error.code = "invalid_architecture_dependencies";
      throw error;
    }
    return {
      source_id: dependency.source_id,
      dependent_record_ids: semantics.map((name) => name === "architecture_record"
        ? recordId
        : taskGraph.graph_id),
      evidence_ids: [...evidenceIds].sort(),
    };
  }).sort((left, right) => left.source_id.localeCompare(right.source_id));
  return {
    schema_version: "launchrally.dev/architecture-dependency-index/v1",
    desktop_topology: desktopTopology === null
      ? null
      : reference(
        `desktop_topology_${sha256(desktopTopology).slice(7, 23)}`,
        DESKTOP_SHARED_BACKEND_SCHEMA,
        desktopTopology,
      ),
    edges,
  };
}

function assertBundle(value) {
  const legacyKeys = [
    "architecture_record",
    "capability_graph",
    "dependency_index",
    "package",
    "previous_package",
    "product_intent",
    "task_graph",
  ];
  const expectedKeys = [...legacyKeys, "desktop_topology"].sort();
  const actualKeys = Object.keys(value ?? {}).sort();
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || ![
      canonicalJson(legacyKeys.sort()),
      canonicalJson(expectedKeys),
    ].includes(canonicalJson(actualKeys))
  ) {
    const error = new Error("The Architecture Package bundle has an unsupported shape.");
    error.code = "invalid_architecture_package_bundle";
    throw error;
  }
  assertValidProductIntentProfile(value.product_intent);
  assertValidCapabilityGraph(value.capability_graph);
  assertValidArchitectureRecord(value.architecture_record);
  assertValidArchitecturePackage(value.package);
  const desktopTopology = value.desktop_topology ?? null;
  if (desktopTopology !== null) assertValidDesktopSharedBackend(desktopTopology);
  if (value.task_graph !== null) assertValidTaskGraph(value.task_graph);
  if (
    value.dependency_index?.schema_version
      !== "launchrally.dev/architecture-dependency-index/v1"
    || !Array.isArray(value.dependency_index?.edges)
    || (desktopTopology === null
      ? value.dependency_index?.desktop_topology !== null
        && value.dependency_index?.desktop_topology !== undefined
      : !referencesEqual(
        value.dependency_index?.desktop_topology,
        reference(
          `desktop_topology_${sha256(desktopTopology).slice(7, 23)}`,
          DESKTOP_SHARED_BACKEND_SCHEMA,
          desktopTopology,
        ),
      ))
    || (value.previous_package !== null && !suppliedReferenceIsValid(value.previous_package))
  ) {
    const error = new Error("The Architecture dependency index is incomplete or invalid.");
    error.code = "invalid_architecture_dependencies";
    throw error;
  }
  function assertSafeStrings(candidate) {
    if (Array.isArray(candidate)) {
      candidate.forEach(assertSafeStrings);
      return;
    }
    if (candidate && typeof candidate === "object") {
      Object.values(candidate).forEach(assertSafeStrings);
      return;
    }
    if (typeof candidate === "string" && (
      candidate.length > 1024
      || /[\u0000-\u001f\u007f]/u.test(candidate)
      || SENSITIVE_STRING.test(candidate)
    )) {
      const error = new Error("Architecture Package history accepts normalized secret-safe strings only.");
      error.code = "unsafe_architecture_history_payload";
      throw error;
    }
  }
  assertSafeStrings(value);
}

export function createArchitecturePackageBundle(input, options = {}) {
  const now = options.now ?? new Date().toISOString();
  assertValidArchitectureBlueprint(input?.blueprint);
  assertValidProductIntentProfile(input?.product_intent);
  assertValidCapabilityCatalog(input?.catalog);
  assertValidCapabilityGraph(input?.capability_graph);
  for (const contract of input?.integration_contracts ?? []) {
    assertValidIntegrationContract(contract);
  }
  assertProviderKnowledgeReferences(input?.provider_knowledge_refs ?? []);
  const desktopTopology = input?.desktop_topology ?? null;
  if (desktopTopology !== null) assertValidDesktopSharedBackend(desktopTopology);
  if (input?.previous_package) {
    assertValidArchitecturePackage(input.previous_package);
    if (input.previous_package.environment !== input.blueprint?.environment) {
      const error = new Error("Architecture Package revisions cannot cross environments.");
      error.code = "architecture_binding_mismatch";
      throw error;
    }
  }
  if (input?.task_graph !== null && input?.task_graph !== undefined) {
    assertValidTaskGraph(input.task_graph);
  }
  const { blueprint, product_intent: productIntent, catalog, capability_graph: graph } = input;
  if (
    blueprint.product_intent.digest !== sha256(productIntent)
    || blueprint.capability_graph.digest !== sha256(graph)
    || graph.catalog.id !== catalog.catalog_id
    || graph.catalog.digest !== catalog.digest
    || blueprint.environment !== productIntent.environment
    || blueprint.environment !== graph.environment
  ) {
    const error = new Error("Architecture Package inputs do not match the confirmed Blueprint.");
    error.code = "architecture_binding_mismatch";
    throw error;
  }
  const confirmedDecisions = buildConfirmedDecisions(blueprint, input.decision_results);
  const recordId = `architecture_record_${sha256({
    blueprint,
    confirmed_decisions: confirmedDecisions,
    created_at: now,
  }).slice(7, 23)}`;
  const integrationReferences = input.integration_contracts.map((contract) =>
    reference(contract.contract_id, INTEGRATION_CONTRACT_SCHEMA, contract));
  const architectureRecord = {
    schema_version: ARCHITECTURE_RECORD_SCHEMA,
    record_id: recordId,
    revision: (input.previous_package?.revision ?? 0) + 1,
    created_at: now,
    environment: blueprint.environment,
    blueprint: reference(blueprint.blueprint_id, ARCHITECTURE_BLUEPRINT_SCHEMA, blueprint),
    bindings: {
      source_report: structuredClone(blueprint.source_report),
      product_intent: reference(
        productIntent.profile_id,
        PRODUCT_INTENT_PROFILE_SCHEMA,
        productIntent,
      ),
      capability_catalog: {
        id: catalog.catalog_id,
        schema_version: CAPABILITY_CATALOG_SCHEMA,
        digest: catalog.digest,
      },
      integration_contracts: integrationReferences,
      provider_knowledge: structuredClone(input.provider_knowledge_refs),
      constraints_digest: sha256(blueprint.constraints),
    },
    confirmed_decisions: confirmedDecisions,
    provenance: {
      actor: "user",
      interaction_id: input.interaction_id,
    },
    retention: { ...RETENTION },
  };
  assertValidArchitectureRecord(architectureRecord);
  const taskGraph = input.task_graph === null || input.task_graph === undefined
    ? null
    : {
      ...structuredClone(input.task_graph),
      architecture_record: reference(recordId, ARCHITECTURE_RECORD_SCHEMA, architectureRecord),
    };
  if (taskGraph !== null) assertValidTaskGraph(taskGraph);
  const dependencyIndex = buildDependencyIndex(
    input,
    confirmedDecisions,
    recordId,
    taskGraph,
    desktopTopology,
  );
  const packageId = `architecture_package_${sha256({
    architecture_record: architectureRecord,
    dependency_index: dependencyIndex,
    desktop_topology: desktopTopology === null ? null : structuredClone(desktopTopology),
  }).slice(7, 23)}`;
  const architecturePackage = {
    schema_version: ARCHITECTURE_PACKAGE_SCHEMA,
    package_id: packageId,
    revision: architectureRecord.revision,
    created_at: now,
    environment: blueprint.environment,
    records: {
      product_intent: reference(
        productIntent.profile_id,
        PRODUCT_INTENT_PROFILE_SCHEMA,
        productIntent,
      ),
      capability_graph: reference(graph.graph_id, CAPABILITY_GRAPH_SCHEMA, graph),
      architecture_record: reference(recordId, ARCHITECTURE_RECORD_SCHEMA, architectureRecord),
      task_graph: taskGraph === null
        ? null
        : reference(taskGraph.graph_id, TASK_GRAPH_SCHEMA, taskGraph),
    },
    currentness: {
      state: "current",
      invalidated_record_ids: [],
      reasons: [],
    },
    storage: { ...STORAGE },
    retention: { ...RETENTION },
  };
  const value = {
    package: architecturePackage,
    previous_package: input.previous_package
      ? reference(
        input.previous_package.package_id,
        ARCHITECTURE_PACKAGE_SCHEMA,
        input.previous_package,
      )
      : null,
    product_intent: structuredClone(productIntent),
    capability_graph: structuredClone(graph),
    architecture_record: architectureRecord,
    task_graph: taskGraph === null ? null : structuredClone(taskGraph),
    dependency_index: dependencyIndex,
    desktop_topology: desktopTopology === null ? null : structuredClone(desktopTopology),
  };
  assertBundle(value);
  return value;
}

function referencesEqual(left, right) {
  return left?.id === right?.id
    && left?.schema_version === right?.schema_version
    && left?.digest === right?.digest;
}

function referenceSetEqual(left, right) {
  if (!Array.isArray(right) || left.length !== right.length) return false;
  const serialized = (values) => values.map((value) => canonicalJson(value)).sort();
  return canonicalJson(serialized(left)) === canonicalJson(serialized(right));
}

export function evaluateArchitecturePackageCurrentness(bundle, current = {}) {
  assertBundle(bundle);
  if (current.superseded_by) {
    return {
      state: "superseded",
      invalidated_record_ids: [],
      invalidated_evidence_ids: [],
      reasons: [`superseded_by:${current.superseded_by}`],
    };
  }
  const bindings = bundle.architecture_record.bindings;
  const inputChecks = [
    ["source_report", bindings.source_report, current.source_report, referencesEqual],
    ["product_intent", bindings.product_intent, current.product_intent, referencesEqual],
    ["capability_catalog", bindings.capability_catalog, current.capability_catalog, referencesEqual],
    ["integration_contracts", bindings.integration_contracts, current.integration_contracts, referenceSetEqual],
    ["provider_knowledge", bindings.provider_knowledge, current.provider_knowledge, referenceSetEqual],
    ["constraints", bindings.constraints_digest, current.constraints_digest, (left, right) =>
      left === right],
    [
      "desktop_topology",
      bundle.dependency_index.desktop_topology,
      current.desktop_topology,
      referencesEqual,
    ],
  ];
  const stale = [];
  for (const [name, bound, candidate, compare] of inputChecks) {
    if (candidate !== undefined && !compare(bound, candidate)) stale.push(`${name}_changed`);
  }
  if (stale.length > 0) {
    return {
      state: "needs_reassessment",
      invalidated_record_ids: [bundle.architecture_record.record_id],
      invalidated_evidence_ids: [],
      reasons: stale.sort(),
    };
  }
  const changed = [...new Set(current.changed_dependency_ids ?? [])].sort();
  const edgeBySource = new Map(bundle.dependency_index.edges.map((edge) => [edge.source_id, edge]));
  const unknown = changed.filter((id) => !edgeBySource.has(id));
  if (unknown.length > 0) {
    return {
      state: "needs_reassessment",
      invalidated_record_ids: [bundle.architecture_record.record_id],
      invalidated_evidence_ids: [],
      reasons: unknown.map((id) => `undeclared_dependency_changed:${id}`),
    };
  }
  const affected = changed.map((id) => edgeBySource.get(id));
  const invalidatedRecordIds = [...new Set(affected.flatMap((edge) =>
    edge.dependent_record_ids))].sort();
  const invalidatedEvidenceIds = [...new Set(affected.flatMap((edge) =>
    edge.evidence_ids))].sort();
  return {
    state: changed.length > 0 ? "partially_invalidated" : "current",
    invalidated_record_ids: invalidatedRecordIds,
    invalidated_evidence_ids: invalidatedEvidenceIds,
    reasons: changed.map((id) => `declared_dependency_changed:${id}`),
  };
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function repositoryRoot(root) {
  const resolved = path.resolve(root);
  const selected = await lstat(resolved);
  if (!selected.isDirectory() || selected.isSymbolicLink()) {
    const error = new Error("Architecture history requires a canonical repository directory.");
    error.code = "repository_scope_mismatch";
    throw error;
  }
  return realpath(resolved);
}

async function assertSafeExistingPath(target, type) {
  try {
    const selected = await lstat(target);
    if (selected.isSymbolicLink() || (type === "directory" && !selected.isDirectory())
      || (type === "file" && !selected.isFile())) {
      const error = new Error(`Architecture history refuses redirected path: ${target}`);
      error.code = "unsafe_architecture_history_path";
      throw error;
    }
    return selected;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function initializedProject(root, launcherVersion) {
  const manifestPath = path.join(root, ".launchrally", "manifest.yaml");
  if (await assertSafeExistingPath(manifestPath, "file") === null) return false;
  const authority = await resolveExecutionAuthority({
    cwd: root,
    launcher_version: launcherVersion,
  });
  return authority.state === "ready"
    && authority.source === "project_toolchain"
    && authority.selection?.project_root === root;
}

function pointerMatchesPredecessor(pointer, predecessor) {
  if (predecessor === null) return pointer === null;
  return pointer?.package_id === predecessor.id
    && pointer?.package_digest === predecessor.digest;
}

function packageFiles(bundle) {
  const desktopTopology = bundle.desktop_topology ?? null;
  return [
    ["package.json", bundle.package],
    ["capability-graph.json", bundle.capability_graph],
    ["architecture-record.json", bundle.architecture_record],
    ["dependency-index.json", bundle.dependency_index],
    ...(desktopTopology === null
      ? []
      : [["desktop-topology.json", desktopTopology]]),
    ...(bundle.task_graph === null ? [] : [["task-graph.json", bundle.task_graph]]),
  ].map(([name, value]) => ({ name, content: `${canonicalJson(value)}\n` }));
}

function shareableIntentFile(bundle) {
  return {
    path: `.launchrally/architecture/shareable-intent/sha256/${sha256(bundle.product_intent).slice(7)}.json`,
    content: `${canonicalJson(bundle.product_intent)}\n`,
  };
}

export async function previewArchitecturePackagePersistence(root, bundle, options = {}) {
  assertBundle(bundle);
  const resolvedRoot = await repositoryRoot(root);
  const initialized = await initializedProject(
    resolvedRoot,
    options.launcher_version ?? "0.4.2",
  );
  if (!initialized && !options.output_path) {
    return { mode: "output_only", requires_confirmation: false, files: [] };
  }
  if (!initialized) {
    return {
      mode: "selected_output",
      requires_confirmation: false,
      files: [path.resolve(options.output_path)],
    };
  }
  const directory = `.launchrally/architecture/packages/${bundle.package.package_id}`;
  const currentPointer = await readPointer(
    path.join(resolvedRoot, ".launchrally", "architecture", "current.json"),
  );
  if (!pointerMatchesPredecessor(currentPointer, bundle.previous_package)) {
    const error = new Error("The Architecture Package does not append to the current package.");
    error.code = "architecture_package_ancestry_mismatch";
    throw error;
  }
  return {
    mode: "local_history",
    requires_confirmation: true,
    files: [
      shareableIntentFile(bundle).path,
      ...packageFiles(bundle).map(({ name }) => `${directory}/${name}`),
      ".launchrally/architecture/current.json",
    ],
    bundle_digest: sha256(bundle),
    current_pointer_digest: sha256(currentPointer),
  };
}

async function writeSelectedOutput(target, bundle) {
  const resolved = path.resolve(target);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, `${canonicalJson(bundle)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      await link(temporary, resolved);
    } catch (error) {
      if (error?.code === "EEXIST") {
        error.code = "architecture_output_exists";
      }
      throw error;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
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

async function readPointer(pointerPath) {
  try {
    const stat = await lstat(pointerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      const error = new Error("The current Architecture Package pointer is unsafe.");
      error.code = "unsafe_architecture_history_path";
      throw error;
    }
    return JSON.parse(await readFile(pointerPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function recoverArchitectureTransactions(repositoryRoot) {
  const architectureRoot = path.join(repositoryRoot, ".launchrally", "architecture");
  const transactionsRoot = path.join(architectureRoot, "transactions");
  await assertSafeExistingPath(architectureRoot, "directory");
  await assertSafeExistingPath(transactionsRoot, "directory");
  let entries;
  try {
    entries = await readdir(transactionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()
      || !/^architecture-[a-f0-9-]{36}$/u.test(entry.name)) {
      const error = new Error("An Architecture history transaction is invalid and was preserved.");
      error.code = "invalid_architecture_transaction";
      throw error;
    }
    const transactionRoot = path.join(transactionsRoot, entry.name);
    await assertSafeExistingPath(transactionRoot, "directory");
    const journalPath = path.join(transactionRoot, "transaction.json");
    await assertSafeExistingPath(journalPath, "file");
    let journal;
    try {
      journal = JSON.parse(await readFile(journalPath, "utf8"));
    } catch {
      const error = new Error("An Architecture history transaction journal is invalid.");
      error.code = "invalid_architecture_transaction";
      throw error;
    }
    if (
      journal?.schema_version !== "launchrally.dev/architecture-transaction/v1"
      || !IDENTIFIER.test(journal.package_id ?? "")
      || !DIGEST.test(journal.package_digest ?? "")
      || !DIGEST.test(journal.intent_digest ?? "")
      || typeof journal.intent_created !== "boolean"
      || !Number.isInteger(journal.owner_pid)
      || journal.owner_pid < 1
    ) {
      const error = new Error("An Architecture history transaction journal is invalid.");
      error.code = "invalid_architecture_transaction";
      throw error;
    }
    if (processIsAlive(journal.owner_pid)) {
      const error = new Error("Another writer has a live Architecture history transaction.");
      error.code = "architecture_transaction_busy";
      throw error;
    }
    const packagesRoot = path.join(architectureRoot, "packages");
    await assertSafeExistingPath(packagesRoot, "directory");
    const finalDirectory = path.join(packagesRoot, journal.package_id);
    let committed = false;
    if (await exists(finalDirectory)) {
      await assertSafeExistingPath(finalDirectory, "directory");
      const packagePath = path.join(finalDirectory, "package.json");
      await assertSafeExistingPath(packagePath, "file");
      let persistedPackage;
      try {
        persistedPackage = JSON.parse(await readFile(packagePath, "utf8"));
      } catch {
        const error = new Error("An interrupted Architecture Package is incomplete.");
        error.code = "invalid_architecture_transaction";
        throw error;
      }
      if (sha256(persistedPackage) !== journal.package_digest) {
        const error = new Error("An interrupted Architecture Package does not match its journal.");
        error.code = "invalid_architecture_transaction";
        throw error;
      }
      const pointer = await readPointer(path.join(architectureRoot, "current.json"));
      committed = pointer?.package_id === journal.package_id
        && pointer?.package_digest === journal.package_digest;
      if (!committed) await rm(finalDirectory, { recursive: true, force: false });
    }
    if (!committed && journal.intent_created) {
      const shareableRoot = path.join(architectureRoot, "shareable-intent");
      const shareableDigestRoot = path.join(shareableRoot, "sha256");
      await assertSafeExistingPath(shareableRoot, "directory");
      await assertSafeExistingPath(shareableDigestRoot, "directory");
      const intentTarget = path.join(
        shareableDigestRoot,
        `${journal.intent_digest.slice(7)}.json`,
      );
      await assertSafeExistingPath(intentTarget, "file");
      let content = null;
      try {
        content = await readFile(intentTarget, "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (content !== null && sha256(JSON.parse(content)) !== journal.intent_digest) {
        const error = new Error("An interrupted shareable Product Intent is inconsistent.");
        error.code = "invalid_architecture_transaction";
        throw error;
      }
      if (content !== null) await rm(intentTarget, { force: false });
    }
    await rm(transactionRoot, { recursive: true, force: false });
  }
}

async function withHistoryWriterLock(repositoryRoot, callback) {
  const launchrallyRoot = path.join(repositoryRoot, ".launchrally");
  await assertSafeExistingPath(launchrallyRoot, "directory");
  const locksRoot = await ensureOwnedLockDirectory(path.join(launchrallyRoot, "locks"));
  let release;
  try {
    release = await acquireOwnedLock(locksRoot, "history-writer");
  } catch (error) {
    if (error?.code === "owned_lock_busy") error.code = "history_writer_busy";
    if (error?.code === "invalid_owned_lock") error.code = "invalid_history_writer_lock";
    throw error;
  }
  try {
    return await callback();
  } finally {
    await release();
  }
}

async function persistInitializedArchitecturePackage(
  resolvedRoot,
  bundle,
  preview,
  options,
) {
  if (!await initializedProject(resolvedRoot, options.launcher_version ?? "0.4.2")) {
    const error = new Error("The repository was no longer initialized at confirmation time.");
    error.code = "architecture_persistence_scope_changed";
    throw error;
  }
  await recoverArchitectureTransactions(resolvedRoot);
  const repositoryRoot = resolvedRoot;
  const architectureRoot = path.join(repositoryRoot, ".launchrally", "architecture");
  await assertSafeExistingPath(architectureRoot, "directory");
  await assertSafeExistingPath(path.join(architectureRoot, "transactions"), "directory");
  const packagesRoot = path.join(architectureRoot, "packages");
  await assertSafeExistingPath(packagesRoot, "directory");
  const pointerPath = path.join(architectureRoot, "current.json");
  await options.file_operations?.after_history_lock?.();
  if (sha256(await readPointer(pointerPath)) !== preview.current_pointer_digest) {
    const error = new Error("The current Architecture Package changed after preview.");
    error.code = "architecture_current_pointer_changed";
    throw error;
  }
  const finalDirectory = path.join(packagesRoot, bundle.package.package_id);
  if (await exists(finalDirectory)) {
    const error = new Error("The immutable Architecture Package ID already exists.");
    error.code = "architecture_history_collision";
    throw error;
  }
  const transactionRoot = path.join(
    repositoryRoot,
    ".launchrally",
    "architecture",
    "transactions",
    `architecture-${randomUUID()}`,
  );
  const stagedBundle = path.join(transactionRoot, "bundle");
  const pointerTemporary = path.join(transactionRoot, "current.json");
  const intent = shareableIntentFile(bundle);
  const intentTarget = path.join(repositoryRoot, intent.path);
  const shareableRoot = path.join(architectureRoot, "shareable-intent");
  const shareableDigestRoot = path.join(shareableRoot, "sha256");
  await assertSafeExistingPath(shareableRoot, "directory");
  await assertSafeExistingPath(shareableDigestRoot, "directory");
  const existingIntent = await (async () => {
    try {
      return await readFile(intentTarget, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  })();
  if (existingIntent !== null && existingIntent !== intent.content) {
    const error = new Error("The shareable Product Intent address collides with different content.");
    error.code = "architecture_history_collision";
    throw error;
  }
  let packageCommitted = false;
  try {
    await mkdir(stagedBundle, { recursive: true });
    await writeFile(path.join(transactionRoot, "transaction.json"), `${canonicalJson({
      schema_version: "launchrally.dev/architecture-transaction/v1",
      package_id: bundle.package.package_id,
      package_digest: sha256(bundle.package),
      intent_digest: sha256(bundle.product_intent),
      intent_created: existingIntent === null,
      owner_pid: process.pid,
    })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    for (const file of packageFiles(bundle)) {
      await writeFile(path.join(stagedBundle, file.name), file.content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    }
    if (existingIntent === null) {
      await mkdir(shareableRoot, { recursive: false }).catch((error) => {
        if (error?.code !== "EEXIST") throw error;
      });
      await assertSafeExistingPath(shareableRoot, "directory");
      await mkdir(shareableDigestRoot, { recursive: false }).catch((error) => {
        if (error?.code !== "EEXIST") throw error;
      });
      await assertSafeExistingPath(shareableDigestRoot, "directory");
      await writeFile(intentTarget, intent.content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    }
    await writeFile(pointerTemporary, `${canonicalJson({
      schema_version: "launchrally.dev/architecture-package-pointer/v1",
      package_id: bundle.package.package_id,
      package_digest: sha256(bundle.package),
    })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await mkdir(packagesRoot, { recursive: true });
    await rename(stagedBundle, finalDirectory);
    packageCommitted = true;
    await options.file_operations?.before_pointer_commit?.();
    await mkdir(architectureRoot, { recursive: true });
    await rename(pointerTemporary, pointerPath);
  } catch (error) {
    if (packageCommitted) await rm(finalDirectory, { recursive: true, force: true }).catch(() => {});
    if (existingIntent === null) await rm(intentTarget, { force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(transactionRoot, { recursive: true, force: true }).catch(() => {});
  }
  return {
    status: "completed",
    persisted: true,
    package_id: bundle.package.package_id,
    package_path: path.relative(repositoryRoot, finalDirectory),
    ...preview,
  };
}

export async function persistArchitecturePackage(root, bundle, options = {}) {
  const preview = await previewArchitecturePackagePersistence(root, bundle, options);
  if (preview.mode === "output_only") {
    return { status: "completed", persisted: false, ...preview };
  }
  if (preview.mode === "selected_output") {
    await writeSelectedOutput(options.output_path, bundle);
    return { status: "completed", persisted: true, ...preview };
  }
  if (options.confirmation !== "confirm") {
    const resolvedRoot = await repositoryRoot(root);
    const resumeToken = encodeResumeState({
      state_version: PERSISTENCE_STATE_VERSION,
      root: resolvedRoot,
      bundle_digest: preview.bundle_digest,
      current_pointer_digest: preview.current_pointer_digest,
      files: preview.files,
    });
    return {
      status: "needs_confirmation",
      persisted: false,
      resume_token: resumeToken,
      preview,
      ...preview,
    };
  }
  const resolvedRoot = await repositoryRoot(root);
  const confirmedPreview = decodeResumeState(options.resume_token, (state) =>
    state?.state_version === PERSISTENCE_STATE_VERSION);
  if (
    !confirmedPreview
    || confirmedPreview.root !== resolvedRoot
    || confirmedPreview.bundle_digest !== preview.bundle_digest
    || confirmedPreview.current_pointer_digest !== preview.current_pointer_digest
    || canonicalJson(confirmedPreview.files) !== canonicalJson(preview.files)
  ) {
    const error = new Error("Architecture Package confirmation does not match its preview.");
    error.code = "invalid_architecture_persistence_preview";
    throw error;
  }
  return withHistoryWriterLock(
    resolvedRoot,
    () => persistInitializedArchitecturePackage(resolvedRoot, bundle, preview, options),
  );
}
