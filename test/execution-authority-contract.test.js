import assert from "node:assert/strict";
import test from "node:test";

import {
  EXECUTION_AUTHORITY_CONTRACT,
  assertValidExecutionAuthority,
  assertValidExecutionAuthorityDescriptor,
} from "../packages/contracts/src/index.js";

test("execution authority v1 validates a ready Launcher-owned Engine", () => {
  const authority = {
    schema_version: "launchrally.dev/execution-authority/v1",
    state: "ready",
    source: "launcher",
    launcher_version: "0.2.2",
    engine: {
      package: "@launchrally/cli",
      version: "0.2.2",
      contract: "launchrally.dev/execution-authority/v1",
      compatibility: "native",
    },
    materialization: { state: "bundled" },
    reason: "launcher_selected",
    next_action: { operation: "none" },
  };

  assert.equal(EXECUTION_AUTHORITY_CONTRACT, authority.schema_version);
  assert.equal(assertValidExecutionAuthority(authority), true);
  assert.throws(
    () => assertValidExecutionAuthority({ ...authority, unexpected: true }),
    (error) => error.code === "invalid_execution_authority",
  );
});

test("the static authority descriptor names only the exact Engine interface", () => {
  const descriptor = {
    contract: "launchrally.dev/execution-authority/v1",
    engine: {
      package: "@launchrally/cli",
      version: "0.3.1",
      entrypoint: "bin/engine.js",
    },
  };

  assert.equal(assertValidExecutionAuthorityDescriptor(descriptor), true);
  assert.equal(assertValidExecutionAuthorityDescriptor({
    ...descriptor,
    engine: {
      ...descriptor.engine,
      version: "0.2.2",
      entrypoint: "bin/rally.js",
    },
  }), true);
  assert.throws(
    () => assertValidExecutionAuthorityDescriptor({
      ...descriptor,
      engine: { ...descriptor.engine, entrypoint: "bin/rally.js" },
    }),
    (error) => error.code === "invalid_execution_authority_descriptor",
  );
  assert.throws(
    () => assertValidExecutionAuthorityDescriptor({
      ...descriptor,
      engine: { ...descriptor.engine, entrypoint: "../../outside.js" },
    }),
    (error) => error.code === "invalid_execution_authority_descriptor",
  );
});

test("execution authority states permit only their compatible materialization and next action", () => {
  const base = {
    schema_version: EXECUTION_AUTHORITY_CONTRACT,
    source: "project_toolchain",
    launcher_version: "0.3.1",
    engine: {
      package: "@launchrally/cli",
      version: "0.2.2",
      contract: EXECUTION_AUTHORITY_CONTRACT,
      compatibility: "legacy_adapter",
    },
  };
  const states = [
    {
      state: "ready",
      materialization: { state: "ready" },
      reason: "legacy_project_engine_validated",
      next_action: { operation: "none" },
    },
    {
      state: "needs_toolchain_restore",
      materialization: { state: "missing" },
      reason: "legacy_materialization_missing",
      next_action: { operation: "toolchain_restore" },
    },
    {
      state: "needs_toolchain_migration",
      engine: {
        ...base.engine,
        contract: "launchrally.dev/execution-authority/v0",
        compatibility: "migration_required",
      },
      materialization: { state: "migration_required" },
      reason: "unsupported_engine_contract",
      next_action: { operation: "toolchain_migrate" },
    },
    {
      state: "invalid_toolchain",
      engine: { ...base.engine, compatibility: "incompatible" },
      materialization: { state: "invalid" },
      reason: "invalid_engine_materialization",
      next_action: { operation: "inspect_toolchain" },
    },
  ];

  for (const state of states) {
    const authority = { ...base, ...state };
    assert.equal(assertValidExecutionAuthority(authority), true);
    assert.throws(
      () => assertValidExecutionAuthority({
        ...authority,
        next_action: {
          operation: state.state === "ready" ? "toolchain_restore" : "none",
        },
      }),
      (error) => error.code === "invalid_execution_authority",
    );
  }
});

test("Launcher and Project ready states cannot exchange compatibility rules", () => {
  const launcher = {
    schema_version: EXECUTION_AUTHORITY_CONTRACT,
    state: "ready",
    source: "launcher",
    launcher_version: "0.3.1",
    engine: {
      package: "@launchrally/cli",
      version: "0.3.1",
      contract: EXECUTION_AUTHORITY_CONTRACT,
      compatibility: "native",
    },
    materialization: { state: "bundled" },
    reason: "launcher_selected",
    next_action: { operation: "none" },
  };

  assert.equal(assertValidExecutionAuthority(launcher), true);
  for (const invalid of [
    { ...launcher, materialization: { state: "ready" } },
    { ...launcher, engine: { ...launcher.engine, compatibility: "legacy_adapter" } },
    { ...launcher, engine: { ...launcher.engine, version: "0.2.2" } },
  ]) {
    assert.throws(
      () => assertValidExecutionAuthority(invalid),
      (error) => error.code === "invalid_execution_authority",
    );
  }

  const project = {
    ...launcher,
    source: "project_toolchain",
    engine: { ...launcher.engine, compatibility: "native" },
    materialization: { state: "ready" },
    reason: "project_engine_validated",
  };
  assert.equal(assertValidExecutionAuthority(project), true);
  assert.throws(
    () => assertValidExecutionAuthority({
      ...project,
      reason: "legacy_project_engine_validated",
    }),
    (error) => error.code === "invalid_execution_authority",
  );

  const migration = {
    ...project,
    state: "needs_toolchain_migration",
    engine: {
      ...project.engine,
      contract: "launchrally.dev/execution-authority/v0",
      compatibility: "migration_required",
    },
    materialization: { state: "migration_required" },
    reason: "unsupported_engine_contract",
    next_action: { operation: "toolchain_migrate" },
  };
  assert.equal(assertValidExecutionAuthority(migration), true);
  for (const contract of [EXECUTION_AUTHORITY_CONTRACT, null]) {
    assert.throws(
      () => assertValidExecutionAuthority({
        ...migration,
        engine: { ...migration.engine, contract },
      }),
      (error) => error.code === "invalid_execution_authority",
    );
  }
});
