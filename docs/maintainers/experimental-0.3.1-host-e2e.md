# Experimental 0.3.1 host E2E evidence

This record closes the clean public-artifact and real-host acceptance gate in
[#99](https://github.com/codeacme17/launchrally/issues/99). It contains only
non-sensitive maintainer conclusions. Raw host transcripts, resume tokens,
Report and Evidence contents, repository paths, and target details were kept
in temporary local storage and were not committed or uploaded.

## Release identity and public artifacts

- Date: 2026-08-12
- Release: [`v0.3.1` Experimental](https://github.com/codeacme17/launchrally/releases/tag/v0.3.1)
- Tag commit: `db98b2a9a803bc19890f1d776e5b651274af7ee9`
- Protected release workflow:
  [run 31588343435](https://github.com/codeacme17/launchrally/actions/runs/31588343435)
- Public-smoke job:
  [job 94089697056](https://github.com/codeacme17/launchrally/actions/runs/31588343435/job/94089697056)

The protected workflow passed the Node 20.12, 22, and 24 contract matrix and
the Ubuntu, macOS, and Windows journey matrix. Trusted Publishing published
all five packages with provenance, after which the public-smoke job installed
the exact public artifacts and completed the full CLI journey plus Codex and
Claude Plugin installation, discovery, and removal checks.

| Package | Exact version | `experimental` | `latest` |
| --- | --- | --- | --- |
| `@launchrally/contracts` | `0.3.1` | `0.3.1` | `0.2.2` |
| `@launchrally/core` | `0.3.1` | `0.3.1` | `0.2.2` |
| `@launchrally/cli` | `0.3.1` | `0.3.1` | `0.2.2` |
| `@launchrally/codex-plugin` | `0.3.1` | `0.3.1` | `0.2.2` |
| `@launchrally/claude-plugin` | `0.3.1` | `0.3.1` | `0.2.2` |

The public-smoke result reported `source: public_registry`, the five exact
package identities, `full_journey: plan_handoff_verify_completed`, packaged
Codex and Claude fixture execution, normalized protected journeys, and both
native public Plugin installation paths. The workflow left the stable
`latest` channel unchanged.

## Real host journeys

Both journeys ran from clean synthetic repositories on macOS 26.5.1 arm64
with Node 24.19.0 and npm 11.17.0. The user-managed Launcher was installed
from `@launchrally/cli@0.3.1` into an isolated npm prefix. Each host loaded the
public `launchrally@launchrally` Plugin at version `0.3.1` in a fresh session
and followed the shipped Skill.

| Host | Host version | Result |
| --- | --- | --- |
| Codex | `codex-cli 0.147.0` | Passed |
| Claude Code | `2.1.224` | Passed |

Each host independently completed these typed transitions:

1. Structured version discovery with Launcher authority.
2. Audit input, scope confirmation, scoped read permission, and completed
   immutable source Report.
3. Previewed and explicitly confirmed Init, bounded to `.launchrally`.
4. Structured version discovery proving
   `authority.source: project_toolchain` with Engine `0.3.1`.
5. Typed `needs_refresh`, full refresh Verify, and a current Report.
6. Read-only Plan with every mutation effect equal to `none`.
7. Explicit Handoff owned by `host_agent`, with Provider, deployment, and
   production write authority not granted.
8. A final full, whole-release Verify using the Manifest-bound source Report.

Permission decisions were limited to the typed requests. Both hosts approved
the disclosed public-read boundary for the synthetic target. Codex approved
the exact `@launchrally/cli@0.3.1` registry materialization request; Claude
resolved the same exact project pin offline and therefore received no registry
request. No Provider read was requested because the synthetic release scope
declared no Provider roles; Provider and other undisclosed network paths
remained default-denied. No production or Provider write was performed.

## Invariant audit

The raw typed outputs and host events were inspected before recording these
conclusions:

- no manual resume-token transfer;
- no terminal-prose parsing for CLI authority or state;
- no direct Project Toolchain Engine invocation or other out-of-band
  authority guidance;
- no silent install, restore, migration, clean, downgrade, or removal;
- no application-source, deployment, Provider, or production mutation;
- no Report, Evidence, repository identity, local path, target, Provider
  metadata, credential, or raw transcript committed or uploaded; and
- temporary synthetic repositories contained the only host-journey project
  data and were outside this repository.

The journeys are successful protocol and lifecycle acceptance results. Their
synthetic release Assessments are not product release claims and are therefore
intentionally omitted from this non-sensitive evidence record.
