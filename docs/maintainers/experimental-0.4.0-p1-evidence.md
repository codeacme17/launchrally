# Phase 1 Experimental 0.4.0 external verification

Status: completed publication and independent external verification.

The protected [`v0.4.0` workflow](https://github.com/codeacme17/launchrally/actions/runs/31885222828)
published all five exact artifacts on npm `experimental` from commit
`be357f50fac20e8e9ef3dab2791472ed46b3f6c4`. The `prerelease`, `public-smoke`,
and `publish` jobs completed successfully. Every package matched the reviewed
candidate integrity and shasum and carried verified SLSA v1 provenance:

- `@launchrally/contracts@0.4.0`
- `@launchrally/core@0.4.0`
- `@launchrally/cli@0.4.0`
- `@launchrally/codex-plugin@0.4.0`
- `@launchrally/claude-plugin@0.4.0`

The public release is [`v0.4.0`](https://github.com/codeacme17/launchrally/releases/tag/v0.4.0).
Phase 0 Stable `0.3.2` remains on npm `latest`; Phase 1 `0.4.0` remains only on
`experimental` or available by exact version.

## Clean external journeys

Three distinct random challenges produced signed host envelopes. The verifier
accepted each envelope, independently recomputed its digest, and bound it to
the same exact public-result contract. The external reviewer observed the
native invocations and posted the exact verifier-generated statement in
[issue #141](https://github.com/codeacme17/launchrally/issues/141#issuecomment-5302650515).

| Host | Exact artifact | Scenario status | Typed boundary | Fresh Verify |
| --- | --- | --- | --- | --- |
| Direct CLI | `@launchrally/cli@0.4.0` | Completed | `challenge_response_captured` | Qualifying environment-bound results observed |
| Codex | `@launchrally/codex-plugin@0.4.0` | Completed | `challenge_response_captured` | Qualifying environment-bound results observed |
| Claude | `@launchrally/claude-plugin@0.4.0` | Completed | `challenge_response_captured` | Qualifying environment-bound results observed |

The machine-checked journeys covered the representative successful path plus
denied write authority, missing Executor, partial receipt, stale Architecture,
and fresh Verify boundaries. Receipts remained claims; only fresh,
environment-bound qualifying Evidence advanced verification. The clean-host
checks reported no unauthorized install, login, upload, write, secret transfer,
or sensitive persistence.

This record contains only aggregate, non-sensitive conclusions and public
release links. Raw host transcripts, resume tokens, Reports, Evidence,
repository paths, target details, credentials, and personal data were not
committed or uploaded.

The machine-readable aggregate is `release/p1-external-verification.json`.
It was produced only after three distinct signed CLI, Codex, and Claude host
envelopes were accepted by `scripts/verify-p1-external-results.mjs`. Raw host
envelopes and transcripts remain outside the repository.

This evidence completes `P1-RELEASE-01`, the `p1_external_verification` gate,
and the Phase 1 Product Complete definition. Publication and Product Complete
do not imply Phase 1 Validated or Stable. Phase 0 Stable 0.3.2 remains on npm
`latest` throughout the Experimental publication.
