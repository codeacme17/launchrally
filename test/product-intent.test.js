import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertValidArchitectInteraction,
} from "../packages/contracts/src/index.js";
import {
  runProductIntentDiscovery,
} from "../packages/core/src/index.js";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-intent-"));
  await writeFile(path.join(directory, "package.json"), `${JSON.stringify({
    name: "subscription-product",
    scripts: { build: "vite build" },
    dependencies: { "@clerk/backend": "1.0.0", stripe: "1.0.0" },
  }, null, 2)}\n`);
  await writeFile(path.join(directory, "package-lock.json"), `${JSON.stringify({
    name: "subscription-product",
    lockfileVersion: 3,
    packages: { "": {} },
  }, null, 2)}\n`);
  await writeFile(
    path.join(directory, ".env.example"),
    "CLERK_SECRET_KEY=\nSTRIPE_SECRET_KEY=\n",
  );
  await mkdir(path.join(directory, "docs"));
  await writeFile(
    path.join(directory, "docs", "product.md"),
    "# Product\nCustomers sign in, subscribe, upload files, and receive email receipts.\n",
  );
  return directory;
}

test("Product Intent discovery requests semantic permission before reading selected material", async () => {
  const directory = await fixture();

  const result = await runProductIntentDiscovery(directory, {
    selected_materials: ["docs/product.md"],
  });

  assert.equal(result.contract, "launchrally.dev/architect-interaction/v1");
  assert.equal(result.status, "needs_permission");
  assert.equal(result.operation, "architect");
  assert.equal(result.state, "intent_discovery");
  assert.deepEqual(result.request.permissions, [{
    permission_id: "local_semantic_analysis",
    boundary: "selected_local_content",
    target_scope: ["docs/product.md"],
    analyzer: {
      id: "launchrally-product-intent-analyzer",
      version: "product-intent-analyzer/v1",
    },
    normalized_facts: [
      "behavior_candidates",
      "obligation_candidates",
      "intent_conflicts",
      "source_provenance",
      "coverage",
    ],
    exclusions: [
      "raw_source",
      "unrestricted_model_summary",
      "secret_values",
      "business_payloads",
      "real_user_data",
    ],
    retention: "normalized_facts_only",
    coverage_limitations: [
      "Only explicitly selected supported text materials are analyzed.",
      "Unsupported or unreadable material remains uncovered and cannot prove absence.",
    ],
    decision: "pending",
  }]);
  assert.ok(result.resume_token.length > 20);
  assert.equal(assertValidArchitectInteraction(result.interaction), true);
  const persistedState = Buffer.from(result.resume_token.split(".")[0], "base64url")
    .toString("utf8");
  assert.equal(persistedState.includes("Customers sign in"), false);
});

test("approved semantic analysis produces normalized candidates and a confirmed profile", async () => {
  const directory = await fixture();
  const initial = await runProductIntentDiscovery(directory, {
    selected_materials: ["docs/product.md"],
  });

  const input = await runProductIntentDiscovery(directory, {
    resume_token: initial.resume_token,
    permission_decision: "approved",
  });

  assert.equal(input.status, "needs_input");
  assert.equal(assertValidArchitectInteraction(input.interaction), true);
  assert.deepEqual(
    input.candidates.behaviors.map(({ behavior_id: behaviorId }) => behaviorId),
    [
      "customers_purchase_subscription",
      "customers_receive_transactional_email",
      "customers_sign_in",
      "customers_upload_objects",
    ],
  );
  assert.equal(input.coverage.state, "complete");
  assert.equal(input.coverage.negative_findings_allowed, false);
  assert.deepEqual(input.request.fields.map(({ field_id: fieldId }) => fieldId), [
    "intended_environment",
    "confirmed_behaviors",
    "hard_constraints",
    "preferences",
  ]);
  assert.deepEqual(
    input.request.fields.find(({ field_id: fieldId }) =>
      fieldId === "confirmed_behaviors").suggested_values,
    [
      ...input.candidates.behaviors.map(({ behavior_id: behaviorId }) => behaviorId),
      "teams_collaborate_in_realtime",
    ].sort(),
  );

  const preview = await runProductIntentDiscovery(directory, {
    resume_token: input.resume_token,
    answers: {
      intended_environment: "production",
      confirmed_behaviors: input.candidates.behaviors.map(({ behavior_id: id }) => id),
      hard_constraints: ["data_residency_eu"],
      preferences: ["managed_operations"],
    },
  });
  assert.equal(preview.status, "needs_confirmation");
  assert.equal(assertValidArchitectInteraction(preview.interaction), true);
  assert.equal(preview.preview.desired_intent.confirmation, "unconfirmed");

  const completed = await runProductIntentDiscovery(directory, {
    resume_token: preview.resume_token,
    confirmation: "confirm",
  });
  assert.equal(completed.status, "completed");
  assert.equal(assertValidArchitectInteraction(completed.interaction), true);
  assert.equal(completed.profile.desired_intent.confirmation, "confirmed");
  assert.equal(completed.profile.coverage.state, "complete");
  assert.equal(JSON.stringify(completed).includes("Customers sign in"), false);
  assert.equal(Object.hasOwn(completed.profile, "raw_source"), false);
});

test("discovery completes without a PRD and after semantic permission denial", async () => {
  const directory = await fixture();

  const withoutPrd = await runProductIntentDiscovery(directory);
  assert.equal(withoutPrd.status, "needs_input");
  assert.deepEqual(
    withoutPrd.candidates.behaviors.map(({ behavior_id: behaviorId }) => behaviorId),
    ["customers_purchase_subscription", "customers_sign_in"],
  );
  assert.equal(withoutPrd.coverage.state, "partial");
  assert.equal(withoutPrd.coverage.negative_findings_allowed, false);

  const initial = await runProductIntentDiscovery(directory, {
    selected_materials: ["docs/product.md"],
  });
  const denied = await runProductIntentDiscovery(directory, {
    resume_token: initial.resume_token,
    permission_decision: "denied",
  });
  assert.equal(denied.status, "needs_input");
  assert.equal(denied.coverage.state, "denied");
  assert.deepEqual(denied.coverage.excluded_sources, ["docs/product.md"]);
  assert.deepEqual(
    denied.candidates.behaviors.map(({ behavior_id: behaviorId }) => behaviorId),
    ["customers_purchase_subscription", "customers_sign_in"],
  );

  const deniedPreview = await runProductIntentDiscovery(directory, {
    resume_token: denied.resume_token,
    answers: {
      intended_environment: "production",
      confirmed_behaviors: ["customers_purchase_subscription", "customers_sign_in"],
      hard_constraints: [],
      preferences: [],
    },
  });
  const deniedCompleted = await runProductIntentDiscovery(directory, {
    resume_token: deniedPreview.resume_token,
    confirmation: "confirm",
  });
  assert.equal(deniedCompleted.status, "completed");
  assert.equal(deniedCompleted.profile.coverage.state, "denied");
  assert.ok(deniedCompleted.profile.unknowns.includes("semantic_coverage_incomplete"));
});

test("no-PRD discovery completes when Local Safe Scan has no candidate facts", async () => {
  const directory = await fixture();
  await writeFile(path.join(directory, ".env.example"), "");
  const input = await runProductIntentDiscovery(directory);
  assert.equal(input.status, "needs_input");
  assert.deepEqual(input.candidates.behaviors, []);
  assert.deepEqual(input.request.fields.find(({ field_id: fieldId }) =>
    fieldId === "confirmed_behaviors").suggested_values, ["teams_collaborate_in_realtime"]);

  const preview = await runProductIntentDiscovery(directory, {
    resume_token: input.resume_token,
    answers: {
      intended_environment: "production",
      confirmed_behaviors: ["teams_collaborate_in_realtime"],
      hard_constraints: [],
      preferences: [],
    },
  });
  assert.equal(preview.status, "needs_confirmation");
  const completed = await runProductIntentDiscovery(directory, {
    resume_token: preview.resume_token,
    confirmation: "confirm",
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.profile.provenance[0].permission, "local_safe_scan");
});

test("intent answers reject secret-like free text without persisting it", async () => {
  const directory = await fixture();
  const input = await runProductIntentDiscovery(directory);
  for (const secret of [
    "api_token=sk-secret-value",
    "stripe_sk_live_abcd1234",
    "billing_passphrase_hunter2",
  ]) {
    const rejected = await runProductIntentDiscovery(directory, {
      resume_token: input.resume_token,
      answers: {
        intended_environment: "production",
        confirmed_behaviors: ["customers_sign_in"],
        hard_constraints: [secret],
        preferences: [],
      },
    });
    assert.equal(rejected.status, "needs_input");
    assert.equal(JSON.stringify(rejected).includes(secret), false);
    assert.equal(rejected.resume_token, input.resume_token);
  }
});

test("unsupported selected material preserves partial coverage and cannot prove absence", async () => {
  const directory = await fixture();
  await writeFile(path.join(directory, "docs", "product.pdf"), "not a supported text source");
  const initial = await runProductIntentDiscovery(directory, {
    selected_materials: ["docs/product.md", "docs/product.pdf"],
  });

  const result = await runProductIntentDiscovery(directory, {
    resume_token: initial.resume_token,
    permission_decision: "approved",
  });

  assert.equal(result.status, "needs_input");
  assert.equal(result.coverage.state, "partial");
  assert.equal(result.coverage.negative_findings_allowed, false);
  assert.deepEqual(result.coverage.excluded_sources, ["docs/product.pdf"]);
  assert.ok(result.candidates.behaviors.length > 0);
});

test("conflicting materials and user-declared no-PRD behavior remain separately queryable", async () => {
  const directory = await fixture();
  await writeFile(
    path.join(directory, "docs", "legacy-plan.md"),
    "The product must not sign in customers; access is anonymous.\n",
  );
  const initial = await runProductIntentDiscovery(directory, {
    selected_materials: ["docs/product.md", "docs/legacy-plan.md"],
  });
  const input = await runProductIntentDiscovery(directory, {
    resume_token: initial.resume_token,
    permission_decision: "approved",
  });
  assert.deepEqual(input.conflicts, [{
    conflict_id: "conflict_customers_sign_in",
    source_ids: ["source_local_safe_scan", "source_selected_1", "source_selected_2"],
    summary: "Sources conflict about customers_sign_in.",
    status: "unresolved",
  }]);
  assert.deepEqual(
    input.request.fields.find(({ field_id: fieldId }) =>
      fieldId === "acknowledged_conflicts").suggested_values,
    ["conflict_customers_sign_in"],
  );

  const conflictPreview = await runProductIntentDiscovery(directory, {
    resume_token: input.resume_token,
    answers: {
      intended_environment: "production",
      confirmed_behaviors: ["customers_sign_in"],
      hard_constraints: [],
      preferences: [],
      acknowledged_conflicts: ["conflict_customers_sign_in"],
    },
  });
  assert.deepEqual(conflictPreview.preview.conflicts, input.conflicts);
  assert.ok(conflictPreview.preview.unknowns.includes("conflict_customers_sign_in"));

  const noPrd = await runProductIntentDiscovery(directory);
  const preview = await runProductIntentDiscovery(directory, {
    resume_token: noPrd.resume_token,
    answers: {
      intended_environment: "staging",
      confirmed_behaviors: ["customers_sign_in", "teams_collaborate_in_realtime"],
      hard_constraints: [],
      preferences: [],
    },
  });
  assert.equal(preview.status, "needs_confirmation");
  assert.deepEqual(preview.preview.desired_intent.behaviors, [
    "customers_sign_in",
    "teams_collaborate_in_realtime",
  ]);
  assert.equal(preview.preview.desired_intent.confirmation, "unconfirmed");
});

test("invalid or cross-repository resume state fails closed", async () => {
  const [first, second] = await Promise.all([fixture(), fixture()]);
  const initial = await runProductIntentDiscovery(first, {
    selected_materials: ["docs/product.md"],
  });

  const tampered = await runProductIntentDiscovery(first, {
    resume_token: `${initial.resume_token}x`,
    permission_decision: "approved",
  });
  assert.equal(tampered.status, "execution_error");
  assert.equal(tampered.error, "invalid_resume_token");

  const wrongRoot = await runProductIntentDiscovery(second, {
    resume_token: initial.resume_token,
    permission_decision: "approved",
  });
  assert.equal(wrongRoot.status, "execution_error");
  assert.equal(wrongRoot.error, "invalid_resume_token");
});
