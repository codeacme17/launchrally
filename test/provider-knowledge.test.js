import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_CATALOG_SCHEMA,
  PROVIDER_KNOWLEDGE_SCHEMA,
  assertValidProviderKnowledge,
  computeProviderKnowledgeDigest,
  computeProviderKnowledgeId,
} from "../packages/contracts/src/index.js";
import {
  CORE_PROVIDER_KNOWLEDGE,
  assessProviderKnowledge,
  createProviderKnowledge,
} from "../packages/core/src/index.js";

test("Core Provider Knowledge is independently versioned, source-backed, and digest-bound", () => {
  assert.equal(PROVIDER_KNOWLEDGE_SCHEMA, "launchrally.dev/provider-knowledge/v1");
  assert.notEqual(PROVIDER_KNOWLEDGE_SCHEMA, CAPABILITY_CATALOG_SCHEMA);
  assert.equal(CORE_PROVIDER_KNOWLEDGE.schema_version, PROVIDER_KNOWLEDGE_SCHEMA);
  assert.equal(CORE_PROVIDER_KNOWLEDGE.knowledge_version, "1.0.0");
  assert.equal(CORE_PROVIDER_KNOWLEDGE.trust_tier, "core_catalog");
  assert.match(CORE_PROVIDER_KNOWLEDGE.knowledge_id, /^knowledge_[a-f0-9]{24}$/u);
  assert.equal(
    CORE_PROVIDER_KNOWLEDGE.digest,
    computeProviderKnowledgeDigest(CORE_PROVIDER_KNOWLEDGE),
  );
  assert.equal(assertValidProviderKnowledge(CORE_PROVIDER_KNOWLEDGE), true);
  assert.ok(CORE_PROVIDER_KNOWLEDGE.entries.length > 0);
  assert.ok(CORE_PROVIDER_KNOWLEDGE.entries.every(({ card }) =>
    card.official_sources.length >= 3
    && card.capability_scope.includes.length > 0
    && card.capability_scope.excludes.length > 0
    && card.unknowns.length > 0));
});

function resign(knowledge) {
  const next = structuredClone(knowledge);
  delete next.knowledge_id;
  delete next.digest;
  next.digest = computeProviderKnowledgeDigest(next);
  next.knowledge_id = computeProviderKnowledgeId(next);
  return next;
}

test("Provider Knowledge rejects tampering, unsupported authority, and unproven claims", () => {
  const tampered = structuredClone(CORE_PROVIDER_KNOWLEDGE);
  tampered.entries[0].card.capability_scope.summary = "Tampered claim";
  assert.throws(
    () => assertValidProviderKnowledge(tampered),
    (error) => error.code === "invalid_provider_knowledge",
  );

  const evidenceEscalation = structuredClone(CORE_PROVIDER_KNOWLEDGE);
  evidenceEscalation.authority.machine_evidence = true;
  assert.throws(
    () => assertValidProviderKnowledge(resign(evidenceEscalation)),
    (error) => error.code === "invalid_provider_knowledge",
  );

  const unreviewedPrice = structuredClone(CORE_PROVIDER_KNOWLEDGE);
  const [scenario] = unreviewedPrice.entries[0].pricing_scenarios;
  scenario.official_pricing_reviewed_at = null;
  scenario.currency_estimate = { currency: "USD", amount: 20, basis: "monthly" };
  assert.throws(
    () => assertValidProviderKnowledge(resign(unreviewedPrice)),
    (error) => error.code === "invalid_provider_knowledge",
  );

  const unprovenRegion = structuredClone(CORE_PROVIDER_KNOWLEDGE);
  unprovenRegion.entries[0].region_claims[0].state = "supported";
  assert.throws(
    () => assertValidProviderKnowledge(resign(unprovenRegion)),
    (error) => error.code === "invalid_provider_knowledge",
  );

  const futurePricing = structuredClone(CORE_PROVIDER_KNOWLEDGE);
  futurePricing.entries[0].pricing_scenarios[0].official_pricing_reviewed_at = "2026-08-08";
  assert.throws(
    () => assertValidProviderKnowledge(resign(futurePricing)),
    (error) => error.code === "invalid_provider_knowledge",
  );

  const disguisedLocalExtension = structuredClone(CORE_PROVIDER_KNOWLEDGE);
  disguisedLocalExtension.trust_tier = "local_experimental";
  assert.throws(
    () => assertValidProviderKnowledge(resign(disguisedLocalExtension)),
    (error) => error.code === "invalid_provider_knowledge",
  );
});

function extensionFromCore({
  trustTier = "reviewed_extension",
  sourceClass = "official_provider_documentation",
  expiresAt = "2026-11-05",
} = {}) {
  const entry = CORE_PROVIDER_KNOWLEDGE.entries.find(({ card }) =>
    card.provider.id === "vercel");
  return createProviderKnowledge({
    knowledge_version: "1.0.0",
    trust_tier: trustTier,
    extension: {
      extension_id: trustTier === "local_experimental"
        ? "local_provider_notes"
        : "reviewed_provider_extension",
      extension_version: "1.0.0",
      origin: trustTier === "local_experimental" ? "local" : "reviewed_extension",
    },
    review: {
      status: trustTier === "local_experimental" ? "experimental" : "reviewed",
      reviewed_at: "2026-08-07",
      expires_at: expiresAt,
    },
    entries: [structuredClone(entry)],
    provenance: CORE_PROVIDER_KNOWLEDGE.provenance
      .filter(({ card_ids: ids }) => ids.includes(entry.card.card_id))
      .map((source) => ({ ...structuredClone(source), source_class: sourceClass })),
  });
}

test("only fresh reviewed source-backed supply-chain artifacts participate in normative recommendations", () => {
  const query = {
    capability_id: "managed_web_delivery",
    provider_id: "vercel",
    environment: "production",
    region: "europe",
  };
  const core = assessProviderKnowledge([CORE_PROVIDER_KNOWLEDGE], query, {
    as_of: "2026-08-13",
  });
  assert.equal(core.recommendations.length, 1);
  assert.equal(core.advisory_entries.length, 0);
  assert.ok(core.provider_verification_gaps.some(({ code }) =>
    code === "region_claim_unverified"));
  assert.deepEqual(core.authority, {
    advisory: true,
    machine_evidence: false,
    release_gating: false,
    write_authority: false,
  });

  const reviewed = extensionFromCore();
  const untrusted = assessProviderKnowledge([reviewed], query, { as_of: "2026-08-13" });
  assert.equal(untrusted.recommendations.length, 0);
  assert.equal(untrusted.advisory_entries.length, 1);
  assert.ok(untrusted.provider_verification_gaps.some(({ code }) =>
    code === "extension_not_reviewed"));

  const trust = [{
    extension_id: reviewed.extension.extension_id,
    extension_version: reviewed.extension.extension_version,
    digest: reviewed.digest,
  }];
  const trusted = assessProviderKnowledge([reviewed], query, {
    as_of: "2026-08-13",
    reviewed_extensions: trust,
  });
  assert.equal(trusted.recommendations.length, 1);

  const stale = extensionFromCore({ expiresAt: "2026-08-12" });
  const staleTrust = [{
    extension_id: stale.extension.extension_id,
    extension_version: stale.extension.extension_version,
    digest: stale.digest,
  }];
  const expired = assessProviderKnowledge([stale], query, {
    as_of: "2026-08-13",
    reviewed_extensions: staleTrust,
  });
  assert.equal(expired.recommendations.length, 0);
  assert.ok(expired.provider_verification_gaps.some(({ code }) =>
    code === "provider_knowledge_expired"));

  const marketing = extensionFromCore({ sourceClass: "provider_marketing" });
  const marketingResult = assessProviderKnowledge([marketing], query, {
    as_of: "2026-08-13",
    reviewed_extensions: [{
      extension_id: marketing.extension.extension_id,
      extension_version: marketing.extension.extension_version,
      digest: marketing.digest,
    }],
  });
  assert.equal(marketingResult.recommendations.length, 0);
  assert.ok(marketingResult.provider_verification_gaps.some(({ code }) =>
    code === "non_normative_sources"));

  const mixedClaimSources = extensionFromCore();
  const [entry] = mixedClaimSources.entries;
  const marketingUrl = "https://example.com/provider-region-marketing";
  entry.region_claims[0] = {
    id: "global",
    state: "supported",
    source_urls: [marketingUrl],
  };
  mixedClaimSources.provenance.push({
    source_id: "source_provider_region_marketing",
    source_url: marketingUrl,
    source_class: "provider_marketing",
    reviewed_at: "2026-08-07",
    card_ids: [entry.card.card_id],
  });
  const signedMixedClaims = resign(mixedClaimSources);
  const mixedResult = assessProviderKnowledge([signedMixedClaims], query, {
    as_of: "2026-08-13",
    reviewed_extensions: [{
      extension_id: signedMixedClaims.extension.extension_id,
      extension_version: signedMixedClaims.extension.extension_version,
      digest: signedMixedClaims.digest,
    }],
  });
  assert.equal(mixedResult.recommendations.length, 0);
  assert.ok(mixedResult.provider_verification_gaps.some(({ code }) =>
    code === "non_normative_claim_sources"));

  const local = extensionFromCore({
    trustTier: "local_experimental",
    sourceClass: "search_output",
  });
  const localResult = assessProviderKnowledge([local], query, {
    as_of: "2026-08-13",
    reviewed_extensions: [{
      extension_id: local.extension.extension_id,
      extension_version: local.extension.extension_version,
      digest: local.digest,
    }],
  });
  assert.equal(localResult.recommendations.length, 0);
  assert.equal(localResult.advisory_entries.length, 1);
  assert.equal(localResult.authority.release_gating, false);
  assert.equal(localResult.authority.write_authority, false);
});

test("unknown, custom, and self-hosted Providers retain generic manual guidance with honest depth", () => {
  for (const providerKind of ["unknown", "custom", "self_hosted"]) {
    const result = assessProviderKnowledge([CORE_PROVIDER_KNOWLEDGE], {
      capability_id: "application_data",
      provider_id: `private_${providerKind}_provider`,
      provider_kind: providerKind,
      environment: "production",
      region: "specific_or_residency",
    }, { as_of: "2026-08-13" });
    assert.equal(result.recommendations.length, 0);
    assert.deepEqual(result.generic_guidance, {
      provider_id: `private_${providerKind}_provider`,
      provider_kind: providerKind,
      disposition: "retain",
      next_action: "investigate",
      planning_mode: "manual",
      assessment_depth: "generic",
      provider_specific_claims: false,
    });
    assert.ok(result.provider_verification_gaps.some(({ code }) =>
      code === "provider_knowledge_missing"));
    assert.equal(result.authority.release_gating, false);
  }
});
