import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  CLI_INTERACTION_CONTRACT,
  INIT_INTERACTION_SCHEMA,
  MANIFEST_SCHEMA,
  REPORT_SCHEMA,
  assertValidCliInteraction,
  assertValidReportPackage,
} from "../packages/contracts/src/index.js";
import {
  runAudit,
  runInit,
} from "../packages/core/src/index.js";
import { prepareExactToolchainChanges as prepareNpmChanges } from "./helpers/exact-toolchain.js";

const ANSWERS = Object.freeze({
  intended_environment: "production",
  production_targets: ["https://example.com"],
  core_journeys: ["homepage loads"],
  provider_roles: [],
  support_layers: [],
});
const execFileAsync = promisify(execFile);
const cli = path.resolve("packages/cli/bin/rally.js");

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-contract-v2-"));
  await writeFile(path.join(directory, "package.json"), `${JSON.stringify({
    name: "contract-v2-web",
    scripts: { build: "vite build" },
  }, null, 2)}\n`);
  await writeFile(path.join(directory, "package-lock.json"), `${JSON.stringify({
    name: "contract-v2-web",
    lockfileVersion: 3,
    packages: { "": {} },
  }, null, 2)}\n`);
  return directory;
}

async function completeAudit(directory, finalOptions = {}) {
  const initial = await runAudit(directory, "0.1.0");
  const confirmation = await runAudit(directory, "0.1.0", {
    resume_token: initial.interaction.resume_token,
    answers: ANSWERS,
  });
  const permission = await runAudit(directory, "0.1.0", {
    resume_token: confirmation.interaction.resume_token,
    confirmation: "confirm",
  });
  return runAudit(directory, "0.1.0", {
    resume_token: permission.interaction.resume_token,
    permission_decisions: { public_verification: "denied" },
    ...finalOptions,
  });
}

test("init previews the canonical deterministic Manifest v2 YAML", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);

  const result = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );

  assert.equal(MANIFEST_SCHEMA, "launchrally.dev/manifest/v2");
  assert.equal(INIT_INTERACTION_SCHEMA, "launchrally.dev/init-interaction/v2");
  assert.deepEqual(result.interaction.source_report, {
    report_id: audit.report.report_id,
    role: "manifest_source",
  });
  assert.equal(result.manifest.schema_version, MANIFEST_SCHEMA);
  const manifestChange = result.preview.changes.find(
    (change) => change.path === ".launchrally/manifest.yaml",
  );
  assert.ok(manifestChange);
  assert.match(
    manifestChange.after,
    /^schema_version: "launchrally\.dev\/manifest\/v2"\nproject:\n/u,
  );
  assert.match(
    manifestChange.after,
    /\nrelease:\n[\s\S]*\nexecution:\n[\s\S]*\nsupport:\n[\s\S]*\nproviders:\n/u,
  );
  assert.match(manifestChange.after, new RegExp(
    `source_report_id: ${JSON.stringify(audit.report.report_id)}`,
    "u",
  ));
  assert.match(
    manifestChange.after,
    /field: "scope\.release_intent\.support_layers"/u,
  );
  assert.match(
    manifestChange.after,
    /field: "scope\.release_intent\.provider_roles"/u,
  );
  assert.equal(manifestChange.after, `${manifestChange.after.trimEnd()}\n`);
  assert.deepEqual(result.manifest.support.layers, {
    state: "not_applicable",
    reason: "No support layers were declared for this release.",
    evidence: [{
      source_report_id: audit.report.report_id,
      field: "scope.release_intent.support_layers",
    }],
  });
  assert.deepEqual(result.manifest.providers.roles, {
    state: "not_applicable",
    reason: "No Provider roles were declared for this release.",
    evidence: [{
      source_report_id: audit.report.report_id,
      field: "scope.release_intent.provider_roles",
    }],
  });
  assert.equal(
    result.preview.changes.some((change) =>
      change.path === ".launchrally/launch-manifest.json"),
    false,
  );
  assert.equal(await readFile(path.join(directory, "package.json"), "utf8") !== "", true);
});

test("init previews and confirms a fail-closed legacy JSON Manifest migration", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const intent = audit.report.scope.release_intent;
  const declared = (value) => ({ state: "declared", value });
  const legacy = {
    schema_version: "launchrally.dev/manifest/v1",
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
      public_verification: declared(audit.report.scope.public_verification),
    },
    support: {
      layers: {
        state: "not_applicable",
        reason: "No support layers were declared for this release.",
      },
    },
    providers: {
      roles: {
        state: "not_applicable",
        reason: "No Provider roles were declared for this release.",
      },
    },
  };
  const legacyPath = path.join(directory, ".launchrally", "launch-manifest.json");
  await mkdir(path.dirname(legacyPath));
  const legacyContent = `${JSON.stringify(legacy, null, 2)}\n`;
  await writeFile(legacyPath, legacyContent);

  const alteredLegacy = structuredClone(legacy);
  alteredLegacy.project.name.value = "different-project";
  await writeFile(legacyPath, `${JSON.stringify(alteredLegacy, null, 2)}\n`);
  const nonCurrent = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );
  assert.equal(nonCurrent.status, "needs_refresh");
  assert.equal(nonCurrent.reason, "current_report_required");
  await writeFile(legacyPath, legacyContent);

  const preview = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );

  assert.equal(preview.status, "needs_confirmation");
  assert.equal(preview.mode, "migration");
  assert.deepEqual(
    preview.preview.changes
      .filter((change) => change.path.includes("manifest"))
      .map(({ path: changedPath, operation }) => ({ path: changedPath, operation })),
    [
      { path: ".launchrally/launch-manifest.json", operation: "delete" },
      { path: ".launchrally/manifest.yaml", operation: "create" },
    ],
  );
  assert.equal(await readFile(legacyPath, "utf8"), legacyContent);

  const completed = await runInit(directory, "0.1.0", {
    resume_token: preview.interaction.resume_token,
    confirmation: "confirm",
  });

  assert.equal(completed.outcome, "migrated");
  await assert.rejects(readFile(legacyPath, "utf8"), { code: "ENOENT" });
  assert.equal(
    await readFile(path.join(directory, ".launchrally", "manifest.yaml"), "utf8"),
    preview.preview.changes.find(({ path: changedPath }) =>
      changedPath === ".launchrally/manifest.yaml").after,
  );
});

test("legacy migration rejects not-applicable evidence contradicted by the supplied Report", async () => {
  const directory = await fixture();
  const audit = await completeAudit(directory);
  const seed = await runInit(
    directory,
    "0.1.0",
    { report_package: audit },
    { prepare_dependency_changes: prepareNpmChanges },
  );
  const legacy = structuredClone(seed.manifest);
  legacy.schema_version = "launchrally.dev/manifest/v1";
  delete legacy.support.layers.evidence;
  delete legacy.providers.roles.evidence;
  const legacyPath = path.join(directory, ".launchrally", "launch-manifest.json");
  await mkdir(path.dirname(legacyPath));
  const legacyContent = `${JSON.stringify(legacy, null, 2)}\n`;
  await writeFile(legacyPath, legacyContent);
  const contradicted = structuredClone(audit);
  contradicted.report.scope.release_intent.support_layers = ["on_call"];
  let plannerCalled = false;

  const result = await runInit(
    directory,
    "0.1.0",
    { report_package: contradicted },
    {
      prepare_dependency_changes: async () => {
        plannerCalled = true;
        return [];
      },
    },
  );

  assert.equal(result.status, "execution_error");
  assert.equal(result.error, "legacy_manifest_evidence_mismatch");
  assert.equal(plannerCalled, false);
  assert.equal(await readFile(legacyPath, "utf8"), legacyContent);
  await assert.rejects(
    readFile(path.join(directory, ".launchrally", "manifest.yaml"), "utf8"),
    { code: "ENOENT" },
  );
});

test("the direct CLI exposes the typed CLI Interaction Contract v2 needs_refresh result", async () => {
  const directory = await fixture();
  const stale = await completeAudit(directory, {
    content_changes: ["package_manifest_changed"],
  });
  const reportPath = path.join(directory, "stale-audit.json");
  await writeFile(reportPath, `${JSON.stringify(stale)}\n`);

  const result = JSON.parse((await execFileAsync(process.execPath, [
    cli,
    "plan",
    "--report",
    reportPath,
    "--json",
  ])).stdout);

  assert.equal(CLI_INTERACTION_CONTRACT, "launchrally.dev/cli/v2");
  assert.deepEqual(result, {
    contract: CLI_INTERACTION_CONTRACT,
    status: "needs_refresh",
    operation: "plan",
    reason: "current_report_required",
    source_report_id: stale.report.report_id,
    request: {
      type: "refresh",
      operation: "verify",
      scope: "full",
    },
    message: "The saved Report is non-current; run full Verify before planning remediation.",
  });
  assert.equal(assertValidCliInteraction(result), true);
  assert.throws(
    () => assertValidCliInteraction({
      contract: CLI_INTERACTION_CONTRACT,
      status: "needs_refresh",
      operation: "plan",
    }),
    (error) => error.code === "invalid_cli_interaction",
  );
});

test("new Reports bind Check Catalog v2 while historical Report v1 remains readable", async () => {
  const directory = await fixture();
  const current = await completeAudit(directory);

  assert.equal(REPORT_SCHEMA, "launchrally.dev/report/v2");
  assert.equal(current.report.schema_version, REPORT_SCHEMA);
  assert.equal(current.report.provenance.check_catalog_version, "web-baseline-check-catalog/v2");
  assert.equal(current.report.catalog.versions.check_catalog, "web-baseline-check-catalog/v2");
  assert.equal(assertValidReportPackage(current), true);

  const historical = structuredClone(current);
  historical.report.schema_version = "launchrally.dev/report/v1";
  historical.report.provenance.check_catalog_version = "web-baseline-check-catalog/v1";
  historical.report.catalog.versions.check_catalog = "web-baseline-check-catalog/v1";
  delete historical.report.results.authenticated_journey_evidence_refs;
  delete historical.report.results.provider_tool_recoveries;
  for (const declaration of historical.report.catalog.checks) {
    declaration.evidence_requirement = declaration.pass_evidence_requirement;
    declaration.evidence_requirement.accepted_kinds =
      declaration.evidence_requirement.accepted_kinds.filter(
        (kind) => kind !== "authenticated_journey_observation",
      );
    delete declaration.pass_evidence_requirement;
    delete declaration.failure_evidence_requirement;
  }
  historical.report_view.schema_version = "launchrally.dev/report-view/v1";
  historical.report_view.report_schema_version = "launchrally.dev/report/v1";

  assert.equal(assertValidReportPackage(historical), true);
});

test("CLI help classifies providers as a supporting advisory operation", async () => {
  const help = JSON.parse((await execFileAsync(process.execPath, [cli, "--json"])).stdout);

  assert.deepEqual(help.commands, {
    core: ["audit", "init", "plan", "verify"],
    bootstrap: [
      "toolchain status",
      "toolchain restore",
      "toolchain migrate --to <exact-version>",
      "toolchain clean",
    ],
    supporting: [{ operation: "providers", mode: "advisory" }],
  });
  assert.match(help.message, /Supporting advisory operation:/u);
  assert.equal(assertValidCliInteraction(help), true);
});
