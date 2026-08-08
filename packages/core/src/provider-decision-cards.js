import { createRequire } from "node:module";

import { assertValidProviderDecisionCard } from "@launchrally/contracts";

const require = createRequire(import.meta.url);

export const PROVIDER_DECISION_CARDS = Object.freeze([
  require("../provider-decision-cards/v1/cloudflare-workers.json"),
  require("../provider-decision-cards/v1/vercel.json"),
].map((card) => {
  assertValidProviderDecisionCard(card);
  return Object.freeze(card);
}));

export function matchesProviderDecisionCard(decision) {
  return PROVIDER_DECISION_CARDS.some((card) =>
    decision?.card_id === card.card_id
    && decision.card_version === card.card_version
    && decision.capability_id === card.capability_scope.id
    && decision.provider === card.provider.id
    && decision.role === card.capability_scope.provider_role,
  );
}
