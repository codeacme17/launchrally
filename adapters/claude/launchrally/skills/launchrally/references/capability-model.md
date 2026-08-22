# Capability model

Use the versioned Provider-neutral Capability Catalog as the vocabulary for architecture, planning, and verification. Its 13 launch domains are runtime, identity, data, billing/entitlement, object storage, communication, background work, observability, analytics/privacy, DNS/TLS, CI/CD, secrets/configuration, and backup/recovery/retention.

Keep each Capability Graph node's requirement, decision, implementation, and Evidence state separate. Never summarize these facets as a completion percentage. Preserve application-native, managed, existing-platform, custom, self-hosted, deferred, not-applicable, and Unknown implementation paths exactly as typed.

Show every derived obligation with its source behavior, target capability, and complete derivation chain. A candidate that materially changes Product Intent stays a candidate until the builder explicitly selects it; never treat Agent derivation as confirmation.

Integration Contracts are Provider-neutral. Preserve their environment and synchronous or asynchronous mode together with authentication or signature, ordering, duplication, retry, replay, idempotency, eventual consistency, failure visibility, privacy, success Evidence, and declared invalidation dependencies. Set `semantics.idempotency` to exactly `required`, `not_required`, `not_applicable`, or `unknown`; when it is `required`, record a normalized deduplication identifier separately as optional `semantics.idempotency_key`. Existing `required_by_<key>` and `deduplicate_by_<key>` values remain readable, but rewrite them as `required` plus `idempotency_key` whenever a contract is authored or migrated. An unknown Provider uses `kind: unknown` with no invented Provider identity.

When a Catalog capability changes, invalidate only outputs that explicitly depend on that capability or declare a whole-Catalog dependency. Do not make unrelated architecture, planning, or verification outputs stale.
