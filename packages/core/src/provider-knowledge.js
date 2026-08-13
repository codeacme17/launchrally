import {
  PROVIDER_KNOWLEDGE_SCHEMA,
  assertValidProviderKnowledge,
  computeProviderKnowledgeDigest,
  computeProviderKnowledgeId,
} from "@launchrally/contracts";

import { PROVIDER_DECISION_CARDS } from "./provider-decision-cards.js";

const AUTHORITY = Object.freeze({
  advisory: true,
  machine_evidence: false,
  release_gating: false,
  write_authority: false,
});
const NORMATIVE_SOURCE_CLASSES = new Set([
  "official_provider_documentation",
  "official_project_contract",
]);

function knowledgeReference(knowledge) {
  return {
    id: knowledge.knowledge_id,
    schema_version: knowledge.schema_version,
    digest: knowledge.digest,
  };
}

export function createProviderKnowledge(input) {
  const contentValue = {
    schema_version: PROVIDER_KNOWLEDGE_SCHEMA,
    knowledge_version: input?.knowledge_version,
    trust_tier: input?.trust_tier,
    extension: structuredClone(input?.extension),
    review: structuredClone(input?.review),
    entries: structuredClone(input?.entries),
    provenance: structuredClone(input?.provenance),
    authority: { ...AUTHORITY },
  };
  const value = {
    ...contentValue,
    knowledge_id: computeProviderKnowledgeId(contentValue),
    digest: computeProviderKnowledgeDigest(contentValue),
  };
  assertValidProviderKnowledge(value);
  return value;
}

function entryFor(card) {
  return {
    entry_id: `entry_${card.provider.id}_${card.capability_scope.id}`,
    card: structuredClone(card),
    environment_claims: [{
      id: "production",
      state: "unknown",
      source_urls: [],
    }],
    region_claims: card.compatibility.region_signals.map((region) => ({
      id: region,
      state: "unknown",
      source_urls: [],
    })),
    pricing_scenarios: [{
      scenario_id: "confirmed_workload",
      drivers: [...card.cost_model.basis],
      assumptions: [...card.cost_model.caveats],
      official_pricing_reviewed_at: card.review_date,
      pricing_source_urls: card.official_sources
        .filter(({ kind }) => kind === "pricing")
        .map(({ url }) => url),
    }],
  };
}

function provenanceFor(cards) {
  return cards.flatMap((card) => card.official_sources.map((source, index) => ({
    source_id: `source_${card.provider.id}_${source.kind}_${index + 1}`,
    source_url: source.url,
    source_class: "official_provider_documentation",
    reviewed_at: card.review_date,
    card_ids: [card.card_id],
  })));
}

const content = {
  knowledge_version: "1.0.0",
  trust_tier: "core_catalog",
  extension: {
    extension_id: "launchrally_core_provider_knowledge",
    extension_version: "1.0.0",
    origin: "launchrally_core",
  },
  review: {
    status: "reviewed",
    reviewed_at: "2026-08-07",
    expires_at: "2026-11-05",
  },
  entries: PROVIDER_DECISION_CARDS.map(entryFor),
  provenance: provenanceFor(PROVIDER_DECISION_CARDS),
};
export const CORE_PROVIDER_KNOWLEDGE = Object.freeze(createProviderKnowledge(content));

assertValidProviderKnowledge(CORE_PROVIDER_KNOWLEDGE);

function entrySourceAssessment(knowledge, entry) {
  const sources = knowledge.provenance.filter(({ card_ids: cardIds }) =>
    cardIds.includes(entry.card.card_id));
  const sourceByUrl = new Map(sources.map((source) => [source.source_url, source]));
  const normativeSource = (url) => {
    const source = sourceByUrl.get(url);
    return source
      && NORMATIVE_SOURCE_CLASSES.has(source.source_class)
      && source.reviewed_at !== null;
  };
  return {
    card_sources_normative: entry.card.official_sources.every(({ url }) =>
      normativeSource(url)),
    claim_sources_normative: [...entry.environment_claims, ...entry.region_claims]
      .filter(({ state }) => state !== "unknown")
      .every((claim) => claim.source_urls.every(normativeSource)),
  };
}

function exactExtensionReview(knowledge, reviewedExtensions) {
  return reviewedExtensions.some((review) =>
    review?.extension_id === knowledge.extension.extension_id
    && review.extension_version === knowledge.extension.extension_version
    && review.digest === knowledge.digest);
}

function trustState(knowledge, reviewedExtensions) {
  if (knowledge.trust_tier === "core_catalog") {
    return knowledge.extension.extension_id === CORE_PROVIDER_KNOWLEDGE.extension.extension_id
      && knowledge.extension.extension_version
        === CORE_PROVIDER_KNOWLEDGE.extension.extension_version
      && knowledge.digest === CORE_PROVIDER_KNOWLEDGE.digest
      ? { trusted: true, code: null }
      : { trusted: false, code: "core_catalog_digest_mismatch" };
  }
  if (knowledge.trust_tier === "reviewed_extension") {
    return exactExtensionReview(knowledge, reviewedExtensions)
      ? { trusted: true, code: null }
      : { trusted: false, code: "extension_not_reviewed" };
  }
  return { trusted: false, code: "local_experimental_advisory" };
}

function matchingEntries(knowledge, query) {
  return knowledge.entries.filter(({ card }) =>
    card.capability_scope.id === query.capability_id
    && (!query.provider_id || card.provider.id === query.provider_id));
}

function claimState(claims, id) {
  return id ? claims.find((claim) => claim.id === id)?.state ?? "unknown" : null;
}

export function assessProviderKnowledge(knowledgeSets, query = {}, options = {}) {
  const records = Array.isArray(knowledgeSets) ? knowledgeSets : [knowledgeSets];
  const asOf = options.as_of;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(asOf ?? "")) {
    const error = new Error("A Provider Knowledge assessment requires an as_of date.");
    error.code = "invalid_provider_knowledge_assessment";
    throw error;
  }
  const reviewedExtensions = options.reviewed_extensions ?? [];
  const recommendations = [];
  const advisoryEntries = [];
  const gaps = [];
  let matchedEntryCount = 0;
  const addGap = (code, knowledge, entry = null) => {
    if (!gaps.some((gap) =>
      gap.code === code
      && gap.knowledge_id === knowledge.knowledge_id
      && gap.entry_id === (entry?.entry_id ?? null))) {
      gaps.push({
        code,
        knowledge_id: knowledge.knowledge_id,
        entry_id: entry?.entry_id ?? null,
      });
    }
  };

  for (const knowledge of records) {
    assertValidProviderKnowledge(knowledge);
    const trust = trustState(knowledge, reviewedExtensions);
    const expired = asOf > knowledge.review.expires_at;
    const notEffective = asOf < knowledge.review.reviewed_at;
    if (trust.code) addGap(trust.code, knowledge);
    if (expired) addGap("provider_knowledge_expired", knowledge);
    if (notEffective) addGap("provider_knowledge_not_yet_reviewed", knowledge);

    for (const entry of matchingEntries(knowledge, query)) {
      matchedEntryCount += 1;
      const sourceAssessment = entrySourceAssessment(knowledge, entry);
      const sourceBacked = sourceAssessment.card_sources_normative
        && sourceAssessment.claim_sources_normative;
      if (!sourceBacked) addGap("non_normative_sources", knowledge, entry);
      if (!sourceAssessment.claim_sources_normative) {
        addGap("non_normative_claim_sources", knowledge, entry);
      }
      const environmentState = claimState(entry.environment_claims, query.environment);
      const regionState = claimState(entry.region_claims, query.region);
      if (environmentState === "unknown") {
        addGap("environment_claim_unverified", knowledge, entry);
      }
      if (regionState === "unknown") addGap("region_claim_unverified", knowledge, entry);
      const excluded = environmentState === "excluded" || regionState === "excluded";
      if (excluded) addGap("provider_scope_excluded", knowledge, entry);
      const value = {
        knowledge_ref: knowledgeReference(knowledge),
        entry_id: entry.entry_id,
        card: structuredClone(entry.card),
        environment_state: environmentState,
        region_state: regionState,
      };
      if (trust.trusted && !expired && !notEffective && sourceBacked && !excluded) {
        recommendations.push(value);
      } else {
        advisoryEntries.push(value);
      }
    }
  }

  const genericGuidance = matchedEntryCount === 0 && query.provider_id
    ? {
      provider_id: query.provider_id,
      provider_kind: ["unknown", "custom", "self_hosted"].includes(query.provider_kind)
        ? query.provider_kind
        : "unknown",
      disposition: "retain",
      next_action: "investigate",
      planning_mode: "manual",
      assessment_depth: "generic",
      provider_specific_claims: false,
    }
    : null;
  if (genericGuidance) {
    gaps.push({
      code: "provider_knowledge_missing",
      knowledge_id: null,
      entry_id: null,
      provider_id: query.provider_id,
    });
  }

  return {
    schema_version: "launchrally.dev/provider-knowledge-assessment/v1",
    as_of: asOf,
    recommendations,
    advisory_entries: advisoryEntries,
    provider_verification_gaps: gaps,
    generic_guidance: genericGuidance,
    authority: { ...AUTHORITY },
  };
}
