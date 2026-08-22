# Phase 1 Experimental 0.4.2 external verification

Status: pending publication and independent external verification.

This record is intentionally incomplete in the Release Candidate. It must be
updated only after the protected `v0.4.2` workflow publishes all five exact
artifacts on npm `experimental`, verifies their candidate digests and
provenance, and the clean direct CLI, Codex, and Claude journeys complete.

The final record will contain only aggregate, non-sensitive conclusions and
public release links. Raw host transcripts, resume tokens, Reports, Evidence,
repository paths, target details, credentials, and personal data must not be
committed or uploaded.

The machine-readable aggregate is `release/p1-external-verification.json`.
While publication or any external host journey is incomplete, that record
must remain `pending`; it can become `completed` only from three distinct
signed CLI, Codex, and Claude host envelopes accepted by
`scripts/verify-p1-external-results.mjs`.

Publication does not imply Phase 1 Validated or Stable. Phase 0 Stable 0.3.2
must remain on npm `latest` throughout the Experimental publication.
