# Composite assurance

Treat `launchrally.dev/composite-assurance/v1` as the canonical environment-bound derivation for Phase 1 capability assurance. Preserve the seven facets independently: Requirement, Local Implementation, Provider Configuration, Integration Consistency, Deployment, Operational Delivery, and Downstream Outcome.

Never promote a higher facet because a lower facet passed. In particular, Provider Configuration does not prove deployment, operational delivery, or a downstream outcome. Evidence qualifies only for its explicit environment and currentness; there is no implicit cross-environment generalization. A negative absence Finding requires complete target coverage plus provenance-bearing observations. Partial, unsupported, denied, stale, or missing coverage remains Unverified.

Present the derived states exactly: `unverified`, `locally_evidenced`, `configured_not_deployed`, `deployed_not_operationally_verified`, `operationally_verified`, and `outcome_verified`. Required current-release capabilities gate against their capability-specific minimum assurance. Optional, deferred, future, and not-applicable capabilities do not silently become launch gates. Keep the resulting Launch Assessment independent from Architecture Status.
