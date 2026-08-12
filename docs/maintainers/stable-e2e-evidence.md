# Stable promotion E2E evidence

This record approves the maintainer end-to-end evidence used by the coherent
`v0.3.2` Stable promotion. It contains only aggregate, non-sensitive
conclusions. Raw CLI and host output, resume tokens, Report and Evidence
contents, repository paths, and target details were not committed or uploaded.

## Reviewed baseline

The Stable candidate is the coherent release-only successor to the validated
public [`v0.3.1` Experimental release](https://github.com/codeacme17/launchrally/releases/tag/v0.3.1).
Its protected publication and public-registry smoke completed in
[workflow run 31588343435](https://github.com/codeacme17/launchrally/actions/runs/31588343435).
The detailed non-sensitive host record is
[Experimental 0.3.1 host E2E evidence](experimental-0.3.1-host-e2e.md).

That reviewed baseline proves all of the following:

- the exact public direct CLI completed install, Audit, confirmed Init,
  project-toolchain delegation, read-only Plan, explicit Handoff, and final
  full Verify;
- Codex CLI `0.147.0` loaded the public `0.3.1` Plugin and independently
  completed the same shipped typed-state journey;
- Claude Code `2.1.224` loaded the public `0.3.1` Plugin and independently
  completed the same shipped typed-state journey;
- disclosed public reads were explicitly approved, and Codex separately
  approved exact npm registry materialization;
- Provider reads that were not requested remained default-denied; and
- no manual resume-token transfer, terminal-prose authority parsing,
  out-of-band Engine invocation, silent lifecycle operation, production or
  Provider mutation, or Report/Evidence upload occurred.

The `v0.3.2` promotion changes the coherent version, compatibility declaration,
release channel, and public status claims without adding runtime authority.
Before publication, the protected workflow must still pass the full source,
packed-artifact, Node, operating-system, and Stable-readiness gates at the exact
tagged candidate. After publication, it must pass exact public CLI and Plugin
smoke against npm `latest` before merging these Stable claims or announcing a
GitHub Latest Release.

## Explicit denied-permission journey

On 2026-08-12, an additional maintainer run installed the exact public
`@launchrally/cli@0.3.1` into an isolated temporary prefix and ran Audit against
a clean synthetic repository. The disclosed `public_verification` permission
was explicitly denied through the typed CLI interaction.

The observed state sequence was:

```text
needs_input -> needs_confirmation -> needs_permission -> completed
```

The completed result retained the denial in its authorization plan, produced
three `permission_denied` Verification Gaps, recorded zero public Evidence
references, and made no repository mutation. No Provider permission was in
scope. The synthetic repository and raw result were deleted after these
aggregate assertions passed.

## Stable evidence mapping

| Required evidence | Reviewed conclusion |
| --- | --- |
| `direct_cli` | Full public direct CLI journey passed. |
| `codex_plugin` | Real Codex host and shipped Plugin journey passed. |
| `claude_plugin` | Real Claude Code host and shipped Plugin journey passed. |
| `approved_permission` | Public verification and applicable registry reads were explicitly approved at their typed boundaries. |
| `denied_permission` | An explicit public-read denial completed with transparent Gaps, no public Evidence, and no mutation. |

This evidence establishes Stable promotion eligibility only. The protected
workflow remains the authority for publishing the five exact `0.3.2` packages
to `latest`, verifying their public behavior, merging the reviewed promotion
commit, and creating the regular GitHub Latest Release.

## Promotion sequencing recovery

On 2026-08-12, the first `dev` to `main` promotion pull request was manually
merged before an independent review, protected tag, npm publication, or public
smoke. At that point no `0.3.2` package, tag, or GitHub Release existed. The
merged pull request is not accepted as publication evidence and cannot satisfy
the release workflow's required open-and-approved PR boundary.

The corrective path preserves the original gate: a restricted workflow creates
a new bot-authored `dev` to `main` promotion pull request for independent human
approval. The exact tagged follow-up head must then pass the unchanged protected
Trusted Publishing, public smoke, merge, and announcement sequence. No registry
tag or release is moved manually as part of this recovery.

The bot-authored follow-up pull request passed the full Node and operating-system
matrix and received an independent owner approval bound to its exact head. It
was then manually merged on 2026-08-12 before the protected tag, Trusted
Publishing, or public smoke. The repository-level Actions pull-request setting
had already been restored to disabled. This second premature merge is likewise
not publication evidence: the five `0.3.2` packages, tag, and GitHub Release
still did not exist.

The final recovery repeats the same unchanged gate with a new evidence-only
`dev` head. Its bot-authored promotion pull request must remain open after human
approval. Only `.github/workflows/release.yml` may merge it, and only after the
exact tagged packages resolve from npm `latest` and the public CLI and Plugin
smoke journeys pass.
