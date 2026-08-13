import {
  EXECUTION_RECEIPT_SCHEMA,
  HANDOFF_PACKAGE_SCHEMA,
  TASK_GRAPH_SCHEMA,
} from "@launchrally/contracts";

import { runHandoff } from "./handoff.js";
import { sha256 } from "./local-history.js";
import { referenceExecutorDescriptors } from "./reference-executors.js";
import {
  referenceIntegrationPacks,
  runReferenceOutcomeJourney,
} from "./reference-integration-packs.js";

function taskGraph(pack, implementation) {
  const fixture = implementation.normalization_fixture;
  const target = [
    "reference",
    pack.pack_id,
    pack.pack_digest.slice(7),
    implementation.implementation_id,
    implementation.interface_version.replaceAll(/[^A-Za-z0-9]+/gu, "_"),
    fixture.fixture_id,
  ].join("_").toLowerCase();
  return {
    schema_version: TASK_GRAPH_SCHEMA,
    graph_id: `task_graph_reference_${pack.family}`,
    revision: 1,
    environment: "development",
    source_report: {
      id: `report_reference_${pack.family}`,
      schema_version: "launchrally.dev/report/v2",
      digest: `sha256:${"1".repeat(64)}`,
    },
    architecture_record: {
      id: `architecture_reference_${pack.family}`,
      schema_version: "launchrally.dev/architecture-record/v1",
      digest: `sha256:${"2".repeat(64)}`,
    },
    currentness: { state: "current", reasons: [] },
    tasks: [{
      task_id: `task_reference_${pack.family}`,
      task_type: "implement_architecture_decision",
      source: "implementation_work",
      source_id: `work_${pack.pack_id}_${pack.pack_digest.slice(7)}`,
      environment: "development",
      prerequisites: [],
      effect_class: "local_source",
      expected_target: target,
      allowed_effects: ["source_write"],
      prohibited_effects: [
        "credential_persistence",
        "deployment_write",
        "production_data_write",
        "provider_configuration_write",
      ],
      recovery_notes: ["Preserve the typed gap and inspect the synthetic fixture before retrying."],
      minimum_executor_capability: "local_source_write_v1",
      structured_result_schema: EXECUTION_RECEIPT_SCHEMA,
      evidence_targets: [target],
      follow_up_verify: {
        operation: "verify",
        scope: pack.family,
        fresh_evidence_required: true,
      },
      cancellation_behavior: "stop_before_next_effect",
      status: "not_started",
    }],
    ready_frontier: [`task_reference_${pack.family}`],
  };
}

function memoryState() {
  let value;
  return {
    store_state: async (next) => {
      value = structuredClone(next);
      return "reference_handoff_resume";
    },
    load_state: async () => structuredClone(value),
    save_state: async (next) => {
      value = structuredClone(next);
    },
  };
}

function receipt(handoff, outcome, reportedAt) {
  const state = outcome === "partial"
    ? "partial"
    : ["failed", "cleanup_failed"].includes(outcome)
      ? "reported_failed"
      : "reported_succeeded";
  const claimCode = state === "partial"
    ? "execution_partial"
    : state === "reported_failed" ? "execution_failed" : "execution_completed";
  return {
    schema_version: EXECUTION_RECEIPT_SCHEMA,
    receipt_id: `receipt_reference_${outcome}`,
    handoff: {
      id: handoff.handoff_id,
      schema_version: HANDOFF_PACKAGE_SCHEMA,
      digest: sha256(handoff),
    },
    executor: structuredClone(handoff.executor),
    reported_at: reportedAt,
    task_results: handoff.task_ids.map((taskId) => ({
      task_id: taskId,
      state,
      claim_codes: [claimCode],
    })),
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

export async function runReferenceHostJourney({
  host,
  pack_id: packId,
  implementation_id: implementationId,
  outcome,
  assessment_time: assessmentTime,
}) {
  const pack = referenceIntegrationPacks.find(({ pack_id: id }) => id === packId);
  const implementation = pack?.implementations.find(
    ({ implementation_id: id }) => id === implementationId,
  );
  if (!pack || !implementation || !["codex", "claude"].includes(host)) {
    return { status: "verification_gap", reason_code: "unsupported_reference_host_journey" };
  }
  const assessedAt = Date.parse(assessmentTime);
  if (
    !Number.isFinite(assessedAt)
    || assessedAt < Date.parse(pack.review.reviewed_at)
    || assessedAt > Date.parse(pack.review.expires_at)
  ) {
    return {
      host,
      pack_id: packId,
      implementation_id: implementationId,
      outcome,
      status: "verification_gap",
      reason_code: "stale_reference_pack",
      machine_evidence: false,
      assurance_change: false,
    };
  }
  const descriptor = referenceExecutorDescriptors.find(({ descriptor_id: id }) =>
    id === `executor_${host}_reference`);
  const executorReference = implementation.executor_descriptors.find(({ id }) =>
    id === descriptor.descriptor_id);
  if (
    !executorReference
    || executorReference.schema_version !== descriptor.schema_version
    || executorReference.digest !== descriptor.trust.digest
  ) {
    return {
      host,
      pack_id: packId,
      implementation_id: implementationId,
      outcome,
      status: "verification_gap",
      reason_code: "unsupported_reference_executor",
      machine_evidence: false,
      assurance_change: false,
    };
  }
  if (
    assessedAt < Date.parse(descriptor.trust.reviewed_at)
    || assessedAt > Date.parse(descriptor.trust.expires_at)
  ) {
    return {
      host,
      pack_id: packId,
      implementation_id: implementationId,
      outcome,
      status: "verification_gap",
      reason_code: "stale_reference_executor",
      machine_evidence: false,
      assurance_change: false,
    };
  }
  const unavailable = ["unknown", "stale"].includes(outcome);
  const descriptors = outcome === "unknown" ? [] : [descriptor];
  const detectedVersion = outcome === "stale" ? "0.0.0" : descriptor.tools[0].exact_version;
  const dependencies = {
    ...memoryState(),
    platform: "linux-x64",
    now: () => assessmentTime,
  };
  const source = {
    task_graph: taskGraph(pack, implementation),
    executor_descriptors: descriptors,
    reviewed_executors: descriptors.map((candidate) => ({
      descriptor_id: candidate.descriptor_id,
      descriptor_version: candidate.descriptor_version,
      digest: candidate.trust.digest,
    })),
    tool_observations: descriptors.map((candidate) => ({
      tool_id: candidate.tools[0].tool_id,
      executable: candidate.tools[0].executable,
      detected_version: detectedVersion,
      state: outcome === "stale" ? "unsupported_version" : "available",
    })),
  };
  const discovered = await runHandoff(source, {}, dependencies);
  if (unavailable) {
    return {
      host,
      pack_id: packId,
      implementation_id: implementationId,
      outcome,
      status: "verification_gap",
      handoff_status: discovered.status,
      executor_state: outcome === "stale" ? "expired" : "missing",
      machine_evidence: false,
      assurance_change: false,
    };
  }
  const selected = await runHandoff({}, {
    resume_token: discovered.resume_token,
    selection: discovered.request.choices[0],
  }, dependencies);
  if (outcome === "denied") {
    const denied = await runHandoff({}, {
      resume_token: selected.resume_token,
      confirmation: "deny",
    }, dependencies);
    return {
      host,
      pack_id: packId,
      implementation_id: implementationId,
      outcome,
      status: "verification_gap",
      handoff_status: denied.status,
      executor_state: "denied",
      machine_evidence: false,
      assurance_change: false,
    };
  }
  const confirmed = await runHandoff({}, {
    resume_token: selected.resume_token,
    confirmation: "confirm",
  }, dependencies);
  const reportedAt = new Date(assessedAt + 60_000).toISOString();
  const reviewed = await runHandoff({}, {
    resume_token: confirmed.resume_token,
    receipt: receipt(confirmed.handoff_package, outcome, reportedAt),
  }, dependencies);
  const verifyRequest = await runHandoff({}, {
    resume_token: reviewed.resume_token,
    choice: "verify",
  }, dependencies);
  const verified = runReferenceOutcomeJourney(pack, implementationId, outcome, assessmentTime);
  return {
    host,
    pack_id: packId,
    implementation_id: implementationId,
    outcome,
    status: verified.status,
    handoff_status: reviewed.status,
    verify_handoff_status: verifyRequest.status,
    fresh_verification_request: structuredClone(verifyRequest.next),
    executor_state: verified.executor_state,
    receipt_claim_only: reviewed.execution_receipt?.classification.claim_only ?? false,
    machine_evidence: verified.machine_evidence,
    assurance_change: verified.assurance_change,
  };
}
