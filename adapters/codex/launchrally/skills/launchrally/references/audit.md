# Audit

1. Resolve the repository root and exact CLI version.
2. Run `rally audit --json --cwd <repo>` through the documented package-manager path.
3. On `needs_input`, ask only the returned fields. Present inferred candidates as unconfirmed.
4. On `needs_confirmation`, present the entire Audit Brief, planned Checks, and authorization preview before forwarding the builder's decision.
5. On `needs_permission`, request each public or Provider boundary separately and preserve denials.
6. Resume with the returned token; start a new Audit on a token or scope error.
7. Treat the completed Snapshot, Assessment, gaps, and limitations as canonical. Never describe `Inconclusive` as ready to launch.

The Audit Brief records intended environment, confirmed public targets, core journeys, Provider roles, support layers, and planned Checks. In the v2 JSON contract, those targets remain stored in the compatibility field `production_targets`. Local discovery is already authorized; public verification and Provider reads remain pending until their exact scopes are confirmed and approved.
