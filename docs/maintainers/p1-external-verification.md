# Phase 1 external verification procedure

Run this procedure only after the protected `v0.4.0` workflow has published
all five packages and its public smoke plus provenance checks are green. Use a
fresh local account or disposable VM for each host. Do not copy tokens,
cookies, configuration, Reports, Evidence, repository data, or host state from
the release workspace. Use a clean Linux or macOS host for this normative
matrix; the authenticated fresh-Evidence collection is deliberately
unavailable on Windows.

## Prove the public artifacts

Create one clean checkout of the exact public tag per host. The tagged public
runner creates fresh non-sensitive fixtures for every scenario; no separately
authored `$PHASE1_FIXTURE` is accepted.

```bash
PHASE1_RELEASE="$(mktemp -d)/launchrally"
git clone --depth 1 --branch v0.4.0 https://github.com/codeacme17/launchrally.git "$PHASE1_RELEASE"
cd "$PHASE1_RELEASE"
npm ci --ignore-scripts
node scripts/verify-experimental-release.mjs --phase published --json
CLI_CHALLENGE="$(openssl rand -hex 32)"
node scripts/record-p1-external-host.mjs \
  --host cli \
  --challenge "$CLI_CHALLENGE" \
  --output /tmp/launchrally-p1-cli.json
```

The result must identify 0.4.0 on `experimental`, retain 0.3.2 on `latest`, and
match all five committed integrity values and the GitHub release-workflow SLSA
provenance. Stop if any identity, digest, tag, commit, or channel differs.

## Codex journey

Use the clean host's own authenticated Codex session; never export its
credential into the fixture or transcript.

```bash
codex plugin marketplace add codeacme17/launchrally --ref v0.4.0
codex plugin add launchrally@launchrally
CODEX_CHALLENGE="$(openssl rand -hex 32)"
codex -C "$PHASE1_RELEASE" "Use the installed LaunchRally Skill. Run exactly: node scripts/record-p1-external-host.mjs --host codex --challenge $CODEX_CHALLENGE --output /tmp/launchrally-p1-codex.json. Do not replace the command with prose. Report success only if the command exits zero."
codex plugin remove launchrally@launchrally
codex plugin marketplace remove launchrally
```

## Claude journey

Use the clean host's own authenticated Claude Code session with the Plugin
installed at explicit user scope.

```bash
claude plugin marketplace add codeacme17/launchrally@v0.4.0 --scope user
claude plugin install launchrally@launchrally --scope user
cd "$PHASE1_RELEASE"
CLAUDE_CHALLENGE="$(openssl rand -hex 32)"
claude "Use the installed LaunchRally Skill. Run exactly: node scripts/record-p1-external-host.mjs --host claude --challenge $CLAUDE_CHALLENGE --output /tmp/launchrally-p1-claude.json. Do not replace the command with prose. Report success only if the command exits zero."
claude plugin uninstall launchrally@launchrally --scope user
```

## Required scenario matrix

The public runner creates a fresh fixture per row and emits these exact
machine-checkable outcomes:

| Required row | JSON predicate |
| --- | --- |
| Representative success | `installation_journeys.full_journey === "plan_handoff_verify_completed"` and `product_journeys` contains `astro-hosted-web` |
| Permission denial | `p1_exact_artifacts.scenarios` contains `denied_write` |
| Missing Executor | `p1_exact_artifacts.scenarios` contains `missing_executor` |
| Partial failure | `p1_exact_artifacts.scenarios` contains `partial_receipt` |
| Stale state | `p1_exact_artifacts.scenarios` contains `stale_architecture` |
| Fresh Verify | receipt claims remain `verification_required`; downstream outcomes are `environment_bound_machine_evidence` and `environment_bound_no_go` |

Generate the exact review statement from all three envelopes:

```bash
node scripts/verify-p1-external-results.mjs \
  --version 0.4.0 \
  --cli /tmp/launchrally-p1-cli.json \
  --codex /tmp/launchrally-p1-codex.json \
  --claude /tmp/launchrally-p1-claude.json \
  --review-template
```

An independent external reviewer must have observed the three native
invocations and post that exact statement as a comment on issue #141. The
reviewer must not be the actor who triggered the protected release workflow.
The final verifier reads both identities from GitHub and rejects self-review.

Validate all three outputs and the public review instead of accepting Agent
prose. Replace both placeholders with exact public URLs:

```bash
node scripts/verify-p1-external-results.mjs \
  --version 0.4.0 \
  --cli /tmp/launchrally-p1-cli.json \
  --codex /tmp/launchrally-p1-codex.json \
  --claude /tmp/launchrally-p1-claude.json \
  --workflow-url https://github.com/codeacme17/launchrally/actions/runs/REPLACE_WITH_RUN_ID \
  --release-url https://github.com/codeacme17/launchrally/releases/tag/v0.4.0 \
  --review-url https://github.com/codeacme17/launchrally/issues/141#issuecomment-REPLACE_WITH_COMMENT_ID \
  --output /tmp/launchrally-p1-external-verification.json \
  --json
```

The three random challenges must differ. Each host command creates a signed,
host-specific execution envelope over the exact public-runner result. The
aggregate verifier checks envelope integrity, distinct challenges, the exact
five-package roster and candidate digests, SLSA provenance conclusions, public
npm/workflow/release links, and the independently authored GitHub observation.
It also dereferences the public tag to the workflow head, reads the candidate
manifest from that exact commit, and requires `publish`, `public-smoke`, and
`prerelease` to have completed successfully.
It also requires a clean-host result with no unauthorized install, login,
upload, write, secret transfer, or sensitive persistence. A copied CLI result,
Plugin discovery, adapter import, generated prose, self-review, or Execution
Receipt cannot replace independently observed zero-exit Agent invocations and
their machine-checked envelopes.

Record only these non-sensitive conclusions in
`experimental-0.4.0-p1-evidence.md`: host and exact version, public workflow
URL, public release/package links, scenario status, typed boundary reached,
and whether the fresh Verify result was qualifying. Independently review that
record before changing `P1-RELEASE-01`, `p1_external_verification`, or Product
Complete. Copy only the aggregate output—not the raw host envelopes—into
`release/p1-external-verification.json`; `npm run test:p1-external` and
`npm run validate:p1` must both pass. Publication alone leaves all three
unchanged.
