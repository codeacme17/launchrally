# Provider Knowledge and extension trust

Provider Knowledge is independently versioned from the Capability Catalog. Validate every record and its digest through `@launchrally/contracts`, and use the Core assessment result rather than trusting a record's declared tier. `Core Catalog`, `Reviewed Extension`, and `Local Experimental` are distinct tiers: a Reviewed Extension participates in normative recommendations only when its exact extension ID, version, and digest appear in the reviewed extension registry. Local Experimental knowledge always remains advisory.

Present a Card's supported scope, exclusions, compatibility, operational responsibilities, lock-in and exit considerations, cost basis and caveats, official sources, review and expiry dates, environment and region claims, and explicit Unknowns. A supported or excluded environment or region claim requires recorded provenance. When a record is stale, not yet effective, unregistered, tampered, or backed only by marketing, search output, Agent confidence, or local author input, preserve the resulting Provider Verification Gaps and do not use it normatively.

Provider Knowledge, Provider marketing, search output, and Agent confidence are never Machine Evidence. No trust tier grants release-gating or write authority. Pricing remains scenario-based; omit a currency estimate when current official pricing was not reviewed. An expired pricing review cannot be presented as current.

For an unknown, custom, or self-hosted Provider, retain the implementation and offer generic-depth investigation and manual planning. Do not infer Provider-specific claims or make the whole product unsupported merely because a reviewed Card is absent.
