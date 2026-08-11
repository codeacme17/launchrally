import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertValidProviderDecisionCard,
  assertValidProviderGuidance,
} from "../packages/contracts/src/index.js";
import { runAudit, runProviderGuidance, runVerify } from "../packages/core/src/index.js";
import { simulateExtendedMkdtempSuffix } from "./helpers/temporary-state-token.js";

const execFileAsync = promisify(execFile);
const cli = path.resolve("packages/cli/bin/engine.js");
const ANSWERS = Object.freeze({
  intended_environment: "production",
  production_targets: ["https://launchrally-provider-guidance.invalid/"],
  core_journeys: ["homepage loads"],
  provider_roles: [],
  support_layers: [],
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-providers-"));
  await writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify({
      name: "provider-guidance-web",
      scripts: { build: "node build.js" },
    }, null, 2)}\n`,
  );
  await writeFile(
    path.join(directory, "package-lock.json"),
    `${JSON.stringify({ name: "provider-guidance-web", lockfileVersion: 3 }, null, 2)}\n`,
  );
  return directory;
}

async function completeAudit(directory, { providerRoles = [] } = {}) {
  const answers = { ...ANSWERS, provider_roles: providerRoles };
  const initial = await runAudit(directory, "0.1.0");
  const confirmation = await runAudit(directory, "0.1.0", {
    resume_token: initial.interaction.resume_token,
    answers,
  });
  const permission = await runAudit(directory, "0.1.0", {
    resume_token: confirmation.interaction.resume_token,
    confirmation: "confirm",
  });
  return runAudit(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: {
      public_verification: "approved",
      ...Object.fromEntries(providerRoles.map(({ provider }) => [
        `provider_read:${provider}`,
        "denied",
      ])),
    },
  });
}

async function runCli(arguments_) {
  const { stdout } = await execFileAsync(process.execPath, [cli, ...arguments_], {
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

async function runCliOutcome(arguments_) {
  try {
    return { exitCode: 0, value: await runCli(arguments_) };
  } catch (error) {
    return {
      exitCode: error.code,
      value: JSON.parse(error.stdout),
    };
  }
}

async function startGuidance(directory, audit) {
  const reportPath = path.join(
    await mkdtemp(path.join(os.tmpdir(), "launchrally-provider-report-")),
    "audit.json",
  );
  await writeFile(reportPath, `${JSON.stringify(audit)}\n`);
  return runCli([
    "providers",
    "--cwd",
    directory,
    "--report",
    reportPath,
    "--gap",
    "web.public.availability",
    "--json",
  ]);
}

async function submitConstraints(directory, token, overrides = {}) {
  return runCli([
    "providers",
    "--cwd",
    directory,
    "--resume",
    token,
    "--constraints",
    JSON.stringify({
      budget: "cost_sensitive",
      scale: "growing",
      region: "global",
      existing_stack: ["Node.js", "Astro", "node.js"],
      operational_ability: "minimal",
      lock_in_preference: "balanced",
      ...overrides,
    }),
    "--json",
  ]);
}

async function startMismatchGuidance(directory, audit) {
  const reportPath = path.join(
    await mkdtemp(path.join(os.tmpdir(), "launchrally-provider-report-")),
    "mismatch-audit.json",
  );
  await writeFile(reportPath, `${JSON.stringify(audit)}\n`);
  return runCli([
    "providers",
    "--cwd",
    directory,
    "--report",
    reportPath,
    "--role",
    "deployment",
    "--json",
  ]);
}

async function confirmedShortlist(directory, audit) {
  const initial = await startGuidance(directory, audit);
  const confirmation = await submitConstraints(directory, initial.interaction.resume_token);
  return runCli([
    "providers",
    "--cwd",
    directory,
    "--resume",
    confirmation.interaction.resume_token,
    "--confirm",
    "confirm",
    "--json",
  ]);
}

async function writeInitializedManifest(directory, audit) {
  const intent = audit.report.scope.release_intent;
  const declared = (value) => ({ state: "declared", value });
  const manifest = {
    schema_version: "launchrally.dev/manifest/v2",
    project: {
      name: declared(audit.report.scope.project.name),
      type: declared(audit.report.scope.project.type),
      package_manager: declared(audit.report.scope.project.package_manager),
    },
    release: {
      intended_environment: declared(intent.intended_environment),
      production_targets: declared(intent.production_targets),
      core_journeys: declared(intent.core_journeys),
    },
    execution: {
      source_report_id: declared(audit.report.report_id),
      assessment: declared(audit.report.assessment),
      public_verification: declared({
        decision: audit.report.scope.public_verification.decision,
        targets: audit.report.scope.public_verification.targets,
      }),
    },
    support: {
      layers: {
        state: "not_applicable",
        reason: "No support layers were declared for this release.",
        evidence: [{
          source_report_id: audit.report.report_id,
          field: "scope.release_intent.support_layers",
        }],
      },
    },
    providers: {
      roles: {
        state: "not_applicable",
        reason: "No Provider roles were declared for this release.",
        evidence: [{
          source_report_id: audit.report.report_id,
          field: "scope.release_intent.provider_roles",
        }],
      },
    },
  };
  await mkdir(path.join(directory, ".launchrally"));
  await writeFile(
    path.join(directory, ".launchrally", "manifest.yaml"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

test("Provider guidance starts from an evidenced capability gap without disclosing brands", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const result = await startGuidance(directory, audit);

  assert.equal(result.contract, "launchrally.dev/cli/v2");
  assert.equal(result.status, "needs_input");
  assert.equal(result.operation, "providers");
  assert.deepEqual(result.trigger, {
    kind: "evidenced_capability_gap",
    source_report_id: audit.report.report_id,
    check_id: "web.public.availability",
    check_status: "failed",
    capability_id: "managed_web_delivery",
    summary: "Public availability verification failed.",
  });
  assert.equal(result.information_boundary.brands_disclosed, false);
  assert.deepEqual(
    result.request.fields.map(({ field_id: fieldId }) => fieldId),
    [
      "budget",
      "scale",
      "region",
      "existing_stack",
      "operational_ability",
      "lock_in_preference",
    ],
  );
  assert.equal(
    result.request.fields.find(({ field_id: fieldId }) => fieldId === "existing_stack")
      .candidates.includes("long_running_server"),
    true,
  );
  assert.equal(JSON.stringify(result).toLowerCase().includes("cloudflare"), false);
  assert.equal(JSON.stringify(result).includes("Cloudflare"), false);
  assert.equal(JSON.stringify(result).includes("Vercel"), false);
  assert.equal(result.interaction.schema_version, "launchrally.dev/provider-guidance-interaction/v1");
  assert.equal(typeof result.interaction.resume_token, "string");
  const leaked = structuredClone(result);
  leaked.information_boundary.brands_disclosed = true;
  assert.throws(
    () => assertValidProviderGuidance(leaked),
    (error) => error.code === "invalid_provider_guidance",
  );
});

test("all six Provider constraints are validated and shown for confirmation before brands", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const initial = await startGuidance(directory, audit);
  const token = initial.interaction.resume_token;

  const incomplete = await runCli([
    "providers",
    "--cwd",
    directory,
    "--resume",
    token,
    "--constraints",
    JSON.stringify({ budget: "cost_sensitive" }),
    "--json",
  ]);

  assert.equal(incomplete.status, "needs_input");
  assert.deepEqual(
    incomplete.request.validation_errors.map(({ field_id: fieldId }) => fieldId),
    ["scale", "region", "existing_stack", "operational_ability", "lock_in_preference"],
  );
  assert.equal(JSON.stringify(incomplete).includes("Cloudflare"), false);
  assert.equal(JSON.stringify(incomplete).includes("Vercel"), false);

  const confirmation = await submitConstraints(directory, token);

  assert.equal(confirmation.status, "needs_confirmation");
  assert.deepEqual(confirmation.constraints, {
    budget: "cost_sensitive",
    scale: "growing",
    region: "global",
    existing_stack: ["astro", "node.js"],
    operational_ability: "minimal",
    lock_in_preference: "balanced",
    confirmed: false,
  });
  assert.equal(confirmation.information_boundary.brands_disclosed, false);
  assert.equal(confirmation.request.kind, "constraint_confirmation");
  assert.deepEqual(confirmation.request.choices, ["confirm", "revise", "cancel"]);
  assert.equal(confirmation.interaction.step, "constraint_confirmation");
  assert.equal(JSON.stringify(confirmation).includes("Cloudflare"), false);
  assert.equal(JSON.stringify(confirmation).includes("Vercel"), false);
});

test("Provider guidance accepts a portable token when mkdtemp preserves its placeholder", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const initial = await startGuidance(directory, audit);
  const portableToken = await simulateExtendedMkdtempSuffix(
    initial.interaction.resume_token,
    "providers",
  );

  const result = await runCli([
    "providers",
    "--cwd",
    directory,
    "--resume",
    portableToken,
    "--constraints",
    JSON.stringify({ budget: "cost_sensitive" }),
    "--json",
  ]);

  assert.equal(result.status, "needs_input");
  assert.equal(result.operation, "providers");
});

test("confirmed constraints produce a small explainable shortlist from versioned Decision Cards", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const initial = await startGuidance(directory, audit);
  const constraintConfirmation = await submitConstraints(
    directory,
    initial.interaction.resume_token,
  );

  const result = await runCli([
    "providers",
    "--cwd",
    directory,
    "--resume",
    constraintConfirmation.interaction.resume_token,
    "--confirm",
    "confirm",
    "--json",
  ]);

  assert.equal(result.status, "needs_input");
  assert.equal(result.operation, "providers");
  assert.equal(result.schema_version, "launchrally.dev/provider-guidance/v2");
  assert.equal(result.constraints.confirmed, true);
  assert.equal(result.information_boundary.brands_disclosed, true);
  assert.equal(assertValidProviderGuidance(result), true);
  assert.equal(result.shortlist.length, 2);
  assert.deepEqual(
    result.shortlist.map(({ card }) => card.card_id),
    [
      "managed-web-delivery.cloudflare-workers",
      "managed-web-delivery.vercel",
    ],
  );
  for (const option of result.shortlist) {
    assert.equal(assertValidProviderDecisionCard(option.card), true);
    assert.equal(option.reasons.length > 0, true);
    assert.equal(option.limits.length > 0, true);
    assert.equal(option.card.capability_scope.id, "managed_web_delivery");
    assert.equal(option.card.cost_model.live_pricing_guaranteed, false);
    assert.equal(option.card.official_sources.length >= 3, true);
    assert.equal(option.card.unknowns.length > 0, true);
    assert.match(option.card.review_date, /^\d{4}-\d{2}-\d{2}$/u);
  }
  assert.deepEqual(result.guidance, {
    advisory: true,
    universal_best_claimed: false,
    live_pricing_guaranteed: false,
    ordering: "card_id",
    information_freshness:
      "Decision Cards were reviewed on their stated review_date; verify official sources before deciding.",
  });
  assert.equal(result.request.kind, "provider_selection");
  assert.deepEqual(
    result.request.options.map(({ card_id: cardId }) => cardId),
    result.shortlist.map(({ card }) => card.card_id),
  );
  assert.equal(result.interaction.step, "selection");
  assert.throws(
    () => assertValidProviderGuidance({
      contract: "launchrally.dev/cli/v2",
      schema_version: "launchrally.dev/provider-guidance/v2",
      status: "completed",
      operation: "providers",
      source_report_id: audit.report.report_id,
    }),
    (error) => error.code === "invalid_provider_guidance",
  );
  for (const invalid of [
    { ...structuredClone(result), information_boundary: { brands_disclosed: false } },
    { ...structuredClone(result), constraints: { ...result.constraints, confirmed: false } },
    {
      ...structuredClone(result),
      shortlist: [{ ...structuredClone(result.shortlist[0]), card: {} }],
    },
  ]) {
    assert.throws(
      () => assertValidProviderGuidance(invalid),
      (error) => error.code === "invalid_provider_guidance",
    );
  }
});

test("a selected Provider becomes confirmed Manifest intent but not Machine Evidence or Passed", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const initializedManifest = await writeInitializedManifest(directory, audit);
  const shortlist = await confirmedShortlist(directory, audit);
  const manifestPath = path.join(directory, ".launchrally", "manifest.yaml");
  const before = await readFile(manifestPath, "utf8");

  const preview = await runCli([
    "providers",
    "--cwd",
    directory,
    "--resume",
    shortlist.interaction.resume_token,
    "--select",
    "managed-web-delivery.vercel",
    "--json",
  ]);

  assert.equal(preview.status, "needs_confirmation");
  assert.deepEqual(preview.selection, {
    card_id: "managed-web-delivery.vercel",
    provider_id: "vercel",
    provider_name: "Vercel",
    provider_role: "deployment",
  });
  assert.deepEqual(preview.classification, {
    manifest_intent: true,
    machine_evidence: false,
    verification_status: "unverified",
    passed: false,
  });
  assert.equal(preview.preview.path, ".launchrally/manifest.yaml");
  assert.deepEqual(preview.preview.after_roles, {
    state: "declared",
    value: [{ provider: "vercel", role: "deployment" }],
  });
  assert.equal(await readFile(manifestPath, "utf8"), before);
  assert.equal(preview.interaction.step, "selection_confirmation");

  const completed = await runCli([
    "providers",
    "--cwd",
    directory,
    "--resume",
    preview.interaction.resume_token,
    "--confirm",
    "confirm",
    "--json",
  ]);

  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome, "manifest_intent_recorded");
  assert.deepEqual(completed.classification, preview.classification);
  assert.deepEqual(completed.effects, {
    manifest_mutation: "confirmed_local_intent_only",
    source_mutation: "none",
    account_creation: "none",
    tool_installation: "none",
    login: "none",
    provisioning: "none",
    provider_mutation: "none",
    production_mutation: "none",
  });
  assert.deepEqual(completed.next, {
    required: true,
    operation: "verify",
    message:
      "Configure the selected Provider outside LaunchRally, then run Verify to recollect Machine Evidence; intent alone cannot Pass a Check.",
  });
  assert.throws(
    () => assertValidProviderGuidance({ ...structuredClone(completed), effects: {} }),
    (error) => error.code === "invalid_provider_guidance",
  );
  const recordedManifest = await readFile(manifestPath, "utf8");
  assert.match(recordedManifest, /roles:\n\s+state: "declared"\n\s+value:\n/u);
  assert.match(recordedManifest, /provider: "vercel"\n\s+role: "deployment"/u);
  assert.match(
    recordedManifest,
    /decision:\n\s+schema_version: "launchrally\.dev\/provider-intent-decision\/v1"/u,
  );
  assert.match(recordedManifest, /card_id: "managed-web-delivery\.vercel"/u);
  assert.match(recordedManifest, /confirmed: true/u);

  const verifyPermission = await runVerify(directory, "0.1.0", {
    report_package: audit,
    scope: "full",
  });
  const verified = await runVerify(directory, "0.1.0", {
    resume_token: verifyPermission.interaction.resume_token,
    permission_decisions: {
      public_verification: "denied",
      "provider_read:vercel": "denied",
    },
  });
  assert.equal(
    verified.manifest_drift.some(({ field }) => field === "providers.roles"),
    false,
  );
  assert.equal(verified.report.policy.current, true);
  assert.equal(
    verified.report.results.checks.find(
      ({ check_id: checkId }) => checkId === "provider.vercel.metadata",
    ).status,
    "unverified",
  );

  const tamperedManifest = structuredClone(initializedManifest);
  tamperedManifest.providers.roles = {
    state: "declared",
    value: [{ provider: "vercel", role: "deployment" }],
  };
  tamperedManifest.providers.decision = {
    schema_version: "launchrally.dev/provider-intent-decision/v1",
    source_report_id: audit.report.report_id,
    card_id: "managed-web-delivery.nonexistent",
    card_version: "1.0.0",
    capability_id: "managed_web_delivery",
    provider: "vercel",
    role: "deployment",
    confirmed: true,
  };
  await writeFile(manifestPath, `${JSON.stringify(tamperedManifest, null, 2)}\n`);
  const tamperedPermission = await runVerify(directory, "0.1.0", {
    report_package: audit,
    scope: "full",
  });
  const tampered = await runVerify(directory, "0.1.0", {
    resume_token: tamperedPermission.interaction.resume_token,
    permission_decisions: {
      public_verification: "denied",
      "provider_read:vercel": "denied",
    },
  });
  assert.equal(
    tampered.manifest_drift.some(({ field }) => field === "providers.roles"),
    true,
  );
  assert.equal(tampered.report.policy.current, false);
});

test("confirmed constraints can trigger alternatives for an existing Provider mismatch", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory, {
    providerRoles: [{ provider: "vercel", role: "deployment" }],
  });
  const initial = await startMismatchGuidance(directory, audit);

  assert.equal(initial.status, "needs_input");
  assert.equal(initial.trigger.kind, "constraint_mismatch_candidate");
  assert.equal(initial.trigger.current_provider_id, "vercel");
  assert.equal(initial.information_boundary.brands_disclosed, false);

  const constraintConfirmation = await submitConstraints(
    directory,
    initial.interaction.resume_token,
    {
      existing_stack: ["Cloudflare Workers runtime"],
      lock_in_preference: "balanced",
    },
  );
  const result = await runCli([
    "providers",
    "--cwd",
    directory,
    "--resume",
    constraintConfirmation.interaction.resume_token,
    "--confirm",
    "confirm",
    "--json",
  ]);

  assert.equal(result.status, "needs_input");
  assert.deepEqual(result.trigger, {
    kind: "confirmed_constraint_mismatch",
    source_report_id: audit.report.report_id,
    current_provider_id: "vercel",
    provider_role: "deployment",
    capability_id: "managed_web_delivery",
    constraint_ids: ["existing_stack"],
    summary:
      "Confirmed Provider constraints conflict with the current vercel deployment intent.",
  });
  assert.deepEqual(
    result.shortlist.map(({ card }) => card.card_id),
    ["managed-web-delivery.cloudflare-workers"],
  );
});

test("Human Mode keeps capability and constraints ahead of an advisory Provider shortlist", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const reportPath = path.join(
    await mkdtemp(path.join(os.tmpdir(), "launchrally-provider-report-")),
    "human-audit.json",
  );
  await writeFile(reportPath, `${JSON.stringify(audit)}\n`);

  const initial = await execFileAsync(process.execPath, [
    cli,
    "providers",
    "--cwd",
    directory,
    "--report",
    reportPath,
    "--gap",
    "web.public.availability",
  ], { encoding: "utf8" });

  assert.match(initial.stdout, /LaunchRally Advisory Provider Guidance/u);
  assert.match(initial.stdout, /Capability: managed_web_delivery/u);
  assert.match(initial.stdout, /Confirm the available Provider budget/u);
  assert.doesNotMatch(initial.stdout, /Cloudflare|Vercel/u);

  const structuredInitial = await startGuidance(directory, audit);
  const confirmation = await submitConstraints(
    directory,
    structuredInitial.interaction.resume_token,
  );
  const shortlist = await execFileAsync(process.execPath, [
    cli,
    "providers",
    "--cwd",
    directory,
    "--resume",
    confirmation.interaction.resume_token,
    "--confirm",
    "confirm",
  ], { encoding: "utf8" });

  assert.match(shortlist.stdout, /Advisory shortlist — no universal best Provider/u);
  assert.match(shortlist.stdout, /Cloudflare Workers/u);
  assert.match(shortlist.stdout, /Vercel/u);
  assert.match(shortlist.stdout, /Reasons:/u);
  assert.match(shortlist.stdout, /Limits and caveats:/u);
  assert.match(shortlist.stdout, /Official sources:/u);
  assert.match(shortlist.stdout, /Live pricing is not guaranteed/u);
});

test("generic requests and non-mismatching Provider intent never produce recommendations", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const reportPath = path.join(
    await mkdtemp(path.join(os.tmpdir(), "launchrally-provider-report-")),
    "generic-audit.json",
  );
  await writeFile(reportPath, `${JSON.stringify(audit)}\n`);

  for (const triggerArguments of [
    [],
    ["--gap", "web.baseline.build-command"],
    ["--gap", "web.baseline.package-manifest"],
    ["--gap", "web.baseline.runtime-inputs"],
  ]) {
    const outcome = await runCliOutcome([
      "providers",
      "--cwd",
      directory,
      "--report",
      reportPath,
      ...triggerArguments,
      "--json",
    ]);
    assert.equal(outcome.exitCode, 2);
    assert.equal(outcome.value.status, "unavailable");
    assert.equal(outcome.value.reason, "evidenced_capability_gap_required");
    assert.equal(JSON.stringify(outcome.value).includes("Cloudflare"), false);
    assert.equal(JSON.stringify(outcome.value).includes("Vercel"), false);
  }

  const existingAudit = await completeAudit(directory, {
    providerRoles: [{ provider: "vercel", role: "deployment" }],
  });
  const initial = await startMismatchGuidance(directory, existingAudit);
  const confirmation = await submitConstraints(
    directory,
    initial.interaction.resume_token,
    { lock_in_preference: "balanced" },
  );
  const noMismatch = await runCli([
    "providers",
    "--cwd",
    directory,
    "--resume",
    confirmation.interaction.resume_token,
    "--confirm",
    "confirm",
    "--json",
  ]);

  assert.equal(noMismatch.outcome, "no_confirmed_constraint_mismatch");
  assert.equal(assertValidProviderGuidance(noMismatch), true);
  assert.equal(noMismatch.information_boundary.brands_disclosed, false);
  assert.equal(noMismatch.manifest_intent_changed, false);
  assert.equal("shortlist" in noMismatch, false);
});

test("an unproven required region triggers a mismatch without inventing a compatible option", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory, {
    providerRoles: [{ provider: "vercel", role: "deployment" }],
  });
  const initial = await startMismatchGuidance(directory, audit);
  const confirmation = await submitConstraints(
    directory,
    initial.interaction.resume_token,
    { region: "specific_or_residency", lock_in_preference: "balanced" },
  );
  const result = await runCli([
    "providers",
    "--cwd",
    directory,
    "--resume",
    confirmation.interaction.resume_token,
    "--confirm",
    "confirm",
    "--json",
  ]);

  assert.equal(assertValidProviderGuidance(result), true);
  assert.equal(result.outcome, "no_credible_options");
  assert.deepEqual(result.trigger.constraint_ids, ["region"]);
  assert.equal(result.information_boundary.brands_disclosed, false);
  assert.equal(result.manifest_intent_changed, false);
});

test("gap shortlists reject Cards that conflict with confirmed compatibility constraints", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const initial = await startGuidance(directory, audit);
  const confirmation = await submitConstraints(
    directory,
    initial.interaction.resume_token,
    {
      region: "specific_or_residency",
      existing_stack: ["long-running server"],
      lock_in_preference: "balanced",
    },
  );
  const result = await runCli([
    "providers",
    "--cwd",
    directory,
    "--resume",
    confirmation.interaction.resume_token,
    "--confirm",
    "confirm",
    "--json",
  ]);

  assert.equal(result.outcome, "no_credible_options");
  assert.equal(result.trigger.kind, "evidenced_capability_gap");
  assert.equal(result.information_boundary.brands_disclosed, false);
  assert.equal(JSON.stringify(result).includes("Cloudflare"), false);
  assert.equal(JSON.stringify(result).includes("Vercel"), false);
});

test("selection decline and stale previews fail closed without overwriting the Manifest", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  await writeInitializedManifest(directory, audit);
  const manifestPath = path.join(directory, ".launchrally", "manifest.yaml");
  const before = await readFile(manifestPath, "utf8");
  const shortlist = await confirmedShortlist(directory, audit);
  const preview = await runCli([
    "providers",
    "--cwd",
    directory,
    "--resume",
    shortlist.interaction.resume_token,
    "--select",
    "managed-web-delivery.cloudflare-workers",
    "--json",
  ]);
  const declined = await runCli([
    "providers",
    "--cwd",
    directory,
    "--resume",
    preview.interaction.resume_token,
    "--confirm",
    "decline",
    "--json",
  ]);

  assert.equal(declined.outcome, "selection_declined");
  assert.equal(assertValidProviderGuidance(declined), true);
  assert.equal(declined.manifest_intent_changed, false);
  assert.equal(await readFile(manifestPath, "utf8"), before);

  const nextShortlist = await confirmedShortlist(directory, audit);
  const nextPreview = await runCli([
    "providers",
    "--cwd",
    directory,
    "--resume",
    nextShortlist.interaction.resume_token,
    "--select",
    "managed-web-delivery.vercel",
    "--json",
  ]);
  const externallyChanged = `${before.trimEnd()}\n\n`;
  await writeFile(manifestPath, externallyChanged);
  const stale = await runCliOutcome([
    "providers",
    "--cwd",
    directory,
    "--resume",
    nextPreview.interaction.resume_token,
    "--confirm",
    "confirm",
    "--json",
  ]);

  assert.equal(stale.exitCode, 2);
  assert.equal(stale.value.error, "manifest_changed_after_preview");
  assert.equal(await readFile(manifestPath, "utf8"), externallyChanged);
});

test("a non-cooperating Manifest write during confirmation is preserved", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  await writeInitializedManifest(directory, audit);
  const shortlist = await confirmedShortlist(directory, audit);
  const preview = await runCli([
    "providers",
    "--cwd",
    directory,
    "--resume",
    shortlist.interaction.resume_token,
    "--select",
    "managed-web-delivery.vercel",
    "--json",
  ]);
  const manifestPath = path.join(directory, ".launchrally", "manifest.yaml");
  const before = await readFile(manifestPath, "utf8");
  const externallyChanged = `${before.trimEnd()}\n\n`;
  const outcome = await runProviderGuidance(
    directory,
    null,
    {
      resume_token: preview.interaction.resume_token,
      confirmation: "confirm",
    },
    {
      before_manifest_commit: () => writeFile(manifestPath, externallyChanged),
    },
  );

  assert.equal(outcome.status, "execution_error");
  assert.equal(outcome.error, "manifest_changed_during_confirmation");
  assert.equal(await readFile(manifestPath, "utf8"), externallyChanged);
  await assert.rejects(readFile(path.join(
    directory,
    ".launchrally",
    ".provider-guidance-manifest-transaction",
    "owner.json",
  )));
});

test("a stale crashed Manifest transaction is recovered automatically", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  await writeInitializedManifest(directory, audit);
  const shortlist = await confirmedShortlist(directory, audit);
  const preview = await runCli([
    "providers",
    "--cwd",
    directory,
    "--resume",
    shortlist.interaction.resume_token,
    "--select",
    "managed-web-delivery.vercel",
    "--json",
  ]);
  const transactionPath = path.join(
    directory,
    ".launchrally",
    ".provider-guidance-manifest-transaction",
  );
  await mkdir(transactionPath, { mode: 0o700 });
  await writeFile(
    path.join(transactionPath, "owner.json"),
    `${JSON.stringify({
      pid: 2_147_483_647,
      interaction_id: "crashed",
      created_at: "2026-08-06T00:00:00.000Z",
    })}\n`,
    { mode: 0o600 },
  );
  await rename(
    path.join(directory, ".launchrally", "manifest.yaml"),
    path.join(transactionPath, "previous.yaml"),
  );

  const completed = await runCli([
    "providers",
    "--cwd",
    directory,
    "--resume",
    preview.interaction.resume_token,
    "--confirm",
    "confirm",
    "--json",
  ]);

  assert.equal(completed.outcome, "manifest_intent_recorded");
  await assert.rejects(readFile(path.join(transactionPath, "owner.json")));
});

test("hard constraints bound the offered Cards and unoffered selections are rejected", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  await writeInitializedManifest(directory, audit);
  const initial = await startGuidance(directory, audit);
  const confirmation = await submitConstraints(
    directory,
    initial.interaction.resume_token,
    { budget: "free_tier_required", lock_in_preference: "balanced" },
  );
  const shortlist = await runCli([
    "providers",
    "--cwd",
    directory,
    "--resume",
    confirmation.interaction.resume_token,
    "--confirm",
    "confirm",
    "--json",
  ]);

  assert.deepEqual(
    shortlist.shortlist.map(({ card }) => card.card_id),
    ["managed-web-delivery.cloudflare-workers", "managed-web-delivery.vercel"],
  );
  const manifestPath = path.join(directory, ".launchrally", "manifest.yaml");
  const before = await readFile(manifestPath, "utf8");
  const rejected = await runCliOutcome([
    "providers",
    "--cwd",
    directory,
    "--resume",
    shortlist.interaction.resume_token,
    "--select",
    "managed-web-delivery.unknown",
    "--json",
  ]);

  assert.equal(rejected.exitCode, 2);
  assert.equal(rejected.value.error, "invalid_provider_selection");
  assert.equal(await readFile(manifestPath, "utf8"), before);

  const cancelled = await runCli([
    "providers",
    "--cwd",
    directory,
    "--resume",
    shortlist.interaction.resume_token,
    "--confirm",
    "cancel",
    "--json",
  ]);
  assert.equal(cancelled.outcome, "cancelled");
  assert.equal(assertValidProviderGuidance(cancelled), true);
  assert.equal(cancelled.manifest_intent_changed, false);
  assert.equal(await readFile(manifestPath, "utf8"), before);
});
