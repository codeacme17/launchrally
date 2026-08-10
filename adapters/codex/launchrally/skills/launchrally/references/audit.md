# Audit

1. Resolve the repository root and exact CLI version.
2. Run `rally audit --json --cwd <repo>` through the documented package-manager path.
3. On `needs_input`, ask only the returned fields. Present inferred candidates as unconfirmed.
4. On `needs_confirmation`, present the entire Audit Brief, planned Checks, and authorization preview before forwarding the builder's decision.
5. On `needs_permission`, request each public or Provider boundary separately and preserve denials.
6. Resume with the returned token; start a new Audit on a token or scope error.
7. Treat the completed Snapshot, Assessment, Action Queue, gaps, and limitations as canonical. Never describe `Inconclusive` as ready to launch.

The Audit Brief records intended environment, confirmed public targets, core journeys, Provider roles, support layers, and planned Checks. In the v2 JSON contract, those targets remain stored in the compatibility field `production_targets`. Local discovery is already authorized; public verification and Provider reads remain pending until their exact scopes are confirmed and approved.

Each confirmed Failed Finding in the completed Audit has one structured Action Queue item. Preserve its Check ID, priority, severity, gating state, core-journey impact, safe Evidence references, concrete observation summaries, and exact targeted Verify selection. Local observations retain only their normalized target and outcome; other Checks use their safe Check-result summary. Public summaries are limited to the method, safe path, normalized outcome, status code when present, and probe identity; never infer a root cause or add response bodies, sensitive headers, raw Provider output, or unallowlisted Evidence fields. Keep Verification Gaps separate from confirmed failed work. Use `rally plan` for deeper investigation and remediation guidance.
