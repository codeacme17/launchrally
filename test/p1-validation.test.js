import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { copyRepositoryFixture } from "./helpers/repository-fixture.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

async function validateP1Log(directory, extraArguments = []) {
  return execFileAsync(
    process.execPath,
    [
      "scripts/p1-validation-log-contract.mjs",
      "--root",
      directory,
      ...extraArguments,
      "--json",
    ],
    { cwd: root },
  );
}

async function fixture() {
  return copyRepositoryFixture(root, "launchrally-p1-validation-", [
    "docs",
    "release",
    "scripts",
  ]);
}

async function p1Fixture() {
  return copyRepositoryFixture(root, "launchrally-p1-validation-gate-", [
    ".github",
    "CHANGELOG.md",
    "adapters",
    "docs",
    "package.json",
    "packages",
    "release",
    "scripts",
    "skills",
    "test",
  ]);
}

function nextEntry(log, period, qualityFloor) {
  return {
    ...structuredClone(log.entries.at(-1)),
    period,
    quality_floor: qualityFloor,
  };
}

async function writeQualityFloorHistory(directory, events) {
  const logPath = path.join(directory, "docs/maintainers/phase-1-validation-log.json");
  const matrixPath = path.join(directory, "release/p1-acceptance.json");
  const registryPath = path.join(directory, "release/p1-regression-registry.json");
  const contractPath = path.join(directory, "release/p1.json");
  const [log, matrix, registry, contract] = await Promise.all([
    readFile(logPath, "utf8").then(JSON.parse),
    readFile(matrixPath, "utf8").then(JSON.parse),
    readFile(registryPath, "utf8").then(JSON.parse),
    readFile(contractPath, "utf8").then(JSON.parse),
  ]);
  const condition = matrix.quality_floor.find(({ id }) => id === "P1-QF-02");
  const finalEvent = events.at(-1);
  const regression = {
    regression_id: "P1-REG-0001",
    status: finalEvent === "authority_restored"
      ? "restored"
      : finalEvent === "fix_verified"
        ? "fixed"
        : "open",
    affected_authority_scopes: ["intent_declaration"],
    reviewed_fix: events.includes("fix_verified") ? "review:verified-fix" : null,
    restoration: finalEvent === "authority_restored" ? "review:authority-restored" : null,
  };
  condition.status = regression.status === "restored" ? "satisfied" : "suspended";
  condition.regressions.push(regression);
  registry.assignments.push({
    regression_id: regression.regression_id,
    condition_id: condition.id,
    authority_scopes: regression.affected_authority_scopes,
  });
  contract.quality_floor_status = condition.status;
  events.forEach((event, index) => {
    const restored = event === "authority_restored";
    log.entries.push(nextEntry(log, `2026-08-23-0${index + 1}`, {
      status: restored ? "satisfied" : "suspended",
      events: [{
        regression_id: regression.regression_id,
        condition_id: condition.id,
        event,
        affected_authority_scopes: regression.affected_authority_scopes,
      }],
      suspended_authority_scopes: restored ? [] : regression.affected_authority_scopes,
    }));
  });
  log.updated_at = "2026-08-23";
  await Promise.all([
    writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`),
    writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`),
    writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`),
    writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`),
  ]);
}

test("the Phase 1 Validation Log remains collecting, not validated, Experimental, and not approved", async () => {
  const { stdout } = await validateP1Log(root);

  assert.deepEqual(JSON.parse(stdout), {
    status: "completed",
    schema_version: "launchrally.dev/phase-1-validation-log/v1",
    collection_mode: "telemetry_free",
    telemetry_free_validation: "collecting",
    validation_status: "not_validated",
    release_status: "experimental",
    stable_promotion_status: "not_approved",
    quality_floor_status: "satisfied",
    suspended_authorities: [],
    p0_release_status: "stable",
    entries: 1,
  });
});

test("the Phase 1 Validation Log rejects fields outside the reviewed aggregate schema", async () => {
  const directory = await fixture();
  const logPath = path.join(directory, "docs/maintainers/phase-1-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  log.entries[0].repository_name = "private-project";
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(validateP1Log(directory), (error) => {
    assert.match(error.stderr, /p1_validation_unknown_field/u);
    assert.match(error.stderr, /repository_name/u);
    return true;
  });
});

test("the Phase 1 release contract cannot point the Validation Log outside the repository", async () => {
  const directory = await fixture();
  const contractPath = path.join(directory, "release/p1.json");
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  contract.validation_log = "/etc/passwd";
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

  await assert.rejects(validateP1Log(directory), (error) => {
    assert.match(error.stderr, /p1_validation_log_path_invalid/u);
    return true;
  });
});

test("the Phase 1 Validation Log rejects sensitive or identifying values", async () => {
  const directory = await fixture();
  const logPath = path.join(directory, "docs/maintainers/phase-1-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  log.entries[0].defect_patterns[0].issue_ids = [
    "https://github.com/private/example/issues/187",
  ];
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(validateP1Log(directory), (error) => {
    assert.match(error.stderr, /p1_validation_identifying_data_forbidden/u);
    return true;
  });
});

test("the Phase 1 Validation Log rejects unsupported aggregate taxonomy", async () => {
  const directory = await fixture();
  const logPath = path.join(directory, "docs/maintainers/phase-1-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  log.entries[0].represented_contexts.repository_shapes = ["unreviewed_product_shape"];
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(validateP1Log(directory), (error) => {
    assert.match(error.stderr, /p1_validation_taxonomy_forbidden/u);
    assert.match(error.stderr, /unreviewed_product_shape/u);
    return true;
  });
});

test("the Phase 1 Validation Log rejects numeric adoption, download, and time quotas", async () => {
  const directory = await fixture();
  const logPath = path.join(directory, "docs/maintainers/phase-1-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  log.entries[0].validation_threshold = { minimum_downloads: 100 };
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(validateP1Log(directory), (error) => {
    assert.match(error.stderr, /p1_validation_quota_forbidden/u);
    return true;
  });
});

test("the first aggregate record cannot advance P1 validation", async () => {
  const directory = await fixture();
  const logPath = path.join(directory, "docs/maintainers/phase-1-validation-log.json");
  const contractPath = path.join(directory, "release/p1.json");
  const [log, contract] = await Promise.all([
    readFile(logPath, "utf8").then(JSON.parse),
    readFile(contractPath, "utf8").then(JSON.parse),
  ]);
  log.entries[0].lifecycle.validation_status = "validated";
  contract.validation_status = "validated";
  await Promise.all([
    writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`),
    writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`),
  ]);

  await assert.rejects(validateP1Log(directory), (error) => {
    assert.match(error.stderr, /p1_validation_advancement_blocked/u);
    return true;
  });
});

test("the Phase 1 Validation Log rejects historical mutation against the reviewed Git baseline", async () => {
  const directory = await fixture();
  const logPath = path.join(directory, "docs/maintainers/phase-1-validation-log.json");
  await execFileAsync("git", ["init"], { cwd: directory });
  await execFileAsync(
    "git",
    ["add", "release/p1.json", "docs/maintainers/phase-1-validation-log.json"],
    { cwd: directory },
  );
  await execFileAsync("git", [
    "-c",
    "user.name=LaunchRally Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "review Phase 1 validation log",
  ], { cwd: directory });
  const log = JSON.parse(await readFile(logPath, "utf8"));
  log.entries[0].period = "2026-08-23-01";
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(validateP1Log(directory, ["--baseline-ref", "HEAD"]), (error) => {
    assert.match(error.stderr, /p1_validation_history_changed/u);
    assert.match(error.stderr, /entry 0/u);
    return true;
  });
});

test("the Phase 1 Validation Log accepts a reviewed append without changing history", async () => {
  const directory = await fixture();
  const logPath = path.join(directory, "docs/maintainers/phase-1-validation-log.json");
  const baselinePath = path.join(directory, "reviewed-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  await writeFile(baselinePath, `${JSON.stringify(log, null, 2)}\n`);
  log.updated_at = "2026-08-23";
  log.entries.push(nextEntry(log, "2026-08-23-01", {
    status: "satisfied",
    events: [],
    suspended_authority_scopes: [],
  }));
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  const { stdout } = await validateP1Log(directory, [
    "--baseline-log",
    "reviewed-validation-log.json",
  ]);
  assert.equal(JSON.parse(stdout).entries, 2);
});

test("new Phase 1 Validation Log entries must advance monotonically", async () => {
  const directory = await fixture();
  const logPath = path.join(directory, "docs/maintainers/phase-1-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  log.updated_at = "2026-08-21";
  log.entries.push(nextEntry(log, "2026-08-21-01", {
    status: "satisfied",
    events: [],
    suspended_authority_scopes: [],
  }));
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(validateP1Log(directory), (error) => {
    assert.match(error.stderr, /p1_validation_entry_order_invalid/u);
    return true;
  });
});

test("the Phase 1 Validation Log rejects deletion and reordering of reviewed entries", async () => {
  const directory = await fixture();
  const logPath = path.join(directory, "docs/maintainers/phase-1-validation-log.json");
  const baselinePath = path.join(directory, "reviewed-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  log.updated_at = "2026-08-23";
  log.entries.push(nextEntry(log, "2026-08-23-01", {
    status: "satisfied",
    events: [],
    suspended_authority_scopes: [],
  }));
  await writeFile(baselinePath, `${JSON.stringify(log, null, 2)}\n`);
  log.entries.reverse();
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(
    validateP1Log(directory, ["--baseline-log", "reviewed-validation-log.json"]),
    (error) => {
      assert.match(error.stderr, /p1_validation_history_changed/u);
      return true;
    },
  );
  log.entries = [];
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);
  await assert.rejects(
    validateP1Log(directory, ["--baseline-log", "reviewed-validation-log.json"]),
    (error) => {
      assert.match(error.stderr, /p1_validation_log_incomplete|p1_validation_history_changed/u);
      return true;
    },
  );
});

test("a Phase 1 Quality Floor regression suspends only its declared authority and preserves P0 Stable", async () => {
  const directory = await fixture();
  await writeQualityFloorHistory(directory, ["regression_opened"]);

  const { stdout } = await validateP1Log(directory);
  const result = JSON.parse(stdout);
  assert.equal(result.quality_floor_status, "suspended");
  assert.deepEqual(result.suspended_authorities, ["intent_declaration"]);
  assert.equal(result.p0_release_status, "stable");
});

test("Phase 1 authority restoration is blocked without a later verified-fix entry", async () => {
  const directory = await fixture();
  await writeQualityFloorHistory(directory, ["regression_opened", "authority_restored"]);

  await assert.rejects(validateP1Log(directory), (error) => {
    assert.match(error.stderr, /p1_validation_restoration_blocked/u);
    return true;
  });
});

test("a verified fix and a later restoration entry restore only the suspended Phase 1 authority", async () => {
  const directory = await fixture();
  await writeQualityFloorHistory(directory, [
    "regression_opened",
    "fix_verified",
    "authority_restored",
  ]);

  const { stdout } = await validateP1Log(directory);
  const result = JSON.parse(stdout);
  assert.equal(result.quality_floor_status, "satisfied");
  assert.deepEqual(result.suspended_authorities, []);
  assert.equal(result.p0_release_status, "stable");
});

test("the normal P1 validation gate includes the Phase 1 Validation Log contract", async () => {
  const { stdout } = await execFileAsync(
    "npm",
    ["--silent", "run", "validate:p1", "--", "--json"],
    { cwd: root },
  );
  const result = JSON.parse(stdout);

  assert.equal(result.validation_mode, "telemetry_free");
  assert.equal(result.validation_collection_status, "collecting");
  assert.equal(result.validation_status, "not_validated");
  assert.equal(result.validation_log, "docs/maintainers/phase-1-validation-log.json");
});

test("the normal P1 validation gate rejects an invalid Phase 1 Validation Log", async () => {
  const directory = await p1Fixture();
  const logPath = path.join(directory, "docs/maintainers/phase-1-validation-log.json");
  const log = JSON.parse(await readFile(logPath, "utf8"));
  log.entries[0].represented_contexts.interfaces = ["unreviewed_interface"];
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-p1.mjs", "--root", directory, "--json"],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /p1_validation_taxonomy_forbidden/u);
      return true;
    },
  );
});

test("the Phase 1 validation method documents sources, privacy, review, restoration, and lifecycle separation", async () => {
  const method = await readFile(
    path.join(root, "docs/maintainers/phase-1-validation.md"),
    "utf8",
  );

  for (const source of [
    "clean-environment checks",
    "opt-in maintainer summaries",
    "public aggregate package trends",
    "voluntary GitHub feedback",
  ]) assert.match(method, new RegExp(source, "iu"));
  assert.match(method, /strict reviewed aggregate taxonomy/iu);
  assert.match(method, /reviewed pull request/iu);
  assert.match(method, /repository (?:identity|name)/iu);
  assert.match(method, /Report or Evidence/iu);
  assert.match(method, /credentials/iu);
  assert.match(method, /business payload/iu);
  assert.match(method, /verified-fix entry/iu);
  assert.match(method, /P1 Product Complete/iu);
  assert.match(method, /Experimental publication/iu);
  assert.match(method, /P1 Validated/iu);
  assert.match(method, /Stable-promotion/iu);
});
