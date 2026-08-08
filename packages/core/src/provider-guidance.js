import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  constants,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CLI_INTERACTION_CONTRACT,
  PROVIDER_GUIDANCE_SCHEMA,
  PROVIDER_GUIDANCE_INTERACTION_SCHEMA,
  PROVIDER_INTENT_DECISION_SCHEMA,
  assertValidProviderGuidance,
  assertSupportedManifestVersion,
  assertSupportedReportVersion,
  assertValidManifest,
  assertValidReportPackage,
} from "@launchrally/contracts";

import { PROVIDER_DECISION_CARDS } from "./provider-decision-cards.js";
import {
  MANIFEST_RELATIVE_PATH,
  parseManifest,
  serializeManifest,
} from "./manifest.js";
import { createNeedsRefreshResult } from "./interaction-result.js";
import { evaluateReportCurrentness } from "./report-currentness.js";

const CAPABILITY_BY_CHECK = Object.freeze({
  "web.public.availability": "managed_web_delivery",
});
const CAPABILITY_BY_ROLE = Object.freeze({
  deployment: "managed_web_delivery",
});
const REGION_VALUES = Object.freeze([
  "global",
  "north_america",
  "europe",
  "asia_pacific",
  "specific_or_residency",
]);
const STACK_SIGNALS = Object.freeze([...new Set(PROVIDER_DECISION_CARDS.flatMap((card) => [
  ...card.compatibility.stack_signals,
  ...card.compatibility.incompatible_stack_signals,
]))]
  .filter((signal) => !PROVIDER_DECISION_CARDS.some(({ provider }) =>
    signal.includes(provider.id)))
  .sort());

const CONSTRAINT_FIELDS = Object.freeze([
  {
    field_id: "budget",
    value_type: "enum",
    candidates: ["free_tier_required", "cost_sensitive", "flexible", "enterprise"],
    current_value: null,
    prompt: "Confirm the available Provider budget and cost tolerance.",
  },
  {
    field_id: "scale",
    value_type: "enum",
    candidates: ["prototype", "small", "growing", "high_scale"],
    current_value: null,
    prompt: "Confirm the expected traffic scale and growth shape.",
  },
  {
    field_id: "region",
    value_type: "enum",
    candidates: [...REGION_VALUES],
    current_value: null,
    prompt: "Confirm required serving regions and any residency constraint.",
  },
  {
    field_id: "existing_stack",
    value_type: "string_array",
    candidates: [...STACK_SIGNALS],
    current_value: [],
    prompt:
      "Confirm the existing frameworks, runtimes, and infrastructure to preserve; candidates are examples and free-form labels are normalized.",
  },
  {
    field_id: "operational_ability",
    value_type: "enum",
    candidates: ["minimal", "moderate", "specialist"],
    current_value: null,
    prompt: "Confirm the team's ability to operate Provider-specific infrastructure.",
  },
  {
    field_id: "lock_in_preference",
    value_type: "enum",
    candidates: ["minimize", "balanced", "accept_provider_specific"],
    current_value: null,
    prompt: "Confirm the acceptable level of Provider lock-in.",
  },
]);
const CONSTRAINT_VALUES = Object.freeze({
  budget: new Set(["free_tier_required", "cost_sensitive", "flexible", "enterprise"]),
  scale: new Set(["prototype", "small", "growing", "high_scale"]),
  operational_ability: new Set(["minimal", "moderate", "specialist"]),
  lock_in_preference: new Set(["minimize", "balanced", "accept_provider_specific"]),
  region: new Set(REGION_VALUES),
});
const OPERATIONAL_ABILITY_RANK = Object.freeze({ minimal: 0, moderate: 1, specialist: 2 });

function result(status, extra = {}) {
  return {
    contract: CLI_INTERACTION_CONTRACT,
    status,
    operation: "providers",
    ...extra,
  };
}

function guidanceResult(status, extra = {}) {
  const value = result(status, {
    schema_version: PROVIDER_GUIDANCE_SCHEMA,
    ...extra,
  });
  assertValidProviderGuidance(value);
  return value;
}

async function storeState(state) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-providers-"));
  const directoryToken = path.basename(directory).slice("launchrally-providers-".length);
  const fileToken = randomBytes(32).toString("base64url");
  const token = `lrproviders_${directoryToken}_${fileToken}`;
  await writeFile(
    path.join(directory, `${fileToken}.json`),
    `${JSON.stringify(state)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return token;
}

async function loadState(token) {
  if (typeof token !== "string") return null;
  const match = token.match(/^lrproviders_([A-Za-z0-9]{6})_([A-Za-z0-9_-]{43})$/u);
  if (!match) return null;
  const statePath = path.join(
    os.tmpdir(),
    `launchrally-providers-${match[1]}`,
    `${match[2]}.json`,
  );
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    return state?.schema_version === PROVIDER_GUIDANCE_INTERACTION_SCHEMA
      ? { state, statePath }
      : null;
  } catch {
    return null;
  }
}

async function saveState(statePath, state) {
  await writeFile(statePath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
}

function normalizeConstraints(value) {
  const constraints = {};
  const validationErrors = [];
  for (const fieldId of ["budget", "scale", "operational_ability", "lock_in_preference"]) {
    const candidate = typeof value?.[fieldId] === "string"
      ? value[fieldId].trim().toLowerCase()
      : "";
    if (!CONSTRAINT_VALUES[fieldId].has(candidate)) {
      validationErrors.push({ field_id: fieldId, code: candidate ? "invalid_choice" : "required" });
    } else {
      constraints[fieldId] = candidate;
    }
  }
  const region = typeof value?.region === "string" ? value.region.trim().toLowerCase() : "";
  if (!CONSTRAINT_VALUES.region.has(region)) {
    validationErrors.push({ field_id: "region", code: region ? "invalid_choice" : "required" });
  } else {
    constraints.region = region;
  }

  if (!Array.isArray(value?.existing_stack)) {
    validationErrors.push({ field_id: "existing_stack", code: "required" });
  } else if (value.existing_stack.some((item) => typeof item !== "string" || !item.trim())) {
    validationErrors.push({ field_id: "existing_stack", code: "invalid_value" });
  } else {
    constraints.existing_stack = [...new Set(
      value.existing_stack.map((item) =>
        item.trim().toLowerCase().replace(/[\s-]+/gu, "_")),
    )].sort();
  }
  const fieldOrder = CONSTRAINT_FIELDS.map(({ field_id: fieldId }) => fieldId);
  validationErrors.sort(
    (left, right) => fieldOrder.indexOf(left.field_id) - fieldOrder.indexOf(right.field_id),
  );
  return { constraints, validationErrors };
}

function interaction(state, token) {
  return {
    schema_version: PROVIDER_GUIDANCE_INTERACTION_SCHEMA,
    interaction_id: state.interaction_id,
    step: state.step,
    resume_token: token,
  };
}

function constraintFields() {
  return CONSTRAINT_FIELDS.map((field) => structuredClone(field));
}

function triggerFrom(state) {
  if (state.trigger_kind !== "evidenced_capability_gap") {
    return {
      kind: state.trigger_kind,
      source_report_id: state.source_report_id,
      current_provider_id: state.current_provider_id,
      provider_role: state.current_provider_role,
      capability_id: state.capability_id,
      ...(state.trigger_kind === "confirmed_constraint_mismatch"
        ? { constraint_ids: [...state.mismatch_constraint_ids] }
        : {}),
      summary: state.trigger_kind === "confirmed_constraint_mismatch"
        ? `Confirmed Provider constraints conflict with the current ${state.current_provider_id} ${state.current_provider_role} intent.`
        : `The current ${state.current_provider_id} ${state.current_provider_role} intent will be checked against confirmed constraints before alternatives are shown.`,
    };
  }
  return {
    kind: "evidenced_capability_gap",
    source_report_id: state.source_report_id,
    check_id: state.source_check_id,
    check_status: "failed",
    capability_id: state.capability_id,
    summary: state.source_summary,
  };
}

function explainCard(card, constraints) {
  const reasons = [
    `Capability match: ${card.capability_scope.summary}`,
  ];
  if (card.constraints.budgets.includes(constraints.budget)) {
    reasons.push(
      `Budget fit: the Card covers ${constraints.budget}; calculate actual spend from current official pricing.`,
    );
  }
  if (card.constraints.scales.includes(constraints.scale)) {
    reasons.push(`Scale fit: the Card covers a ${constraints.scale} workload shape.`);
  }
  const matchingStack = constraints.existing_stack.filter((item) =>
    card.compatibility.stack_signals.includes(item),
  );
  const incompatibleStack = constraints.existing_stack.filter((item) =>
    card.compatibility.incompatible_stack_signals.includes(item),
  );
  if (matchingStack.length > 0) {
    reasons.push(`Existing-stack signal: ${matchingStack.join(", ")} appears in the Card's compatibility scope.`);
  }
  reasons.push(
    `Operations fit: the managed model is compatible with ${constraints.operational_ability} operational ability, subject to the listed builder responsibilities.`,
  );
  if (card.compatibility.region_signals.includes(constraints.region)) {
    reasons.push(`Region fit: the Card explicitly covers the ${constraints.region} serving profile.`);
  }
  if (constraints.lock_in_preference === "minimize" && card.lock_in.level === "low") {
    reasons.push("Lock-in fit: the Card records a low-lock-in path for the confirmed minimize preference.");
  }

  const limits = [
    ...card.cost_model.caveats,
    ...card.compatibility.notes,
  ];
  if (!card.compatibility.region_signals.includes(constraints.region)) {
    limits.push(
      `Region fit remains Unknown for "${constraints.region}"; verify current official region and residency documentation.`,
    );
  }
  if (incompatibleStack.length > 0) {
    limits.push(`Explicit stack mismatch: ${incompatibleStack.join(", ")}.`);
  }
  if (matchingStack.length !== constraints.existing_stack.length) {
    const unmatched = constraints.existing_stack.filter((item) => !matchingStack.includes(item));
    if (unmatched.length > 0) {
      limits.push(`Compatibility remains Unknown for existing-stack signals: ${unmatched.join(", ")}.`);
    }
  }
  if (constraints.lock_in_preference === "minimize" && card.lock_in.level !== "low") {
    limits.push(
      `Lock-in mismatch: the confirmed preference is minimize while this Card records ${card.lock_in.level} lock-in.`,
    );
  }
  return { card: structuredClone(card), reasons, limits };
}

function shortlistFor(state) {
  return PROVIDER_DECISION_CARDS
    .filter((card) => card.capability_scope.id === state.capability_id)
    .filter((card) =>
      card.constraints.budgets.includes(state.constraints.budget)
      && card.constraints.scales.includes(state.constraints.scale)
      && OPERATIONAL_ABILITY_RANK[state.constraints.operational_ability]
        >= OPERATIONAL_ABILITY_RANK[card.constraints.minimum_operational_ability],
    )
    .filter((card) => card.compatibility.region_signals.includes(state.constraints.region))
    .filter((card) => state.constraints.existing_stack.every((item) =>
      card.compatibility.stack_signals.includes(item)))
    .filter((card) => state.constraints.lock_in_preference !== "minimize"
      || card.lock_in.level === "low")
    .filter((card) => state.constraints.lock_in_preference !== "balanced"
      || card.lock_in.level !== "high")
    .filter((card) => state.trigger_kind !== "confirmed_constraint_mismatch"
      || card.provider.id !== state.current_provider_id)
    .sort((left, right) => left.card_id.localeCompare(right.card_id))
    .map((card) => explainCard(card, state.constraints));
}

function confirmedMismatches(state) {
  const current = PROVIDER_DECISION_CARDS.find((card) =>
    card.provider.id === state.current_provider_id
    && card.capability_scope.id === state.capability_id,
  );
  if (!current) return [];
  const mismatches = [];
  if (!current.constraints.budgets.includes(state.constraints.budget)) mismatches.push("budget");
  if (!current.constraints.scales.includes(state.constraints.scale)) mismatches.push("scale");
  if (!current.compatibility.region_signals.includes(state.constraints.region)) {
    mismatches.push("region");
  }
  if (state.constraints.existing_stack.some((item) =>
    current.compatibility.incompatible_stack_signals.includes(item))) {
    mismatches.push("existing_stack");
  }
  if (
    OPERATIONAL_ABILITY_RANK[state.constraints.operational_ability]
    < OPERATIONAL_ABILITY_RANK[current.constraints.minimum_operational_ability]
  ) mismatches.push("operational_ability");
  if (
    (state.constraints.lock_in_preference === "minimize" && current.lock_in.level !== "low")
    || (state.constraints.lock_in_preference === "balanced" && current.lock_in.level === "high")
  ) mismatches.push("lock_in_preference");
  return mismatches;
}

async function selectionRequest(state, statePath, token) {
  const shortlist = shortlistFor(state);
  if (shortlist.length === 0) {
    await rm(path.dirname(statePath), { recursive: true, force: true });
    return guidanceResult("completed", {
      outcome: "no_credible_options",
      source_report_id: state.source_report_id,
      trigger: triggerFrom(state),
      constraints: { ...structuredClone(state.constraints), confirmed: true },
      information_boundary: { brands_disclosed: false },
      manifest_intent_changed: false,
      message: "No current Decision Card satisfies the confirmed hard constraints; no Provider was recommended.",
    });
  }
  state.shortlist_card_ids = shortlist.map(({ card }) => card.card_id);
  await saveState(statePath, state);
  return guidanceResult("needs_input", {
    source_report_id: state.source_report_id,
    trigger: triggerFrom(state),
    constraints: { ...structuredClone(state.constraints), confirmed: true },
    information_boundary: { brands_disclosed: true },
    shortlist,
    guidance: {
      advisory: true,
      universal_best_claimed: false,
      live_pricing_guaranteed: false,
      ordering: "card_id",
      information_freshness:
        "Decision Cards were reviewed on their stated review_date; verify official sources before deciding.",
    },
    request: {
      kind: "provider_selection",
      prompt: "Select one Card for a Manifest intent preview, or cancel without choosing.",
      options: shortlist.map(({ card }) => ({
        card_id: card.card_id,
        provider_id: card.provider.id,
        provider_name: card.provider.name,
      })),
    },
    interaction: interaction(state, token),
  });
}

function digest(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function manifestLocation(root) {
  const rootPath = await realpath(root);
  const manifestDirectory = path.join(rootPath, ".launchrally");
  const directoryStat = await lstat(manifestDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw Object.assign(new Error("The LaunchRally directory is not safe."), {
      code: "invalid_manifest_file",
    });
  }
  const manifestPath = path.join(rootPath, MANIFEST_RELATIVE_PATH);
  return { manifestDirectory, manifestPath };
}

async function readManifest(root) {
  const { manifestDirectory, manifestPath } = await manifestLocation(root);
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw Object.assign(new Error("The Launch Manifest is not a regular file."), {
      code: "invalid_manifest_file",
    });
  }
  const canonicalPath = await realpath(manifestPath);
  if (path.dirname(canonicalPath) !== manifestDirectory) {
    throw Object.assign(new Error("The Launch Manifest resolves outside its project directory."), {
      code: "invalid_manifest_file",
    });
  }
  let handle;
  try {
    handle = await open(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile()
      || openedStat.dev !== manifestStat.dev
      || openedStat.ino !== manifestStat.ino
    ) {
      throw Object.assign(new Error("The Launch Manifest changed while it was opened."), {
        code: "invalid_manifest_file",
      });
    }
    const content = await handle.readFile({ encoding: "utf8" });
    const manifest = parseManifest(content);
    assertSupportedManifestVersion(manifest);
    assertValidManifest(manifest);
    const roles = manifest.providers.roles;
    if (
      roles.state === "declared"
      && (
        !Array.isArray(roles.value)
        || roles.value.some((entry) =>
          typeof entry?.provider !== "string"
          || !entry.provider
          || typeof entry?.role !== "string"
          || !entry.role
          || Object.keys(entry).some((key) => !["provider", "role"].includes(key)))
        || new Set(roles.value.map((entry) => `${entry.provider}:${entry.role}`)).size
          !== roles.value.length
      )
    ) {
      throw Object.assign(new Error("The Launch Manifest Provider roles are invalid."), {
        code: "invalid_manifest",
      });
    }
    return { content, manifest, manifestDirectory, manifestPath };
  } finally {
    await handle?.close();
  }
}

function selectedProvider(card) {
  return {
    card_id: card.card_id,
    provider_id: card.provider.id,
    provider_name: card.provider.name,
    provider_role: card.capability_scope.provider_role,
  };
}

function classification() {
  return {
    manifest_intent: true,
    machine_evidence: false,
    verification_status: "unverified",
    passed: false,
  };
}

function manifestWithSelection(manifest, card, sourceReportId) {
  const role = card.capability_scope.provider_role;
  const existing = manifest.providers.roles.state === "declared"
    ? manifest.providers.roles.value
    : [];
  const roles = [
    ...existing.filter((entry) => entry.role !== role),
    { provider: card.provider.id, role },
  ].sort((left, right) =>
    `${left.role}:${left.provider}`.localeCompare(`${right.role}:${right.provider}`),
  );
  const updated = structuredClone(manifest);
  updated.providers.roles = { state: "declared", value: roles };
  updated.providers.decision = {
    schema_version: PROVIDER_INTENT_DECISION_SCHEMA,
    source_report_id: sourceReportId,
    card_id: card.card_id,
    card_version: card.card_version,
    capability_id: card.capability_scope.id,
    provider: card.provider.id,
    role,
    confirmed: true,
  };
  assertValidManifest(updated);
  return updated;
}

function manifestError(error) {
  const unsupported = error?.code === "unsupported_manifest_version";
  return result("execution_error", {
    error: unsupported ? error.code : "invalid_manifest",
    message: unsupported
      ? "The Launch Manifest uses an unsupported future major version."
      : "A valid initialized Launch Manifest is required to record Provider intent.",
  });
}

async function previewSelection(state, statePath, token, selection) {
  const card = PROVIDER_DECISION_CARDS.find((candidate) =>
    candidate.card_id === selection
    && candidate.capability_scope.id === state.capability_id
    && state.shortlist_card_ids?.includes(candidate.card_id),
  );
  if (!card) {
    return result("execution_error", {
      error: "invalid_provider_selection",
      message: "Select one of the Provider Decision Cards in the confirmed shortlist.",
    });
  }
  let current;
  try {
    current = await readManifest(state.root);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return result("unavailable", {
        reason: "initialized_manifest_required",
        source_report_id: state.source_report_id,
        message: "Initialize LaunchRally before confirming a Provider as Manifest intent.",
      });
    }
    return manifestError(error);
  }
  const updated = manifestWithSelection(current.manifest, card, state.source_report_id);
  const after = serializeManifest(updated);
  state.step = "selection_confirmation";
  state.selection = selectedProvider(card);
  state.manifest_before_digest = digest(current.content);
  state.manifest_after = after;
  await saveState(statePath, state);
  return guidanceResult("needs_confirmation", {
    source_report_id: state.source_report_id,
    trigger: triggerFrom(state),
    constraints: { ...structuredClone(state.constraints), confirmed: true },
    information_boundary: { brands_disclosed: true },
    selection: structuredClone(state.selection),
    classification: classification(),
    preview: {
      path: MANIFEST_RELATIVE_PATH,
      before_digest: state.manifest_before_digest,
      after_digest: digest(after),
      before_roles: structuredClone(current.manifest.providers.roles),
      after_roles: structuredClone(updated.providers.roles),
    },
    effects: {
      provider_mutation: "none",
      production_mutation: "none",
    },
    request: {
      kind: "manifest_intent_confirmation",
      prompt: "Confirm this exact local Manifest intent change, or decline without writing.",
      choices: ["confirm", "decline"],
    },
    interaction: interaction(state, token),
  });
}

const MANIFEST_TRANSACTION_DIRECTORY = ".provider-guidance-manifest-transaction";
const OWNER_CREATION_GRACE_MS = 30_000;
const MAX_TRANSACTION_AGE_MS = 300_000;

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function exists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readTransactionOwner(transactionPath) {
  const ownerPath = path.join(transactionPath, "owner.json");
  try {
    const ownerStat = await lstat(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) return null;
    return JSON.parse(await readFile(ownerPath, "utf8"));
  } catch {
    return null;
  }
}

async function recoverStaleManifestTransaction(transactionPath, manifestPath) {
  const transactionStat = await lstat(transactionPath);
  if (!transactionStat.isDirectory() || transactionStat.isSymbolicLink()) return false;
  const previousPath = path.join(transactionPath, "previous.yaml");
  if (!(await exists(manifestPath)) && await exists(previousPath)) {
    try {
      await link(previousPath, manifestPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  if (!(await exists(manifestPath))) return false;
  await rm(transactionPath, { recursive: true, force: true });
  return true;
}

async function acquireManifestTransaction(manifestDirectory, manifestPath, interactionId) {
  const transactionPath = path.join(manifestDirectory, MANIFEST_TRANSACTION_DIRECTORY);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(transactionPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const transactionStat = await lstat(transactionPath);
      const owner = await readTransactionOwner(transactionPath);
      const createdAt = Date.parse(owner?.created_at ?? "");
      const age = Number.isFinite(createdAt)
        ? Date.now() - createdAt
        : Date.now() - transactionStat.mtimeMs;
      const active = owner
        ? processIsRunning(owner.pid) && age < MAX_TRANSACTION_AGE_MS
        : age < OWNER_CREATION_GRACE_MS;
      if (active) {
        return {
          error: result("execution_error", {
            error: "manifest_write_in_progress",
            message:
              "Another Provider Manifest confirmation is in progress. Retry after it finishes; a changed Manifest will require a fresh preview.",
          }),
        };
      }
      if (!await recoverStaleManifestTransaction(transactionPath, manifestPath)) {
        return {
          error: result("execution_error", {
            error: "manifest_transaction_recovery_required",
            message:
              "A stale Provider Manifest transaction could not be recovered automatically; inspect the local .launchrally transaction directory before retrying.",
          }),
        };
      }
      continue;
    }
    try {
      await writeFile(
        path.join(transactionPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, interaction_id: interactionId, created_at: new Date().toISOString() })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      await rm(transactionPath, { recursive: true, force: true });
      throw error;
    }
    return {
      transactionPath,
      nextPath: path.join(transactionPath, "next.yaml"),
      previousPath: path.join(transactionPath, "previous.yaml"),
    };
  }
  return {
    error: result("execution_error", {
      error: "manifest_write_in_progress",
      message: "The Provider Manifest transaction changed while recovery was attempted; retry.",
    }),
  };
}

async function readCapturedManifest(filePath) {
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw Object.assign(new Error("The captured Launch Manifest is not a regular file."), {
      code: "invalid_manifest_file",
    });
  }
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw Object.assign(new Error("The captured Launch Manifest changed while opening."), {
        code: "invalid_manifest_file",
      });
    }
    const content = await handle.readFile({ encoding: "utf8" });
    return content;
  } finally {
    await handle?.close();
  }
}

async function linkIfAbsent(sourcePath, targetPath) {
  try {
    await link(sourcePath, targetPath);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

async function writeConfirmedManifest(state, dependencies = {}) {
  const inspected = await manifestLocation(state.root);
  const transaction = await acquireManifestTransaction(
    inspected.manifestDirectory,
    inspected.manifestPath,
    state.interaction_id,
  );
  if (transaction.error) return transaction.error;
  let manifestCaptured = false;
  try {
    const current = await readManifest(state.root);
    if (digest(current.content) !== state.manifest_before_digest) {
      return result("execution_error", {
        error: "manifest_changed_after_preview",
        message: "The Launch Manifest changed after preview; start Provider guidance again.",
      });
    }
    const card = PROVIDER_DECISION_CARDS.find((candidate) =>
      candidate.card_id === state.selection?.card_id
      && state.shortlist_card_ids?.includes(candidate.card_id),
    );
    if (!card || JSON.stringify(selectedProvider(card)) !== JSON.stringify(state.selection)) {
      return result("execution_error", {
        error: "invalid_interaction_state",
        message: "The Provider selection preview is invalid; start Provider guidance again.",
      });
    }
    const expectedAfter = serializeManifest(
      manifestWithSelection(current.manifest, card, state.source_report_id),
    );
    if (state.manifest_after !== expectedAfter) {
      return result("execution_error", {
        error: "invalid_interaction_state",
        message: "The Provider Manifest preview is invalid; start Provider guidance again.",
      });
    }
    await writeFile(transaction.nextPath, expectedAfter, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await dependencies.before_manifest_commit?.();
    try {
      await rename(current.manifestPath, transaction.previousPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return result("execution_error", {
          error: "manifest_changed_during_confirmation",
          message: "The Launch Manifest changed during confirmation; start Provider guidance again.",
        });
      }
      throw error;
    }
    manifestCaptured = true;
    const captured = await readCapturedManifest(transaction.previousPath);
    if (digest(captured) !== state.manifest_before_digest) {
      await linkIfAbsent(transaction.previousPath, current.manifestPath);
      return result("execution_error", {
        error: "manifest_changed_during_confirmation",
        message: "The Launch Manifest changed during confirmation; start Provider guidance again.",
      });
    }
    if (!await linkIfAbsent(transaction.nextPath, current.manifestPath)) {
      return result("execution_error", {
        error: "manifest_changed_during_confirmation",
        message:
          "Another writer changed the Launch Manifest during confirmation; its version was preserved. Start Provider guidance again.",
      });
    }
    return null;
  } finally {
    if (manifestCaptured && !(await exists(inspected.manifestPath))) {
      try {
        await linkIfAbsent(transaction.previousPath, inspected.manifestPath);
      } catch {
        // Keep the transaction directory as the recoverable copy when restoration fails.
      }
    }
    if (!manifestCaptured || await exists(inspected.manifestPath)) {
      await rm(transaction.transactionPath, { recursive: true, force: true });
    }
  }
}

async function confirmSelection(state, statePath, options, dependencies) {
  if (options.confirmation === "decline") {
    await rm(path.dirname(statePath), { recursive: true, force: true });
    return guidanceResult("completed", {
      outcome: "selection_declined",
      source_report_id: state.source_report_id,
      information_boundary: { brands_disclosed: true },
      manifest_intent_changed: false,
      classification: {
        manifest_intent: false,
        machine_evidence: false,
        verification_status: "unverified",
        passed: false,
      },
      message: "Provider selection was declined; the Launch Manifest was not changed.",
    });
  }
  if (options.confirmation !== "confirm") {
    return result("execution_error", {
      error: "invalid_confirmation",
      message: "Choose confirm or decline for the Provider Manifest intent preview.",
    });
  }
  let writeError;
  try {
    writeError = await writeConfirmedManifest(state, dependencies);
  } catch (error) {
    return manifestError(error);
  }
  if (writeError) return writeError;
  await rm(path.dirname(statePath), { recursive: true, force: true });
  return guidanceResult("completed", {
    outcome: "manifest_intent_recorded",
    source_report_id: state.source_report_id,
    information_boundary: { brands_disclosed: true },
    selection: structuredClone(state.selection),
    classification: classification(),
    effects: {
      manifest_mutation: "confirmed_local_intent_only",
      source_mutation: "none",
      account_creation: "none",
      tool_installation: "none",
      login: "none",
      provisioning: "none",
      provider_mutation: "none",
      production_mutation: "none",
    },
    next: {
      required: true,
      operation: "verify",
      message:
        "Configure the selected Provider outside LaunchRally, then run Verify to recollect Machine Evidence; intent alone cannot Pass a Check.",
    },
  });
}

async function resumeGuidance(cwd, options, dependencies) {
  const loaded = await loadState(options.resume_token);
  if (!loaded) {
    return result("execution_error", {
      error: "invalid_resume_token",
      message: "The Provider guidance interaction token is invalid or expired.",
    });
  }
  const { state, statePath } = loaded;
  if (state.root !== path.resolve(cwd)) {
    return result("execution_error", {
      error: "resume_scope_mismatch",
      message: "The Provider guidance interaction belongs to another repository root.",
    });
  }
  if (state.step === "selection") {
    if (options.confirmation === "cancel") {
      await rm(path.dirname(statePath), { recursive: true, force: true });
      return guidanceResult("completed", {
        outcome: "cancelled",
        source_report_id: state.source_report_id,
        information_boundary: { brands_disclosed: true },
        manifest_intent_changed: false,
        message: "Provider guidance was cancelled without a selection or Manifest change.",
      });
    }
    return previewSelection(state, statePath, options.resume_token, options.selection);
  }
  if (state.step === "selection_confirmation") {
    return confirmSelection(state, statePath, options, dependencies);
  }
  if (state.step === "constraint_confirmation") {
    if (options.confirmation === "revise") {
      state.step = "constraints";
      delete state.constraints;
      await saveState(statePath, state);
      return guidanceResult("needs_input", {
        source_report_id: state.source_report_id,
        trigger: triggerFrom(state),
        information_boundary: { brands_disclosed: false },
        request: {
          kind: "provider_constraints",
          fields: constraintFields(),
          validation_errors: [],
        },
        interaction: interaction(state, options.resume_token),
      });
    }
    if (options.confirmation === "cancel") {
      await rm(path.dirname(statePath), { recursive: true, force: true });
      return guidanceResult("completed", {
        outcome: "cancelled",
        source_report_id: state.source_report_id,
        information_boundary: { brands_disclosed: false },
        manifest_intent_changed: false,
        message: "Provider guidance was cancelled before any brands or Manifest changes.",
      });
    }
    if (options.confirmation !== "confirm") {
      return result("execution_error", {
        error: "invalid_confirmation",
        message: "Choose confirm, revise, or cancel for the Provider constraints.",
      });
    }
    if (state.trigger_kind === "constraint_mismatch_candidate") {
      state.mismatch_constraint_ids = confirmedMismatches(state);
      if (state.mismatch_constraint_ids.length === 0) {
        await rm(path.dirname(statePath), { recursive: true, force: true });
        return guidanceResult("completed", {
          outcome: "no_confirmed_constraint_mismatch",
          source_report_id: state.source_report_id,
          trigger: triggerFrom(state),
          information_boundary: { brands_disclosed: false },
          manifest_intent_changed: false,
          message: "The confirmed constraints do not conflict with the current Provider Decision Card, so no alternatives were recommended.",
        });
      }
      state.trigger_kind = "confirmed_constraint_mismatch";
    }
    state.step = "selection";
    return selectionRequest(state, statePath, options.resume_token);
  }
  if (state.step !== "constraints") {
    return result("execution_error", {
      error: "invalid_interaction_state",
      message: "The Provider guidance interaction is not waiting for constraints.",
    });
  }
  const normalized = normalizeConstraints(options.constraints);
  if (normalized.validationErrors.length > 0) {
    return guidanceResult("needs_input", {
      source_report_id: state.source_report_id,
      trigger: triggerFrom(state),
      information_boundary: { brands_disclosed: false },
      request: {
        kind: "provider_constraints",
        fields: constraintFields(),
        validation_errors: normalized.validationErrors,
      },
      interaction: interaction(state, options.resume_token),
    });
  }
  state.constraints = normalized.constraints;
  state.step = "constraint_confirmation";
  await saveState(statePath, state);
  return guidanceResult("needs_confirmation", {
    source_report_id: state.source_report_id,
    trigger: triggerFrom(state),
    constraints: { ...structuredClone(state.constraints), confirmed: false },
    information_boundary: { brands_disclosed: false },
    request: {
      kind: "constraint_confirmation",
      prompt: "Confirm these six constraints before LaunchRally discloses Provider brands.",
      choices: ["confirm", "revise", "cancel"],
    },
    interaction: interaction(state, options.resume_token),
  });
}

function validateReport(cwd, reportPackage, dependencies) {
  try {
    if (typeof reportPackage?.report?.schema_version === "string") {
      assertSupportedReportVersion(reportPackage.report);
    }
    assertValidReportPackage(reportPackage);
  } catch (error) {
    return result("execution_error", {
      error: error?.code ?? "invalid_report_package",
      message: error?.code === "unsupported_report_version"
        ? "The saved Report uses an unsupported future major version."
        : "The saved Audit JSON is incomplete or invalid; Provider guidance was not started.",
    });
  }
  if (!reportPackage.report.scope.release_intent.confirmed) {
    return result("unavailable", {
      reason: "confirmed_release_required",
      source_report_id: reportPackage.report.report_id,
      message: "Provider guidance requires confirmed release intent from a complete Audit.",
    });
  }
  const currentness = evaluateReportCurrentness(reportPackage, {
    cwd,
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  if (!currentness.current) {
    return createNeedsRefreshResult(
      "providers",
      reportPackage.report.report_id,
      "Provider guidance requires a current Report; run full Verify first.",
    );
  }
  return null;
}

export async function runProviderGuidance(cwd, reportPackage, options = {}, dependencies = {}) {
  if (!reportPackage && !options.resume_token) {
    return result("unavailable", {
      reason: "complete_report_required",
      message: "Supply a complete current Audit Report before requesting Provider guidance.",
    });
  }
  if (options.resume_token) {
    return resumeGuidance(cwd, options, dependencies);
  }
  const reportError = validateReport(cwd, reportPackage, dependencies);
  if (reportError) return reportError;

  const report = reportPackage.report;
  const source = report.results.checks.find(
    (check) => check.check_id === options.source_check_id,
  );
  const capabilityId = CAPABILITY_BY_CHECK[options.source_check_id];
  const providerRole = typeof options.provider_role === "string"
    ? options.provider_role.trim().toLowerCase()
    : "";
  const currentProvider = report.scope.release_intent.provider_roles.find(
    (entry) => entry.role === providerRole,
  );
  const roleCapabilityId = CAPABILITY_BY_ROLE[providerRole];
  const currentCard = PROVIDER_DECISION_CARDS.find((card) =>
    card.provider.id === currentProvider?.provider
    && card.capability_scope.id === roleCapabilityId,
  );
  const sourceAction = report.results.action_queue.find(
    (action) => action.check_id === source?.check_id,
  );
  const sourceDeclaration = report.catalog.checks.find(
    (declaration) => declaration.check_id === source?.check_id,
  );
  const evidencedGap = source?.status === "failed"
    && capabilityId
    && sourceAction
    && sourceDeclaration
    && source.check_version === sourceDeclaration.check_version
    && source.risk_domain === sourceDeclaration.risk_domain
    && source.severity === sourceDeclaration.severity_policy.severity
    && source.release_gate === sourceDeclaration.release_gate_policy.gate
    && sourceAction.priority === source.priority
    && sourceAction.severity === source.severity
    && sourceAction.gating === source.gating;
  const mismatchCandidate = !options.source_check_id
    && currentProvider
    && roleCapabilityId
    && currentCard;
  if (!evidencedGap && !mismatchCandidate) {
    return result("unavailable", {
      reason: "evidenced_capability_gap_required",
      source_report_id: report.report_id,
      message: "Provider guidance starts only from a supported failed Check or an existing Provider role that can be checked against confirmed constraints.",
    });
  }

  const state = {
    schema_version: PROVIDER_GUIDANCE_INTERACTION_SCHEMA,
    interaction_id: randomUUID(),
    root: path.resolve(cwd),
    source_report_id: report.report_id,
    trigger_kind: evidencedGap
      ? "evidenced_capability_gap"
      : "constraint_mismatch_candidate",
    ...(evidencedGap
      ? {
        source_check_id: source.check_id,
        source_summary: source.summary,
      }
      : {
        current_provider_id: currentProvider.provider,
        current_provider_role: currentProvider.role,
      }),
    capability_id: evidencedGap ? capabilityId : roleCapabilityId,
    step: "constraints",
  };
  return guidanceResult("needs_input", {
    source_report_id: report.report_id,
    trigger: triggerFrom(state),
    information_boundary: {
      brands_disclosed: false,
    },
    request: {
      kind: "provider_constraints",
      fields: constraintFields(),
      validation_errors: [],
    },
    interaction: interaction(state, await storeState(state)),
  });
}
