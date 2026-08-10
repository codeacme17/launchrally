import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { exactToolchainLock, writeExactToolchain } from "./helpers/exact-toolchain.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "packages", "cli", "bin", "rally.js");
const execFileAsync = promisify(execFile);
const volatileKeys = new Set([
  "resume_token",
  "content",
  "root",
  "project_root",
  "created_at",
  "generated_at",
  "collected_at",
  "evaluated_at",
  "duration_ms",
  "digest",
  "content_digest",
  "manifest_digest",
  "target_digest",
  "previous_digest",
  "current_digest",
  "report_id",
  "index_id",
  "interaction_id",
  "result_id",
  "source_report_id",
  "source_evidence_index_id",
  "current_report_id",
  "current_evidence_index_id",
  "current_result_id",
]);

const adapters = [
  {
    host: "codex",
    manifest: ".codex-plugin/plugin.json",
    metadata: "skills/launchrally/agents/openai.yaml",
  },
  {
    host: "claude",
    manifest: ".claude-plugin/plugin.json",
  },
];

const directJourney = {
  cli: {
    package: "@launchrally/cli",
    version: "0.1.1",
    contract: "launchrally.dev/cli/v2",
  },
  invocations: [
    ["version", ["--version", "--json"], ["version", "completed"]],
    [
      "audit_input",
      ["audit", "--json", "--cwd", "{repository_root}"],
      ["audit", "needs_input"],
    ],
    [
      "audit_confirmation",
      [
        "audit", "--json", "--cwd", "{repository_root}", "--resume", "{audit_resume}",
        "--answers", "{answers_json}",
      ],
      ["audit", "needs_confirmation"],
    ],
    [
      "audit_permission",
      [
        "audit", "--json", "--cwd", "{repository_root}", "--resume", "{audit_resume}",
        "--confirm", "confirm",
      ],
      ["audit", "needs_permission"],
    ],
    [
      "audit_completed",
      [
        "audit", "--json", "--cwd", "{repository_root}", "--resume", "{audit_resume}",
        "--permissions", "{permissions_json}",
      ],
      ["audit", "completed"],
    ],
    [
      "init_preview",
      ["init", "--json", "--cwd", "{repository_root}", "--report", "{report_path}"],
      ["init", ["needs_confirmation", "needs_permission"]],
    ],
    [
      "init_registry_permission",
      [
        "init", "--json", "--cwd", "{repository_root}", "--resume", "{init_registry_resume}",
        "--permissions", "{init_registry_permissions_json}",
      ],
      ["init", "needs_confirmation"],
    ],
    [
      "init_completed",
      [
        "init", "--json", "--cwd", "{repository_root}", "--resume", "{init_resume}",
        "--confirm", "confirm",
      ],
      ["init", "completed"],
    ],
    [
      "plan_refresh",
      ["plan", "--json", "--cwd", "{repository_root}", "--report", "{report_path}"],
      ["plan", "needs_refresh"],
    ],
    [
      "refresh_permission",
      [
        "verify", "--json", "--cwd", "{repository_root}", "--report", "{report_path}",
        "--scope", "full",
      ],
      ["verify", "needs_permission"],
    ],
    [
      "refresh_completed",
      [
        "verify", "--json", "--cwd", "{repository_root}", "--resume", "{refresh_resume}",
        "--permissions", "{permissions_json}",
      ],
      ["verify", "completed"],
    ],
    [
      "plan",
      ["plan", "--json", "--cwd", "{repository_root}", "--report", "{report_path}"],
      ["plan", "completed"],
    ],
    [
      "handoff",
      [
        "plan", "--json", "--cwd", "{repository_root}", "--report", "{report_path}",
        "--handoff",
      ],
      ["plan", "completed"],
    ],
    [
      "verify_permission",
      [
        "verify", "--json", "--cwd", "{repository_root}", "--report", "{report_path}",
        "--scope", "full",
      ],
      ["verify", "needs_permission"],
    ],
    [
      "verify_completed",
      [
        "verify", "--json", "--cwd", "{repository_root}", "--resume", "{verify_resume}",
        "--permissions", "{permissions_json}",
      ],
      ["verify", "completed"],
    ],
  ].map(([id, args, [operation, status]]) => ({
    id,
    ...(id === "init_registry_permission"
      ? { guard: { kind: "when_registry_permission_requested", intent: "resolve_toolchain" } }
      : id.startsWith("init_")
      ? { guard: { kind: "optional", intent: "initialize_project" } }
      : ["plan_refresh", "refresh_permission", "refresh_completed"].includes(id)
        ? { guard: { kind: "when_source_non_current", intent: "refresh_report" } }
        : id === "handoff"
        ? {
          guard: {
            kind: "requires_explicit_user_request",
            intent: "local_remediation",
          },
        }
        : {}),
    arguments: args,
    expect: { operation, status },
  })),
};

async function json(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

async function createRegistryNpmStub(version = "0.1.1") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-npm-stub-"));
  const lockfile = JSON.stringify(exactToolchainLock()).replaceAll("0.1.1", version);
  const script = path.join(directory, "npm-stub.cjs");
  await writeFile(script, [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'if (process.argv.includes("--offline")) {',
    '  process.stderr.write("ENOTCACHED: package is not in the offline cache\\n");',
    "  process.exit(1);",
    "}",
    `fs.writeFileSync(path.join(process.cwd(), "package-lock.json"), ${JSON.stringify(`${lockfile}\n`)});`,
  ].join("\n"));
  if (process.platform === "win32") {
    await writeFile(
      path.join(directory, "npm.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0npm-stub.cjs" %*\r\n`,
    );
  } else {
    const executable = path.join(directory, "npm");
    await writeFile(executable, `#!/usr/bin/env node\n${await readFile(script, "utf8")}`);
    await chmod(executable, 0o755);
  }
  return directory;
}

async function createProviderCommandStub(executableName, stdout) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-provider-stub-"));
  const script = path.join(directory, "provider-stub.cjs");
  await writeFile(script, `process.stdout.write(${JSON.stringify(stdout)});\n`);
  if (process.platform === "win32") {
    await writeFile(
      path.join(directory, `${executableName}.cmd`),
      `@echo off\r\n"${process.execPath}" "%~dp0provider-stub.cjs" %*\r\n`,
    );
  } else {
    const executable = path.join(directory, executableName);
    await writeFile(executable, `#!/usr/bin/env node\n${await readFile(script, "utf8")}`);
    await chmod(executable, 0o755);
  }
  return directory;
}

async function createFixture(host, sourceFixture = null, { preseedToolchain = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `launchrally-${host}-journey-`));
  if (sourceFixture) {
    await cp(sourceFixture, directory, { recursive: true });
  } else {
    await writeFile(path.join(directory, "package.json"), `${JSON.stringify({
      name: "reference-journey-web",
      scripts: { build: "node build.js" },
    }, null, 2)}\n`);
    await writeFile(path.join(directory, "package-lock.json"), `${JSON.stringify({
      name: "reference-journey-web",
      lockfileVersion: 3,
      packages: { "": {} },
    }, null, 2)}\n`);
  }
  if (preseedToolchain) await writeExactToolchain(directory);
  return directory;
}

async function createNetworkGuard() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-journey-network-"));
  const guard = path.join(directory, "deny-network.cjs");
  await writeFile(guard, [
    'const deny = () => { throw new Error("network access attempted"); };',
    'const net = require("node:net");',
    'const http = require("node:http");',
    'const https = require("node:https");',
    "net.connect = deny;",
    "net.createConnection = deny;",
    "http.request = deny;",
    "http.get = deny;",
    "https.request = deny;",
    "https.get = deny;",
    "global.fetch = deny;",
  ].join("\n"));
  return { directory, guard };
}

function normalized(value, parentKey = null) {
  if (Array.isArray(value)) return value.map((child) => normalized(child, parentKey));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (volatileKeys.has(key)) return [];
    if (parentKey === "project" && key === "name") return [[key, "<project>"]];
    return [[key, normalized(child, key)]];
  }));
}

async function loadAdapterJourney(adapter) {
  const adapterRoot = path.join(root, "adapters", adapter.host, "launchrally");
  const manifest = await json(path.relative(root, path.join(adapterRoot, adapter.manifest)));
  const packageJson = await json(path.relative(root, path.join(adapterRoot, "package.json")));
  const skillDirectory = adapter.host === "codex"
    ? path.resolve(adapterRoot, manifest.skills)
    : path.join(adapterRoot, "skills");
  const skillRoot = path.join(skillDirectory, "launchrally");
  const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  const journeyPath = path.join(skillRoot, "references", "reference-journey.md");
  const journey = await readFile(journeyPath, "utf8");
  const contract = JSON.parse(await readFile(
    path.join(skillRoot, "references", "reference-journey.json"),
    "utf8",
  ));
  assert.equal(packageJson.version, manifest.version);
  assert.match(skill, /references\/reference-journey\.md/u);
  assert.match(journey, /reference-journey\.json/u);
  if (adapter.host === "codex") {
    const metadata = await readFile(path.join(skillRoot, "agents", "openai.yaml"), "utf8");
    assert.match(metadata, /allow_implicit_invocation: false/u);
  } else {
    assert.match(skill, /disable-model-invocation: true/u);
  }
  assert.match(journey, /rally audit --json/u);
  assert.match(journey, /rally init --json/u);
  assert.match(journey, /rally plan --json/u);
  assert.match(journey, /rally plan --json[^`\n]*--handoff/u);
  assert.match(journey, /rally verify --json/u);

  return contract;
}

function invocationArguments(journey, id, values) {
  const invocation = journey.invocations.find((candidate) => candidate.id === id);
  assert.ok(invocation, `missing invocation: ${id}`);
  return {
    ...invocation,
    arguments: invocation.arguments.map((argument) => {
      const placeholder = argument.match(/^\{([^}]+)\}$/u)?.[1];
      return placeholder === undefined ? argument : values[placeholder];
    }),
  };
}

async function executeReferenceJourney(
  label,
  journey,
  env,
  {
    initialize = true,
    remediationRequested = true,
    verifyAfterRemediation = true,
    publicPermission = "denied",
    providerPermissions = {},
    productionTarget = "https://example.com",
    fixturePath = null,
    providerRoles = [],
    exerciseRegistryPermission = false,
  } = {},
) {
  const directory = await createFixture(label, fixturePath, {
    preseedToolchain: !exerciseRegistryPermission,
  });
  const registryStub = exerciseRegistryPermission ? await createRegistryNpmStub() : null;
  const journeyEnv = registryStub
    ? { ...env, PATH: `${registryStub}${path.delimiter}${env.PATH ?? ""}` }
    : env;
  const savedDirectory = await mkdtemp(path.join(os.tmpdir(), `launchrally-${label}-reports-`));
  const values = {
    repository_root: directory,
    answers_json: JSON.stringify({
      intended_environment: "production",
      production_targets: [productionTarget],
      core_journeys: [{ method: "GET", path: "/", purpose: "homepage loads" }],
      provider_roles: providerRoles,
      support_layers: [],
    }),
    permissions_json: JSON.stringify({
      public_verification: publicPermission,
      ...Object.fromEntries(providerRoles.map(({ provider }) => [
        `provider_read:${provider}`,
        providerPermissions[provider] ?? publicPermission,
      ])),
    }),
  };
  const operations = [];
  const invoke = async (id) => {
    const invocation = invocationArguments(journey, id, values);
    const result = JSON.parse((await execFileAsync(
      process.execPath,
      [cli, ...invocation.arguments],
      { cwd: root, env: journeyEnv },
    )).stdout);
    assert.equal(result.contract, journey.cli.contract, `${id} contract`);
    assert.equal(result.operation, invocation.expect.operation, `${id} operation`);
    if (Array.isArray(invocation.expect.status)) {
      assert.ok(invocation.expect.status.includes(result.status), `${id} status`);
    } else {
      assert.equal(result.status, invocation.expect.status, `${id} status`);
    }
    if (invocation.expect.schema_version) {
      assert.equal(result.schema_version, invocation.expect.schema_version, `${id} schema`);
    }
    if (invocation.expect.interaction_schema) {
      assert.equal(
        result.interaction?.schema_version,
        invocation.expect.interaction_schema,
        `${id} interaction schema`,
      );
    }
    operations.push(result.operation);
    return result;
  };
  const requireGuard = (id, expected) => {
    const invocation = journey.invocations.find((candidate) => candidate.id === id);
    assert.deepEqual(invocation?.guard, expected, `${id} guard`);
  };

  try {
    const version = await invoke("version");
    assert.equal(version.cli_version, journey.cli.version, "version cli_version");

    const auditInput = await invoke("audit_input");
    values.audit_resume = auditInput.interaction.resume_token;
    const auditConfirmation = await invoke("audit_confirmation");
    values.audit_resume = auditConfirmation.interaction.resume_token;
    const auditPermission = await invoke("audit_permission");
    values.audit_resume = auditPermission.interaction.resume_token;
    const audit = await invoke("audit_completed");
    const reportPath = path.join(savedDirectory, "audit.json");
    await writeFile(reportPath, JSON.stringify(audit));
    values.report_path = reportPath;

    requireGuard("init_preview", { kind: "optional", intent: "initialize_project" });
    requireGuard("init_completed", { kind: "optional", intent: "initialize_project" });
    let initPreview = null;
    let init = null;
    const initStates = [];
    if (initialize) {
      initPreview = await invoke("init_preview");
      initStates.push(initPreview.status);
      if (initPreview.status === "needs_permission") {
        requireGuard("init_registry_permission", {
          kind: "when_registry_permission_requested",
          intent: "resolve_toolchain",
        });
        values.init_registry_resume = initPreview.interaction.resume_token;
        values.init_registry_permissions_json = JSON.stringify({
          npm_registry_read: "approved",
        });
        initPreview = await invoke("init_registry_permission");
        initStates.push(initPreview.status);
      }
      values.init_resume = initPreview.interaction.resume_token;
      init = await invoke("init_completed");
      initStates.push(init.status);
      requireGuard("plan_refresh", {
        kind: "when_source_non_current",
        intent: "refresh_report",
      });
      await invoke("plan_refresh");
      const refreshPermission = await invoke("refresh_permission");
      values.refresh_resume = refreshPermission.interaction.resume_token;
      const refreshed = await invoke("refresh_completed");
      const refreshedPath = path.join(savedDirectory, "refreshed.json");
      await writeFile(refreshedPath, JSON.stringify(refreshed));
      values.report_path = refreshedPath;
    }
    const plan = await invoke("plan");
    requireGuard("handoff", {
      kind: "requires_explicit_user_request",
      intent: "local_remediation",
    });
    const handoff = remediationRequested ? await invoke("handoff") : null;
    if (handoff) {
      await writeFile(
        path.join(directory, ".env.example"),
        "LAUNCHRALLY_REMEDIATION_CHECK=1\n",
        { flag: "a" },
      );
    }
    let verifyPermission = null;
    let verify = null;
    if (verifyAfterRemediation) {
      verifyPermission = await invoke("verify_permission");
      values.verify_resume = verifyPermission.interaction.resume_token;
      verify = await invoke("verify_completed");
    }

    return {
      operations,
      states: {
        audit: [auditInput.status, auditConfirmation.status, auditPermission.status, audit.status],
        init: init ? initStates : null,
        plan: plan.status,
        handoff: handoff?.status ?? null,
        verify: verify ? [verifyPermission.status, verify.status] : null,
      },
      init: init
        ? {
          outcome: init.outcome,
          changed_paths: initPreview.preview.changes.map(
            ({ path: changedPath }) => changedPath,
          ),
        }
        : null,
      remediation_verified: verify
        ? verify.comparison?.source_report_id !== verify.comparison?.current_report_id
        : null,
      semantics: normalized({
        audit: { report: audit.report, evidence_index: audit.evidence_index },
        plan,
        handoff,
        verify: verify
          ? {
            assessment: verify.assessment,
            report: verify.report,
            evidence_index: verify.evidence_index,
            comparison: verify.comparison,
          }
          : null,
      }),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(savedDirectory, { recursive: true, force: true });
    if (registryStub) await rm(registryStub, { recursive: true, force: true });
  }
}

test("native adapters ship the canonical Reference Journey for the exact CLI version", async () => {
  const cliPackage = await json("packages/cli/package.json");
  const journeyContract = await json(
    "skills/launchrally/references/reference-journey.json",
  );
  const canonicalJourney = await readFile(
    path.join(root, "skills", "launchrally", "references", "reference-journey.md"),
    "utf8",
  );

  assert.match(
    canonicalJourney,
    /Audit.*optional Init.*Read-only Plan.*Remediation Handoff.*Verify/su,
  );
  assert.match(
    canonicalJourney,
    new RegExp(`@launchrally/cli@${cliPackage.version.replaceAll(".", "\\.")}`, "u"),
  );
  assert.match(canonicalJourney, /--version --json/u);
  assert.match(canonicalJourney, /contract: "launchrally\.dev\/cli\/v2"/u);
  assert.match(canonicalJourney, /cli_version/u);
  assert.deepEqual(journeyContract.cli, {
    package: "@launchrally/cli",
    version: cliPackage.version,
    contract: "launchrally.dev/cli/v2",
  });
  assert.deepEqual(
    journeyContract.invocations.map(({ id }) => id),
    [
      "version",
      "audit_input",
      "audit_confirmation",
      "audit_permission",
      "audit_completed",
      "init_preview",
      "init_registry_permission",
      "init_completed",
      "plan_refresh",
      "refresh_permission",
      "refresh_completed",
      "plan",
      "handoff",
      "verify_permission",
      "verify_completed",
    ],
  );
  const invocationById = new Map(
    journeyContract.invocations.map((invocation) => [invocation.id, invocation]),
  );
  assert.deepEqual(invocationById.get("init_preview").guard, {
    kind: "optional",
    intent: "initialize_project",
  });
  assert.deepEqual(invocationById.get("init_completed").guard, {
    kind: "optional",
    intent: "initialize_project",
  });
  assert.deepEqual(invocationById.get("init_registry_permission").guard, {
    kind: "when_registry_permission_requested",
    intent: "resolve_toolchain",
  });
  assert.deepEqual(invocationById.get("handoff").guard, {
    kind: "requires_explicit_user_request",
    intent: "local_remediation",
  });

  for (const adapter of adapters) {
    const adapterRoot = path.join(root, "adapters", adapter.host, "launchrally");
    const packageJson = await json(
      path.relative(root, path.join(adapterRoot, "package.json")),
    );
    const manifest = await json(path.relative(root, path.join(adapterRoot, adapter.manifest)));
    const skill = await readFile(
      path.join(adapterRoot, "skills", "launchrally", "SKILL.md"),
      "utf8",
    );
    const journey = await readFile(
      path.join(adapterRoot, "skills", "launchrally", "references", "reference-journey.md"),
      "utf8",
    );

    assert.equal(packageJson.version, cliPackage.version, `${adapter.host} package version`);
    assert.equal(manifest.version, cliPackage.version, `${adapter.host} manifest version`);
    assert.equal(journey, canonicalJourney, `${adapter.host} canonical journey copy`);
    assert.match(skill, /references\/reference-journey\.md/u);
  }

  const codexMetadata = await readFile(
    path.join(root, "adapters", "codex", "launchrally", adapters[0].metadata),
    "utf8",
  );
  const claudeSkill = await readFile(
    path.join(root, "adapters", "claude", "launchrally", "skills", "launchrally", "SKILL.md"),
    "utf8",
  );
  assert.match(codexMetadata, /allow_implicit_invocation: false/u);
  assert.match(claudeSkill, /disable-model-invocation: true/u);
});

test("the canonical Skill routes every structured CLI interaction state without prose parsing", async () => {
  const contract = await readFile(
    path.join(root, "skills", "launchrally", "references", "cli-contract.md"),
    "utf8",
  );

  assert.match(contract, /## State router/u);
  for (const status of [
    "needs_input",
    "needs_confirmation",
    "needs_permission",
    "needs_refresh",
    "completed",
    "unavailable",
    "execution_error",
  ]) {
    assert.ok(contract.includes(`| \`${status}\` |`), status);
  }
  assert.match(contract, /interaction\.schema_version/u);
  assert.match(contract, /Preserve.*resume_token.*verbatim/su);
  assert.match(contract, /Never parse or branch on.*terminal prose/su);
  assert.match(
    contract,
    /`needs_refresh`.*typed reason.*request\.operation.*request\.scope/su,
  );
  assert.match(contract, /`providers` is a supporting advisory operation/u);

  for (const adapter of adapters) {
    const adapterContract = await readFile(
      path.join(
        root,
        "adapters",
        adapter.host,
        "launchrally",
        "skills",
        "launchrally",
        "references",
        "cli-contract.md",
      ),
      "utf8",
    );
    assert.equal(adapterContract, contract, `${adapter.host} CLI contract parity`);
  }
});

test("each native package contract drives the same offline CLI Reference Journey", async () => {
  const network = await createNetworkGuard();
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${network.guard}`.trim(),
  };

  try {
    const direct = await executeReferenceJourney("direct", directJourney, env);
    const results = [];
    const skippedResults = [];
    for (const adapter of adapters) {
      const adapterJourney = await loadAdapterJourney(adapter);
      assert.deepEqual(adapterJourney.cli, directJourney.cli);
      results.push(await executeReferenceJourney(adapter.host, adapterJourney, env));
      skippedResults.push(await executeReferenceJourney(
        `${adapter.host}-skip-optional`,
        adapterJourney,
        env,
        {
          initialize: false,
          remediationRequested: false,
          verifyAfterRemediation: false,
        },
      ));
    }

    for (const result of results) {
      assert.equal(result.operations[0], "version");
      assert.deepEqual(result.states, {
        audit: ["needs_input", "needs_confirmation", "needs_permission", "completed"],
        init: ["needs_confirmation", "completed"],
        plan: "completed",
        handoff: "completed",
        verify: ["needs_permission", "completed"],
      });
      assert.equal(result.init.outcome, "initialized");
      assert.ok(result.init.changed_paths.includes(".launchrally/.gitignore"));
      assert.ok(result.init.changed_paths.includes(".launchrally/manifest.yaml"));
      const reportPaths = result.init.changed_paths.filter((changedPath) =>
        changedPath.includes("/.launchrally/reports/")
        || changedPath.startsWith(".launchrally/reports/"));
      assert.equal(reportPaths.length, 4);
      assert.deepEqual(
        reportPaths.map((changedPath) => path.basename(changedPath)).sort(),
        ["evidence-index.json", "record.json", "record.sha256", "view.md"],
      );
      assert.ok(result.init.changed_paths.some((changedPath) =>
        /^\.launchrally\/evidence\/sha256\/[a-f0-9]{64}\.json$/u.test(changedPath)));
      assert.deepEqual(result.semantics, direct.semantics);
    }
    for (const result of skippedResults) {
      assert.deepEqual(result.operations, [
        "version",
        "audit",
        "audit",
        "audit",
        "audit",
        "plan",
      ]);
      assert.equal(result.states.init, null);
      assert.equal(result.states.handoff, null);
      assert.equal(result.states.verify, null);
    }
  } finally {
    await rm(network.directory, { recursive: true, force: true });
  }
});

test("the direct CLI completes the full Reference Journey for every coverage representative", async () => {
  const network = await createNetworkGuard();
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${network.guard}`.trim(),
  };
  const matrix = await json("fixtures/coverage/matrix.json");

  try {
    for (const representative of matrix.fixtures) {
      const result = await executeReferenceJourney(
        `direct-${representative.id}`,
        directJourney,
        env,
        {
          fixturePath: path.join(root, "fixtures", "coverage", representative.path),
          productionTarget: representative.production_target,
          providerRoles: representative.provider_roles ?? [],
          publicPermission: "denied",
        },
      );

      assert.deepEqual(result.states, {
        audit: ["needs_input", "needs_confirmation", "needs_permission", "completed"],
        init: ["needs_confirmation", "completed"],
        plan: "completed",
        handoff: "completed",
        verify: ["needs_permission", "completed"],
      }, representative.id);
      assert.equal(result.init.outcome, "initialized", representative.id);
      assert.equal(
        result.init.changed_paths.some((changedPath) => [
          "package.json",
          "package-lock.json",
          "pnpm-lock.yaml",
          "yarn.lock",
          "bun.lock",
          "bun.lockb",
        ].includes(changedPath)),
        false,
        representative.id,
      );
      assert.notEqual(
        result.semantics.verify.assessment,
        "launch_ready",
        representative.id,
      );
      assert.equal(result.remediation_verified, true, representative.id);
    }
  } finally {
    await rm(network.directory, { recursive: true, force: true });
  }
});

test("the packaged JSON journey approves one new Provider read and independently denies another", async () => {
  const stub = await createProviderCommandStub("clerk", JSON.stringify([{
    application_id: "app_reference",
    name: "Reference app",
    instances: [{
      instance_id: "ins_reference",
      environment_type: "production",
      secret_key: "must-not-survive",
    }],
  }]));
  try {
    const result = await executeReferenceJourney(
      "provider-permission-reference",
      directJourney,
      { ...process.env, PATH: `${stub}${path.delimiter}${process.env.PATH ?? ""}` },
      {
        providerRoles: [
          { provider: "clerk", role: "authentication" },
          { provider: "resend", role: "email" },
        ],
        providerPermissions: {
          clerk: "approved",
          resend: "denied",
        },
        publicPermission: "denied",
      },
    );
    const requests = result.semantics.audit.report.scope.provider_verification.requests;
    assert.deepEqual(requests.map(({ provider, decision }) => ({ provider, decision })), [
      { provider: "clerk", decision: "approved" },
      { provider: "resend", decision: "denied" },
    ]);
    const providerEvidence = result.semantics.audit.evidence_index.entries
      .filter(({ evidence_kind }) => evidence_kind === "machine_evidence")
      .map(({ normalized_artifact }) => normalized_artifact);
    assert.deepEqual(providerEvidence.map(({ provider }) => provider), ["clerk"]);
    assert.equal(
      result.semantics.audit.report.results.verification_gaps.some(
        ({ check_id, reason_code }) =>
          check_id === "provider.resend.metadata" && reason_code === "permission_denied",
      ),
      true,
    );
    assert.doesNotMatch(JSON.stringify(result), /must-not-survive/u);
  } finally {
    await rm(stub, { recursive: true, force: true });
  }
});

test("the packaged JSON journey reports missing approved Provider tooling", async () => {
  const result = await executeReferenceJourney(
    "provider-missing-tool-reference",
    directJourney,
    { ...process.env, PATH: "" },
    {
      initialize: false,
      remediationRequested: false,
      verifyAfterRemediation: false,
      providerRoles: [{ provider: "clerk", role: "authentication" }],
      providerPermissions: { clerk: "approved" },
      publicPermission: "denied",
    },
  );

  assert.equal(
    result.semantics.audit.report.results.verification_gaps.some(
      ({ check_id, reason_code }) =>
        check_id === "provider.clerk.metadata" && reason_code === "missing_provider_tool",
    ),
    true,
  );
});

test("direct and Skill journeys preserve semantics with complete public-read permission", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(request.url === "/health" ? 204 : 200);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const target = `http://127.0.0.1:${server.address().port}/`;
    const direct = await executeReferenceJourney(
      "direct-complete-permission",
      directJourney,
      process.env,
      { publicPermission: "approved", productionTarget: target },
    );
    assert.equal(
      direct.semantics.audit.report.scope.public_verification.decision,
      "approved",
    );

    for (const adapter of adapters) {
      const adapterJourney = await loadAdapterJourney(adapter);
      const result = await executeReferenceJourney(
        `${adapter.host}-complete-permission`,
        adapterJourney,
        process.env,
        { publicPermission: "approved", productionTarget: target },
      );
      assert.deepEqual(result.semantics, direct.semantics, adapter.host);
    }
    assert.ok(requests.length > 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("native Skills complete JavaScript and non-JavaScript journeys with complete and partial permissions", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(request.url === "/health" ? 204 : 200);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const target = `http://127.0.0.1:${server.address().port}/`;
  const network = await createNetworkGuard();
  const deniedEnv = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${network.guard}`.trim(),
  };
  const representatives = ["typescript-astro", "python-fastapi"];

  try {
    for (const representative of representatives) {
      for (const permission of ["approved", "denied"]) {
        const options = {
          fixturePath: path.join(root, "fixtures", "coverage", representative),
          productionTarget: permission === "approved" ? target : "https://denied.example.com",
          publicPermission: permission,
          exerciseRegistryPermission: true,
        };
        const env = permission === "approved" ? process.env : deniedEnv;
        const direct = await executeReferenceJourney(
          `direct-${representative}-${permission}`,
          directJourney,
          env,
          options,
        );

        for (const adapter of adapters) {
          const adapterJourney = await loadAdapterJourney(adapter);
          const result = await executeReferenceJourney(
            `${adapter.host}-${representative}-${permission}`,
            adapterJourney,
            env,
            options,
          );
          assert.deepEqual(
            result.semantics,
            direct.semantics,
            `${adapter.host}:${representative}:${permission}`,
          );
          assert.equal(
            result.semantics.audit.report.scope.public_verification.decision,
            permission,
          );
          assert.notEqual(result.semantics.verify.assessment, "launch_ready");
          assert.deepEqual(result.states.init, [
            "needs_permission",
            "needs_confirmation",
            "completed",
          ]);
          assert.equal(result.remediation_verified, true);
        }
      }
    }
    assert.ok(requests.length > 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(network.directory, { recursive: true, force: true });
  }
});
