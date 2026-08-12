# Audit

1. Resolve the repository root and exact CLI version.
2. Run `rally audit --json --cwd <repo>` through the documented package-manager path.
3. On `needs_input`, ask only the returned fields. Present inferred candidates as unconfirmed.
4. On `needs_confirmation`, present the entire Audit Brief, planned Checks, and authorization preview before forwarding the builder's decision.
5. On `needs_permission`, request each public, authenticated-journey, or Provider boundary separately, present every disclosed Provider command in order, and preserve denials.
6. On `needs_input` with `request.type: "authenticated_journey_results"`, follow [protected-journeys.md](protected-journeys.md) and resume with only the typed normalized results.
7. Resume with the returned token; start a new Audit on a token or scope error.
8. Treat the completed Snapshot, Assessment, Action Queue, gaps, and limitations as canonical. Never describe `Inconclusive` as ready to launch.

The Audit Brief records intended environment, confirmed public targets, public or protected core journeys, Provider roles, support layers, and planned Checks. A protected declaration uses `launchrally.dev/protected-journey/v1` and contains only its GET path, purpose, authentication class, and anonymous/authenticated status expectations. In the v2 JSON contract, targets remain stored in the compatibility field `production_targets`. Local discovery is already authorized; public verification, authenticated journey reads, and Provider reads remain pending until their exact scopes are confirmed and approved.

Each confirmed Failed Finding in the completed Audit has one structured Action Queue item. Preserve its Check ID, priority, severity, gating state, core-journey impact, safe Evidence references, concrete observation summaries, and exact targeted Verify selection. Local observations retain only their normalized target and outcome; other Checks use their safe Check-result summary. Public summaries are limited to the method, safe path, normalized outcome, status code when present, and probe identity; never infer a root cause or add response bodies, sensitive headers, raw Provider output, or unallowlisted Evidence fields. Keep Verification Gaps separate from confirmed failed work. Use `rally plan` for deeper investigation and remediation guidance.
