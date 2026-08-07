import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
    version: "0.1.0",
    contract: "launchrally.dev/cli/v0",
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
    ...(id.startsWith("init_")
      ? { guard: { kind: "optional", intent: "initialize_project" } }
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

async function createFixture(host) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `launchrally-${host}-journey-`));
  await writeFile(path.join(directory, "package.json"), `${JSON.stringify({
    name: "reference-journey-web",
    scripts: { build: "node build.js" },
    devDependencies: { "@launchrally/cli": "0.1.0" },
  }, null, 2)}\n`);
  await writeFile(path.join(directory, "package-lock.json"), `${JSON.stringify({
    name: "reference-journey-web",
    lockfileVersion: 3,
    packages: {
      "": { devDependencies: { "@launchrally/cli": "0.1.0" } },
      "node_modules/@launchrally/cli": { version: "0.1.0", dev: true },
    },
  }, null, 2)}\n`);
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

function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (volatileKeys.has(key)) return [];
    return [[key, normalized(child)]];
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
  } = {},
) {
  const directory = await createFixture(label);
  const savedDirectory = await mkdtemp(path.join(os.tmpdir(), `launchrally-${label}-reports-`));
  const values = {
    repository_root: directory,
    answers_json: JSON.stringify({
      intended_environment: "production",
      production_targets: ["https://example.com"],
      core_journeys: [{ method: "GET", path: "/", purpose: "homepage loads" }],
      provider_roles: [],
      support_layers: [],
    }),
    permissions_json: JSON.stringify({ public_verification: "denied" }),
  };
  const operations = [];
  const invoke = async (id) => {
    const invocation = invocationArguments(journey, id, values);
    const result = JSON.parse((await execFileAsync(
      process.execPath,
      [cli, ...invocation.arguments],
      { cwd: root, env },
    )).stdout);
    assert.equal(result.contract, journey.cli.contract, `${id} contract`);
    assert.equal(result.operation, invocation.expect.operation, `${id} operation`);
    assert.equal(result.status, invocation.expect.status, `${id} status`);
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
    if (initialize) {
      initPreview = await invoke("init_preview");
      values.init_resume = initPreview.interaction.resume_token;
      init = await invoke("init_completed");
    }
    const plan = await invoke("plan");
    requireGuard("handoff", {
      kind: "requires_explicit_user_request",
      intent: "local_remediation",
    });
    const handoff = remediationRequested ? await invoke("handoff") : null;
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
        init: init ? [initPreview.status, init.status] : null,
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
  assert.match(canonicalJourney, /contract: "launchrally\.dev\/cli\/v0"/u);
  assert.match(canonicalJourney, /cli_version/u);
  assert.deepEqual(journeyContract.cli, {
    package: "@launchrally/cli",
    version: cliPackage.version,
    contract: "launchrally.dev/cli/v0",
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
      "init_completed",
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
    "needs_selection",
    "completed",
    "unavailable",
    "execution_error",
  ]) {
    assert.ok(contract.includes(`| \`${status}\` |`), status);
  }
  assert.match(contract, /interaction\.schema_version/u);
  assert.match(contract, /Preserve.*resume_token.*verbatim/su);
  assert.match(contract, /Never parse or branch on.*terminal prose/su);
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
      assert.deepEqual(result.init, {
        outcome: "initialized",
        changed_paths: [
          ".launchrally/.gitignore",
          ".launchrally/launch-manifest.json",
        ],
      });
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
