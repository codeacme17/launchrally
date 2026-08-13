import { createRequire } from "node:module";

import { assertValidReferenceIntegrationPack } from "@launchrally/contracts";

import { ACTIVE_VERIFICATION_RECIPES } from "./active-verification.js";
import { referenceExecutorDescriptors } from "./reference-executors.js";

const require = createRequire(import.meta.url);

export const REFERENCE_PRODUCT_SHAPES = Object.freeze([
  "content_marketing_web",
  "subscription_saas",
  "media_productivity_async",
  "custom_self_hosted_web",
  "desktop_shared_backend",
]);

export const REFERENCE_INTEGRATION_FAMILIES = Object.freeze([
  "identity_to_application_data",
  "payment_to_entitlement",
  "source_to_ci_cd_to_deployment",
  "storage_to_metadata_access",
  "email_to_domain_delivery",
  "release_to_observability",
  "backup_to_restore",
  "queue_background_work",
]);

const PACK_FILES = Object.freeze([
  "identity-to-application-data.json",
  "payment-to-entitlement.json",
  "source-to-ci-cd-to-deployment.json",
  "storage-to-metadata-access.json",
  "email-to-domain-delivery.json",
  "release-to-observability.json",
  "backup-to-restore.json",
  "queue-background-work.json",
]);

const READ_ADAPTERS_BY_FAMILY = Object.freeze({
  identity_to_application_data: new Set(["clerk-read/v1"]),
  payment_to_entitlement: new Set(),
  source_to_ci_cd_to_deployment: new Set(["cloudflare-read/v1", "vercel-read/v1"]),
  storage_to_metadata_access: new Set(),
  email_to_domain_delivery: new Set(["resend-read/v1"]),
  release_to_observability: new Set(["sentry-read/v1"]),
  backup_to_restore: new Set(),
  queue_background_work: new Set(),
});

const REFERENCE_EXECUTOR_DIGESTS = new Map(referenceExecutorDescriptors.map((descriptor) => [
  descriptor.descriptor_id,
  descriptor.trust.digest,
]));

function assertSupportedReferenceIntegrationPack(pack, assessmentTime = null) {
  assertValidReferenceIntegrationPack(pack);
  const allowedAdapters = READ_ADAPTERS_BY_FAMILY[pack.family];
  const assessedAt = assessmentTime === null ? null : Date.parse(assessmentTime);
  const current = assessmentTime === null || (Number.isFinite(assessedAt)
    && Date.parse(pack.review.reviewed_at) <= assessedAt
    && assessedAt <= Date.parse(pack.review.expires_at));
  const valid = current && allowedAdapters
    && pack.test_recipe_ids.every((recipeId) => ACTIVE_VERIFICATION_RECIPES[recipeId])
    && pack.implementations.every((implementation) => {
      if (implementation.kind === "managed" && implementation.executor_descriptors.length === 0) {
        return false;
      }
      const referencesValid = implementation.executor_descriptors.every((reference) =>
        REFERENCE_EXECUTOR_DIGESTS.get(reference.id) === reference.digest);
      if (!referencesValid) return false;
      if (implementation.read_adapter === null) {
        return implementation.support_depth !== "read_only"
          && implementation.support_depth !== "read_and_active";
      }
      return allowedAdapters.has(implementation.read_adapter)
        && ["read_only", "read_and_active"].includes(implementation.support_depth);
    });
  if (!valid) {
    const error = new Error("The Reference Integration Pack overstates supported depth.");
    error.code = "unsupported_reference_integration_pack";
    throw error;
  }
  return true;
}

function implementationSupport(pack, implementation, productShape) {
  if (implementation.kind === "unknown") return "transparent_gap";
  if (implementation.kind !== "managed") return "generic";
  const deep = pack.product_shapes.includes(productShape)
    && implementation.read_adapter !== null;
  return deep ? "deep" : "generic";
}

export function normalizeReferenceImplementation(pack, implementationId, assessmentTime = null) {
  assertSupportedReferenceIntegrationPack(pack, assessmentTime);
  const implementation = pack.implementations.find(
    ({ implementation_id: id }) => id === implementationId,
  );
  const fixture = implementation?.normalization_fixture;
  if (!fixture) {
    return {
      implementation_id: implementationId,
      status: "verification_gap",
      reason_code: "generic_normalizer_unavailable",
      observation: null,
    };
  }
  const signals = new Set(fixture.synthetic_input.signals);
  if (
    fixture.synthetic_input.shape !== implementation.normalization_shape
    || !fixture.required_signals.every((signal) => signals.has(signal))
  ) {
    return {
      implementation_id: implementationId,
      status: "verification_gap",
      reason_code: "synthetic_fixture_mismatch",
      observation: null,
    };
  }
  return {
    implementation_id: implementationId,
    status: "normalized",
    reason_code: null,
    observation: structuredClone(fixture.expected_observation),
  };
}

export function runReferenceOutcomeJourney(pack, implementationId, outcome, assessmentTime = null) {
  assertSupportedReferenceIntegrationPack(pack, assessmentTime);
  const fixture = pack.fixture_outcomes.find((candidate) => candidate.outcome === outcome);
  const normalized = normalizeReferenceImplementation(pack, implementationId, assessmentTime);
  if (!fixture) {
    return {
      status: "verification_gap",
      outcome,
      executor_state: outcome === "denied" ? "denied" : "unavailable",
      claim_state: "unreported",
      fresh_verification: "not_run",
      machine_evidence: false,
      assurance_change: false,
    };
  }
  if (normalized.status !== "normalized" && !["denied", "unknown", "stale"].includes(outcome)) {
    return {
      status: "verification_gap",
      outcome,
      executor_state: "unavailable",
      claim_state: "unreported",
      fresh_verification: "not_run",
      machine_evidence: false,
      assurance_change: false,
    };
  }
  const typed = {
    complete: ["available", "reported_succeeded", "required"],
    partial: ["available", "partial", "required"],
    denied: ["denied", "unreported", "not_run"],
    unknown: ["missing", "unreported", "not_run"],
    stale: ["expired", "unreported", "not_run"],
    successful: ["available", "reported_succeeded", "synthetic_passed"],
    failed: ["available", "reported_failed", "synthetic_failed"],
    cleanup_failed: ["available", "reported_failed", "cleanup_failed"],
  }[outcome];
  const freshVerification = typed[2];
  return {
    status: ["successful", "failed"].includes(outcome)
      ? "synthetic_observation_completed"
      : outcome === "complete" || outcome === "partial"
        ? "verification_pending"
        : "verification_gap",
    outcome,
    executor_state: typed[0],
    claim_state: typed[1],
    fresh_verification: freshVerification,
    machine_evidence: false,
    assurance_change: false,
  };
}

export function applyReferenceJourneyState(result, action) {
  if (action === "cancel" && result?.status === "verification_pending") {
    return {
      ...structuredClone(result),
      status: "cancelled",
      claim_state: "cancelled",
      fresh_verification: "not_run",
      machine_evidence: false,
      assurance_change: false,
    };
  }
  return structuredClone(result);
}

export const referenceIntegrationPacks = Object.freeze(PACK_FILES.map((file) => {
  const pack = require(`../reference-integration-packs/v1/${file}`);
  assertSupportedReferenceIntegrationPack(pack);
  return Object.freeze(pack);
}));

export function createReferenceCoverageMatrix(packs = referenceIntegrationPacks) {
  packs.forEach((pack) => assertSupportedReferenceIntegrationPack(pack));
  const byFamily = new Map(packs.map((pack) => [pack.family, pack]));
  return {
    product_shapes: [...REFERENCE_PRODUCT_SHAPES],
    integration_families: [...REFERENCE_INTEGRATION_FAMILIES],
    cells: REFERENCE_PRODUCT_SHAPES.flatMap((productShape) =>
      REFERENCE_INTEGRATION_FAMILIES.map((family) => {
        const pack = byFamily.get(family);
        const implementations = pack?.implementations.map((implementation) => ({
          implementation_id: implementation.implementation_id,
          kind: implementation.kind,
          support_state: implementationSupport(pack, implementation, productShape),
        })) ?? [];
        const supportStates = new Set(implementations.map(({ support_state: state }) => state));
        return {
          product_shape: productShape,
          integration_family: family,
          pack_id: pack?.pack_id ?? null,
          support_state: !pack
            ? "transparent_gap"
            : supportStates.has("deep")
              ? "mixed"
              : supportStates.has("generic")
                ? "generic"
                : "transparent_gap",
          implementations,
        };
      })),
  };
}
