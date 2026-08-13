import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  TASK_EFFECT_BOUNDARIES,
  computeExecutorDescriptorDigest,
} from "../packages/contracts/src/index.js";
import { runHandoff } from "../packages/core/src/index.js";
import { sha256 } from "../packages/core/src/local-history.js";

const fixture = JSON.parse(await readFile(
  new URL("./fixtures/phase-1-contracts/handoff.valid.json", import.meta.url),
  "utf8",
));
const execFileAsync = promisify(execFile);
const engine = path.resolve("packages/cli/bin/engine.js");
const cliClockArguments = [
  "--import",
  pathToFileURL(path.resolve("test/helpers/fixed-provider-knowledge-clock.js")).href,
];

function descriptor() {
  const value = structuredClone(fixture.executor);
  value.prohibited_effects = [...fixture.task_graph.tasks[0].prohibited_effects];
  value.tools = [{
    tool_id: "codex_cli",
    executable: "codex",
    exact_version: "0.147.0",
    installation_authority_id: "authority_codex_cli_v1",
  }];
  value.trust.digest = computeExecutorDescriptorDigest(value);
  return value;
}

function source() {
  const executor = descriptor();
  return {
    task_graph: structuredClone(fixture.task_graph),
    executor_descriptors: [executor],
    reviewed_executors: [{
      descriptor_id: executor.descriptor_id,
      descriptor_version: executor.descriptor_version,
      digest: executor.trust.digest,
    }],
    tool_observations: [{
      tool_id: "codex_cli",
      executable: "codex",
      detected_version: "0.147.0",
      state: "available",
    }],
  };
}

function stateStore() {
  let value;
  let currentTime = "2026-08-13T00:00:00.000Z";
  return {
    setNow(next) {
      currentTime = next;
    },
    mutateState(mutator) {
      mutator(value);
    },
    dependencies: {
      platform: "linux-x64",
      now: () => currentTime,
      store_state: async (next) => {
        value = structuredClone(next);
        return "handoff_resume_01";
      },
      load_state: async () => structuredClone(value),
      save_state: async (next) => {
        value = structuredClone(next);
      },
    },
  };
}

async function confirmedHandoff(store) {
  const discovered = await runHandoff(source(), {}, store.dependencies);
  const selected = await runHandoff({}, {
    resume_token: discovered.resume_token,
    selection: discovered.request.choices[0],
  }, store.dependencies);
  return runHandoff({}, {
    resume_token: selected.resume_token,
    confirmation: "confirm",
  }, store.dependencies);
}

function receiptFor(confirmed, state = "reported_succeeded") {
  return {
    schema_version: "launchrally.dev/execution-receipt/v1",
    receipt_id: "receipt_external_executor_01",
    handoff: {
      id: confirmed.handoff_package.handoff_id,
      schema_version: confirmed.handoff_package.schema_version,
      digest: sha256(confirmed.handoff_package),
    },
    executor: structuredClone(confirmed.handoff_package.executor),
    reported_at: "2026-08-13T00:01:00.000Z",
    task_results: [{
      task_id: "task_configure_identity",
      state,
      claim_codes: [claimCodeForState(state)],
    }],
    classification: {
      claim_only: true,
      machine_evidence: false,
      verification_status: "unverified",
    },
    retention: {
      raw_stdout_retained: false,
      raw_stderr_retained: false,
      response_body_retained: false,
      sensitive_data_retained: false,
    },
  };
}

function claimCodeForState(state) {
  return state === "reported_succeeded"
    ? "configuration_submitted"
    : state === "reported_failed"
      ? "execution_failed"
      : state === "cancelled" ? "execution_cancelled" : "execution_partial";
}

test("Executor discovery exposes compatible authority batches without granting authority", async () => {
  const store = stateStore();
  const result = await runHandoff(source(), {}, store.dependencies);

  assert.equal(result.contract, "launchrally.dev/handoff-interaction/v1");
  assert.equal(result.status, "needs_input");
  assert.equal(result.state, "executor_discovery");
  assert.equal(result.resume_token, "handoff_resume_01");
  assert.equal(result.handoff_package, undefined);
  assert.deepEqual(result.request.choices, ["batch_executor_provider_config_task_configure_identity"]);
  assert.deepEqual(result.candidates[0], {
    batch_id: "batch_executor_provider_config_task_configure_identity",
    executor_id: "executor_provider_config",
    task_ids: ["task_configure_identity"],
    environment: "production",
    effect_class: "provider_configuration",
    target: "identity_authentication",
    available: true,
    cancellation: "supported_between_effects",
    task_cancellation_behaviors: ["stop_before_next_effect"],
    partial_failure: "reported_per_task",
    tools: [{
      tool_id: "codex_cli",
      executable: "codex",
      exact_version: "0.147.0",
    }],
    auth_assumptions: ["user_completes_login_outside_launchrally"],
    authentication_state: "user_managed_unverified",
    secret_handling: "external_reference_only",
    recommended: true,
  });
  assert.deepEqual(result.safety, {
    installation_executed: false,
    login_initiated: false,
    credentials_requested: false,
    external_task_executed: false,
    authority_granted: false,
  });
});

test("selecting a compatible batch previews one exact unapproved Handoff Package", async () => {
  const store = stateStore();
  const discovered = await runHandoff(source(), {}, store.dependencies);
  const selected = await runHandoff({}, {
    resume_token: discovered.resume_token,
    selection: discovered.request.choices[0],
  }, store.dependencies);

  assert.equal(selected.status, "needs_confirmation");
  assert.equal(selected.state, "authority_preview");
  assert.deepEqual(selected.request, {
    kind: "authority_confirmation",
    choices: ["confirm", "deny", "cancel"],
  });
  assert.equal(selected.handoff_package.approval.state, "required");
  assert.equal(selected.handoff_package.approval.confirmation, null);
  assert.equal(selected.handoff_package.approval.confirmed_at, null);
  assert.deepEqual(selected.handoff_package.task_ids, ["task_configure_identity"]);
  assert.deepEqual(selected.handoff_package.authority_batch, {
    effect_classes: ["provider_configuration"],
    target: "identity_authentication",
    allowed_effects: ["provider_configuration_write"],
    prohibited_effects: [
      "credential_persistence",
      "deployment_write",
      "production_data_write",
      "source_write",
    ],
    user_visible_effects: [
      "The external Executor may perform provider_configuration_write on identity_authentication.",
    ],
    coordination: {
      cancellation: "supported_between_effects",
      task_cancellation_behaviors: ["stop_before_next_effect"],
      partial_failure: "reported_per_task",
    },
    executor_requirements: {
      tools: [{
        tool_id: "codex_cli",
        executable: "codex",
        exact_version: "0.147.0",
      }],
      auth_assumptions: ["user_completes_login_outside_launchrally"],
      authentication_state: "user_managed_unverified",
      secret_handling: "external_reference_only",
    },
  });
  assert.equal(selected.safety.authority_granted, false);
});

test("explicit confirmation grants only the previewed external authority without execution", async () => {
  const store = stateStore();
  const discovered = await runHandoff(source(), {}, store.dependencies);
  const selected = await runHandoff({}, {
    resume_token: discovered.resume_token,
    selection: discovered.request.choices[0],
  }, store.dependencies);
  const confirmed = await runHandoff({}, {
    resume_token: selected.resume_token,
    confirmation: "confirm",
  }, store.dependencies);

  assert.equal(confirmed.status, "resumable");
  assert.equal(confirmed.state, "receipt_review");
  assert.equal(confirmed.handoff_package.approval.state, "approved");
  assert.equal(
    confirmed.handoff_package.approval.confirmation,
    "explicit_user_confirmation",
  );
  assert.equal(confirmed.handoff_package.approval.confirmed_at, "2026-08-13T00:00:00.000Z");
  assert.deepEqual(confirmed.request, {
    kind: "execution_receipt",
    choices: ["submit", "defer", "cancel"],
  });
  assert.deepEqual(confirmed.safety, {
    installation_executed: false,
    login_initiated: false,
    credentials_requested: false,
    external_task_executed: false,
    authority_granted: true,
  });
});

test("confirmed external coordination can be deferred or cancelled before receipt acceptance", async () => {
  for (const choice of ["defer", "cancel"]) {
    const store = stateStore();
    const confirmed = await confirmedHandoff(store);
    const outcome = await runHandoff({}, {
      resume_token: confirmed.resume_token,
      choice,
    }, store.dependencies);

    assert.equal(outcome.status, choice === "defer" ? "resumable" : "cancelled");
    assert.equal(outcome.execution_receipt, undefined);
    assert.equal(outcome.safety.external_task_executed, false);
    assert.equal(outcome.safety.authority_granted, true);
  }
});

test("denial and cancellation terminate before any external authority is granted", async () => {
  for (const confirmation of ["deny", "cancel"]) {
    const store = stateStore();
    const discovered = await runHandoff(source(), {}, store.dependencies);
    const selected = await runHandoff({}, {
      resume_token: discovered.resume_token,
      selection: discovered.request.choices[0],
    }, store.dependencies);
    const outcome = await runHandoff({}, {
      resume_token: selected.resume_token,
      confirmation,
    }, store.dependencies);

    assert.equal(outcome.status, confirmation === "deny" ? "denied" : "cancelled");
    assert.equal(outcome.resume_token, null);
    assert.equal(outcome.handoff_package.approval.state, confirmation === "deny" ? "denied" : "cancelled");
    assert.equal(outcome.safety.authority_granted, false);
  }
});

test("a normalized receipt remains a claim and produces only unverified Task updates", async () => {
  const store = stateStore();
  const confirmed = await confirmedHandoff(store);
  const receipt = receiptFor(confirmed);
  const reviewed = await runHandoff({}, {
    resume_token: confirmed.resume_token,
    receipt,
  }, store.dependencies);

  assert.equal(reviewed.status, "partial_completion");
  assert.equal(reviewed.state, "receipt_review");
  assert.equal(reviewed.execution_receipt.classification.machine_evidence, false);
  assert.equal(reviewed.execution_receipt.classification.verification_status, "unverified");
  assert.deepEqual(reviewed.task_updates, [{
    task_id: "task_configure_identity",
    status: "reported_succeeded",
  }]);
  assert.equal(reviewed.task_updates[0].verification_evidence, undefined);
  assert.deepEqual(reviewed.request, {
    kind: "fresh_verification",
    choices: ["verify", "defer", "cancel"],
  });

  for (const unsafeField of [
    { raw_stdout: "credential-shaped output" },
    { raw_stderr: "provider diagnostic" },
    { response_body: { status: "ok" } },
    { credentials: { reference: "credential_01" } },
    { business_payload: { order_id: "order_01" } },
  ]) {
    const unsafeStore = stateStore();
    const unsafeConfirmed = await confirmedHandoff(unsafeStore);
    const unsafeReceipt = { ...receiptFor(unsafeConfirmed), ...unsafeField };
    const rejected = await runHandoff({}, {
      resume_token: unsafeConfirmed.resume_token,
      receipt: unsafeReceipt,
    }, unsafeStore.dependencies);
    assert.equal(rejected.status, "execution_error");
    assert.equal(rejected.error, "invalid_execution_receipt");
  }

  const secretStore = stateStore();
  const secretConfirmed = await confirmedHandoff(secretStore);
  const secretReceipt = receiptFor(secretConfirmed);
  secretReceipt.task_results[0].claim_codes = ["ghp_012345678901234567890123456789012345"];
  const secretRejected = await runHandoff({}, {
    resume_token: secretConfirmed.resume_token,
    receipt: secretReceipt,
  }, secretStore.dependencies);
  assert.equal(secretRejected.error, "invalid_execution_receipt");
});

test("partial failure stays typed and cannot be promoted to Evidence", async () => {
  const store = stateStore();
  const confirmed = await confirmedHandoff(store);
  const reviewed = await runHandoff({}, {
    resume_token: confirmed.resume_token,
    receipt: receiptFor(confirmed, "partial"),
  }, store.dependencies);

  assert.equal(reviewed.status, "partial_completion");
  assert.equal(reviewed.execution_receipt.task_results[0].state, "partial");
  assert.deepEqual(reviewed.task_updates, [{
    task_id: "task_configure_identity",
    status: "reported_failed",
  }]);
  assert.deepEqual(reviewed.execution_outcomes, [{
    task_id: "task_configure_identity",
    receipt_state: "partial",
    claim_codes: ["execution_partial"],
    remaining_work: {
      state: "required",
      coordination: "retry_unfinished_effects",
    },
  }]);
  assert.equal(reviewed.task_updates[0].verification_evidence, undefined);
});

test("receipt review can defer, cancel, or route to fresh Verify without changing the claim", async () => {
  for (const choice of ["verify", "defer", "cancel"]) {
    const store = stateStore();
    const confirmed = await confirmedHandoff(store);
    const receipt = {
      ...structuredClone(fixture.receipt),
      handoff: {
        id: confirmed.handoff_package.handoff_id,
        schema_version: confirmed.handoff_package.schema_version,
        digest: sha256(confirmed.handoff_package),
      },
      executor: structuredClone(confirmed.handoff_package.executor),
      reported_at: "2026-08-13T00:01:00.000Z",
    };
    const reviewed = await runHandoff({}, {
      resume_token: confirmed.resume_token,
      receipt,
    }, store.dependencies);
    const outcome = await runHandoff({}, {
      resume_token: reviewed.resume_token,
      choice,
    }, store.dependencies);

    assert.equal(outcome.status, choice === "defer" ? "resumable" : choice === "cancel" ? "cancelled" : "completed");
    assert.equal(outcome.execution_receipt.classification.machine_evidence, false);
    assert.equal(outcome.task_updates[0].status, "reported_succeeded");
    assert.equal(outcome.task_updates[0].verification_evidence, undefined);
    if (choice === "verify") {
      assert.deepEqual(outcome.next, {
        operation: "verify",
        scope: "targeted",
        task_requests: [{
          task_id: "task_configure_identity",
          scope: "identity_authentication",
          evidence_targets: ["identity_configuration"],
        }],
        fresh_evidence_required: true,
      });
    }
  }
});

test("Tasks batch only across the same real authority boundary and prefer the narrowest Executor", async () => {
  const handoffSource = source();
  const configure = handoffSource.task_graph.tasks[0];
  const secondConfigure = {
    ...structuredClone(configure),
    task_id: "task_configure_identity_second",
    source_id: "decision_identity_second",
  };
  const deployment = {
    ...structuredClone(configure),
    task_id: "task_deploy_production_site",
    task_type: "deploy_capability",
    source_id: "decision_production_site",
    effect_class: "deployment",
    expected_target: "production_site",
    allowed_effects: [...TASK_EFFECT_BOUNDARIES.deployment.allowed_effects],
    prohibited_effects: [...TASK_EFFECT_BOUNDARIES.deployment.prohibited_effects],
    minimum_executor_capability: "deployment_v1",
  };
  handoffSource.task_graph.tasks.push(secondConfigure, deployment);
  handoffSource.task_graph.ready_frontier.push(
    secondConfigure.task_id,
    deployment.task_id,
  );
  handoffSource.task_graph.ready_frontier.sort();

  const broad = descriptor();
  broad.descriptor_id = "executor_broad_configuration";
  broad.supported_task_types.push("unrelated_task_type");
  broad.trust.digest = computeExecutorDescriptorDigest(broad);
  const deployer = descriptor();
  deployer.descriptor_id = "executor_deployment";
  deployer.supported_task_types = [deployment.task_type];
  deployer.allowed_effects = [...deployment.allowed_effects];
  deployer.prohibited_effects = [...deployment.prohibited_effects];
  deployer.trust.digest = computeExecutorDescriptorDigest(deployer);
  handoffSource.executor_descriptors.push(broad, deployer);
  handoffSource.reviewed_executors.push(...[broad, deployer].map((executor) => ({
    descriptor_id: executor.descriptor_id,
    descriptor_version: executor.descriptor_version,
    digest: executor.trust.digest,
  })));

  const store = stateStore();
  const result = await runHandoff(handoffSource, {}, store.dependencies);
  const configurationBatch = result.candidates.find(({ executor_id: id }) =>
    id === "executor_provider_config");
  const broadBatch = result.candidates.find(({ executor_id: id }) =>
    id === "executor_broad_configuration");
  const deploymentBatch = result.candidates.find(({ executor_id: id }) =>
    id === "executor_deployment");

  assert.deepEqual(configurationBatch.task_ids, [
    "task_configure_identity",
    "task_configure_identity_second",
  ]);
  assert.equal(configurationBatch.recommended, true);
  assert.equal(broadBatch.recommended, false);
  assert.deepEqual(deploymentBatch.task_ids, ["task_deploy_production_site"]);
  assert.notEqual(configurationBatch.batch_id, deploymentBatch.batch_id);
  assert.deepEqual(
    [...new Set(result.candidates.map(({ effect_class: effect }) => effect))].sort(),
    ["deployment", "provider_configuration"],
  );
});

test("every ordinary write effect class is disclosed in a separately approvable batch", async () => {
  const effectClasses = [
    "local_source",
    "provider_configuration",
    "secret",
    "deployment",
    "production_data",
  ];
  const handoffSource = source();
  const template = handoffSource.task_graph.tasks[0];
  handoffSource.task_graph.tasks = effectClasses.map((effectClass) => ({
    ...structuredClone(template),
    task_id: `task_${effectClass}`,
    task_type: `perform_${effectClass}`,
    source_id: `decision_${effectClass}`,
    effect_class: effectClass,
    expected_target: `target_${effectClass}`,
    allowed_effects: [...TASK_EFFECT_BOUNDARIES[effectClass].allowed_effects],
    prohibited_effects: [...TASK_EFFECT_BOUNDARIES[effectClass].prohibited_effects],
    minimum_executor_capability: `${effectClass}_v1`,
  }));
  handoffSource.task_graph.ready_frontier = handoffSource.task_graph.tasks
    .map(({ task_id: id }) => id)
    .sort();
  handoffSource.executor_descriptors = handoffSource.task_graph.tasks.map((task) => {
    const executor = descriptor();
    executor.descriptor_id = `executor_${task.effect_class}`;
    executor.executor_name = `${task.effect_class} test executor`;
    executor.supported_task_types = [task.task_type];
    executor.allowed_effects = [...task.allowed_effects];
    executor.prohibited_effects = [...task.prohibited_effects];
    executor.trust.digest = computeExecutorDescriptorDigest(executor);
    return executor;
  });
  handoffSource.reviewed_executors = handoffSource.executor_descriptors.map((executor) => ({
    descriptor_id: executor.descriptor_id,
    descriptor_version: executor.descriptor_version,
    digest: executor.trust.digest,
  }));

  const discovered = await runHandoff(handoffSource, {}, stateStore().dependencies);
  assert.equal(discovered.candidates.length, effectClasses.length);
  assert.deepEqual(
    discovered.candidates.map(({ effect_class: effect }) => effect).sort(),
    [...effectClasses].sort(),
  );
  assert.equal(new Set(discovered.request.choices).size, effectClasses.length);

  for (const effectClass of effectClasses) {
    const store = stateStore();
    const initial = await runHandoff(handoffSource, {}, store.dependencies);
    const candidate = initial.candidates.find(({ effect_class: effect }) => effect === effectClass);
    const preview = await runHandoff({}, {
      resume_token: initial.resume_token,
      selection: candidate.batch_id,
    }, store.dependencies);
    assert.deepEqual(preview.handoff_package.authority_batch.effect_classes, [effectClass]);
    assert.deepEqual(
      preview.handoff_package.authority_batch.allowed_effects,
      TASK_EFFECT_BOUNDARIES[effectClass].allowed_effects,
    );
    assert.equal(preview.handoff_package.authority_batch.target, `target_${effectClass}`);
    assert.equal(preview.handoff_package.approval.state, "required");
  }
});

test("ordinary Handoff leaves active tests to the Active Verification interface", async () => {
  const handoffSource = source();
  const task = handoffSource.task_graph.tasks[0];
  task.task_id = "task_active_test";
  task.task_type = "actively_verify_webhook";
  task.effect_class = "active_test";
  task.allowed_effects = [...TASK_EFFECT_BOUNDARIES.active_test.allowed_effects];
  task.prohibited_effects = [...TASK_EFFECT_BOUNDARIES.active_test.prohibited_effects];
  handoffSource.task_graph.tasks = [task];
  handoffSource.task_graph.ready_frontier = [task.task_id];
  handoffSource.executor_descriptors[0].supported_task_types = [task.task_type];
  handoffSource.executor_descriptors[0].allowed_effects = [...task.allowed_effects];
  handoffSource.executor_descriptors[0].prohibited_effects = [...task.prohibited_effects];
  handoffSource.executor_descriptors[0].trust.digest = computeExecutorDescriptorDigest(
    handoffSource.executor_descriptors[0],
  );
  handoffSource.reviewed_executors[0].digest =
    handoffSource.executor_descriptors[0].trust.digest;

  const result = await runHandoff(handoffSource, {}, stateStore().dependencies);
  assert.equal(result.status, "needs_input");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.manual_path.authority_granted, false);
});

test("a missing Executor tool offers only reviewed guidance, manual instructions, defer, or cancel", async () => {
  const handoffSource = source();
  handoffSource.tool_observations = [{
    tool_id: "codex_cli",
    executable: "codex",
    detected_version: null,
    state: "missing",
  }];
  const store = stateStore();
  const missing = await runHandoff(handoffSource, {}, store.dependencies);

  assert.equal(missing.status, "needs_input");
  assert.deepEqual(missing.request.choices, [
    "show_install_instructions",
    "open_official_manual",
    "defer",
    "cancel",
  ]);
  assert.equal(missing.recovery.reason, "missing_tool");
  assert.equal(
    missing.recovery.official_manual.url,
    "https://developers.openai.com/codex/cli",
  );
  assert.deepEqual(missing.recovery.installation_instructions, []);
  assert.equal(missing.safety.installation_executed, false);

  const guidance = await runHandoff({}, {
    resume_token: missing.resume_token,
    choice: "show_install_instructions",
  }, store.dependencies);
  assert.equal(guidance.status, "needs_input");
  assert.deepEqual(guidance.recovery.installation_instructions, [{
    route_id: "npm_global_exact",
    command: {
      executable: "npm",
      arguments: ["install", "--global", "@openai/codex@0.147.0"],
      shell: false,
    },
  }]);
  assert.equal(guidance.safety.installation_executed, false);
  assert.equal(guidance.safety.authority_granted, false);
});

test("unsupported versions and platforms are reported as distinct typed recovery states", async () => {
  const unsupportedVersion = source();
  unsupportedVersion.tool_observations[0] = {
    tool_id: "codex_cli",
    executable: "codex",
    detected_version: "0.146.0",
    state: "unsupported_version",
  };
  const versionResult = await runHandoff(unsupportedVersion, {}, stateStore().dependencies);
  assert.equal(versionResult.candidates[0].unavailable_reason, "unsupported_version");
  assert.equal(versionResult.recovery.reason, "unsupported_version");

  const platformResult = await runHandoff(source(), {}, {
    ...stateStore().dependencies,
    platform: "freebsd-x64",
  });
  assert.equal(platformResult.candidates[0].unavailable_reason, "unsupported_platform");
  assert.equal(platformResult.recovery.reason, "unsupported_platform");
});

test("Executor cancellation and partial-failure semantics are compatibility and receipt boundaries", async () => {
  const unsupported = source();
  unsupported.executor_descriptors[0].cancellation = "unsupported";
  unsupported.executor_descriptors[0].trust.digest = computeExecutorDescriptorDigest(
    unsupported.executor_descriptors[0],
  );
  unsupported.reviewed_executors[0].digest = unsupported.executor_descriptors[0].trust.digest;
  const unsupportedResult = await runHandoff(unsupported, {}, stateStore().dependencies);
  assert.deepEqual(unsupportedResult.candidates, []);
  assert.deepEqual(unsupportedResult.request.choices, ["manual_or_custom", "defer", "cancel"]);

  const allOrNothing = source();
  allOrNothing.executor_descriptors[0].partial_failure = "all_or_nothing";
  allOrNothing.executor_descriptors[0].trust.digest = computeExecutorDescriptorDigest(
    allOrNothing.executor_descriptors[0],
  );
  allOrNothing.reviewed_executors[0].digest = allOrNothing.executor_descriptors[0].trust.digest;
  const store = stateStore();
  const discovered = await runHandoff(allOrNothing, {}, store.dependencies);
  const selected = await runHandoff({}, {
    resume_token: discovered.resume_token,
    selection: discovered.request.choices[0],
  }, store.dependencies);
  assert.equal(
    selected.handoff_package.authority_batch.coordination.partial_failure,
    "all_or_nothing",
  );
  const confirmed = await runHandoff({}, {
    resume_token: selected.resume_token,
    confirmation: "confirm",
  }, store.dependencies);
  const rejected = await runHandoff({}, {
    resume_token: confirmed.resume_token,
    receipt: receiptFor(confirmed, "partial"),
  }, store.dependencies);
  assert.equal(rejected.error, "execution_receipt_partial_failure_mismatch");

  const mixedSource = source();
  const secondTask = {
    ...structuredClone(mixedSource.task_graph.tasks[0]),
    task_id: "task_configure_identity_second",
    source_id: "decision_identity_second",
  };
  mixedSource.task_graph.tasks.push(secondTask);
  mixedSource.task_graph.ready_frontier.push(secondTask.task_id);
  mixedSource.task_graph.ready_frontier.sort();
  mixedSource.executor_descriptors[0].partial_failure = "all_or_nothing";
  mixedSource.executor_descriptors[0].trust.digest = computeExecutorDescriptorDigest(
    mixedSource.executor_descriptors[0],
  );
  mixedSource.reviewed_executors[0].digest =
    mixedSource.executor_descriptors[0].trust.digest;
  const mixedStore = stateStore();
  const mixedDiscovered = await runHandoff(mixedSource, {}, mixedStore.dependencies);
  const mixedSelected = await runHandoff({}, {
    resume_token: mixedDiscovered.resume_token,
    selection: mixedDiscovered.request.choices[0],
  }, mixedStore.dependencies);
  const mixedConfirmed = await runHandoff({}, {
    resume_token: mixedSelected.resume_token,
    confirmation: "confirm",
  }, mixedStore.dependencies);
  const mixedReceipt = receiptFor(mixedConfirmed);
  mixedReceipt.task_results = mixedConfirmed.handoff_package.task_ids.map((taskId, index) => ({
    task_id: taskId,
    state: index === 0 ? "reported_succeeded" : "reported_failed",
    claim_codes: [index === 0 ? "configuration_submitted" : "execution_failed"],
  }));
  const mixedRejected = await runHandoff({}, {
    resume_token: mixedConfirmed.resume_token,
    receipt: mixedReceipt,
  }, mixedStore.dependencies);
  assert.equal(mixedRejected.error, "execution_receipt_partial_failure_mismatch");
});

test("no compatible managed Executor retains only a no-authority manual/custom path", async () => {
  const handoffSource = source();
  handoffSource.executor_descriptors = [];
  handoffSource.reviewed_executors = [];
  handoffSource.tool_observations = [];
  const store = stateStore();
  const missing = await runHandoff(handoffSource, {}, store.dependencies);

  assert.equal(missing.status, "needs_input");
  assert.deepEqual(missing.request.choices, ["manual_or_custom", "defer", "cancel"]);
  assert.equal(missing.recovery, null);
  assert.equal(missing.manual_path.available, true);
  assert.equal(missing.manual_path.authority_granted, false);

  const manual = await runHandoff({}, {
    resume_token: missing.resume_token,
    choice: "manual_or_custom",
  }, store.dependencies);
  assert.equal(manual.outcome, "manual_or_custom_selected");
  assert.equal(manual.manual_path.authority_granted, false);
  assert.equal(manual.manual_path.external_execution_started, false);
});

test("tampered, expired, or unreviewed Executor Descriptors cannot participate", async () => {
  for (const mutation of [
    (handoffSource) => {
      handoffSource.executor_descriptors[0].executor_name = "Tampered executor";
    },
    (handoffSource) => {
      handoffSource.executor_descriptors[0].trust.expires_at = "2026-08-12T23:59:59.000Z";
      handoffSource.executor_descriptors[0].trust.digest = computeExecutorDescriptorDigest(
        handoffSource.executor_descriptors[0],
      );
    },
    (handoffSource) => {
      handoffSource.reviewed_executors = [];
    },
    (handoffSource) => {
      handoffSource.executor_descriptors[0].trust.tier = "core_catalog";
      handoffSource.executor_descriptors[0].trust.digest = computeExecutorDescriptorDigest(
        handoffSource.executor_descriptors[0],
      );
      handoffSource.reviewed_executors = [];
    },
  ]) {
    const handoffSource = source();
    mutation(handoffSource);
    const store = stateStore();
    const result = await runHandoff(handoffSource, {}, store.dependencies);
    if (result.status === "execution_error") {
      assert.equal(result.error, "invalid_executor_descriptor");
    } else {
      assert.deepEqual(result.candidates, []);
      assert.equal(result.safety.authority_granted, false);
    }
  }
});

test("resuming after descriptor expiry fails closed without preserving the earlier preview", async () => {
  const store = stateStore();
  const discovered = await runHandoff(source(), {}, store.dependencies);
  store.setNow("2026-11-12T00:00:00.000Z");
  const stale = await runHandoff({}, {
    resume_token: discovered.resume_token,
    selection: discovered.request.choices[0],
  }, store.dependencies);

  assert.equal(stale.status, "stale_input");
  assert.equal(stale.error, "handoff_inputs_stale");
  assert.deepEqual(stale.request.choices, ["refresh", "cancel"]);
  assert.equal(stale.safety.authority_granted, false);
});

test("cross-session resume rederives discovery and package bindings before continuing", async () => {
  const store = stateStore();
  const discovered = await runHandoff(source(), {}, store.dependencies);
  store.mutateState((state) => {
    state.candidates[0].target = "different_target";
  });
  const rejectedDiscovery = await runHandoff({}, {
    resume_token: discovered.resume_token,
    selection: discovered.request.choices[0],
  }, store.dependencies);
  assert.equal(rejectedDiscovery.error, "invalid_handoff_resume_state");

  const packageStore = stateStore();
  const initial = await runHandoff(source(), {}, packageStore.dependencies);
  const selected = await runHandoff({}, {
    resume_token: initial.resume_token,
    selection: initial.request.choices[0],
  }, packageStore.dependencies);
  packageStore.mutateState((state) => {
    state.handoff_package.authority_batch.allowed_effects = ["deployment_write"];
  });
  const rejectedPackage = await runHandoff({}, {
    resume_token: selected.resume_token,
    confirmation: "confirm",
  }, packageStore.dependencies);
  assert.equal(rejectedPackage.error, "invalid_handoff_resume_state");
});

test("opaque handoff state resumes across independent Core calls", async () => {
  const initial = await runHandoff(source(), {}, {
    platform: "linux-x64",
    now: "2026-08-13T00:00:00.000Z",
  });
  assert.match(initial.resume_token, /^lrhandoff_/u);

  const resumed = await runHandoff({}, {
    resume_token: initial.resume_token,
    selection: initial.request.choices[0],
  }, {
    platform: "linux-x64",
    now: "2026-08-13T00:00:00.000Z",
  });
  assert.equal(resumed.status, "needs_confirmation");
  assert.equal(resumed.state, "authority_preview");
});

test("Claude Handoff state resumes in Codex from one validated local artifact", async () => {
  const claude = await import("../adapters/claude/launchrally/host-adapter/resume.js");
  const codex = await import("../adapters/codex/launchrally/host-adapter/resume.js");
  const discovered = await runHandoff(source(), {}, {
    platform: "linux-x64",
    now: "2026-08-13T00:00:00.000Z",
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-handoff-resume-"));
  const artifactPath = path.join(directory, "handoff-resume.json");
  await mkdir(path.join(directory, ".launchrally", "phase-1", "transactions"), {
    recursive: true,
  });
  await writeFile(
    path.join(directory, ".launchrally", "phase-1", "transactions", ".host-resume-key"),
    Buffer.alloc(32, 1),
    { mode: 0o600 },
  );
  await claude.saveResumeArtifact(artifactPath, discovered.interaction, directory);
  const resumed = await codex.resumeArtifactFile({
    cwd: directory,
    artifact_path: artifactPath,
    options: { selection: discovered.request.choices[0] },
  });
  assert.equal(resumed.status, "needs_confirmation", JSON.stringify(resumed));
  assert.equal(resumed.state, "authority_preview");
  assert.equal(resumed.handoff_package.approval.state, "required");
});

test("the public JSON CLI exposes typed discovery and resumable authority preview", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-handoff-cli-"));
  const handoffSource = source();
  handoffSource.executor_descriptors[0].platforms = [`${process.platform}-${process.arch}`];
  handoffSource.executor_descriptors[0].trust.digest = computeExecutorDescriptorDigest(
    handoffSource.executor_descriptors[0],
  );
  handoffSource.reviewed_executors[0].digest = handoffSource.executor_descriptors[0].trust.digest;
  const graphPath = path.join(directory, "task-graph.json");
  const executorsPath = path.join(directory, "executors.json");
  const toolsPath = path.join(directory, "tools.json");
  const reviewsPath = path.join(directory, "reviews.json");
  await Promise.all([
    writeFile(graphPath, JSON.stringify(handoffSource.task_graph)),
    writeFile(executorsPath, JSON.stringify(handoffSource.executor_descriptors)),
    writeFile(toolsPath, JSON.stringify(handoffSource.tool_observations)),
    writeFile(reviewsPath, JSON.stringify(handoffSource.reviewed_executors)),
  ]);

  const discovered = JSON.parse((await execFileAsync(process.execPath, [
    ...cliClockArguments,
    engine,
    "handoff",
    "--json",
    "--task-graph",
    graphPath,
    "--executors",
    executorsPath,
    "--tools",
    toolsPath,
    "--reviewed-executors",
    reviewsPath,
  ])).stdout);
  assert.equal(discovered.status, "needs_input");
  assert.equal(discovered.state, "executor_discovery");

  const preview = JSON.parse((await execFileAsync(process.execPath, [
    ...cliClockArguments,
    engine,
    "handoff",
    "--json",
    "--resume",
    discovered.resume_token,
    "--select",
    discovered.request.choices[0],
  ])).stdout);
  assert.equal(preview.status, "needs_confirmation");
  assert.equal(preview.handoff_package.approval.state, "required");

  const human = await execFileAsync(process.execPath, [
    ...cliClockArguments,
    engine,
    "handoff",
    "--task-graph",
    graphPath,
    "--executors",
    executorsPath,
    "--tools",
    toolsPath,
    "--reviewed-executors",
    reviewsPath,
  ]);
  assert.match(human.stdout, /LaunchRally External Executor Handoff/u);
  assert.match(human.stdout, /does not install, log in, request credentials, or execute/u);
  assert.match(human.stdout, /provider_configuration on identity_authentication/u);
  assert.match(human.stdout, /cancellation supported_between_effects/u);
  assert.match(human.stdout, /partial failure reported_per_task/u);
  assert.match(human.stdout, /authentication user_managed_unverified/u);
  assert.match(human.stdout, /secret handling external_reference_only/u);
});
