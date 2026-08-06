# LaunchRally

LaunchRally is a local-first, open-source launch readiness audit and verification tool for repository-owning AI builders.

This repository contains the first Phase 0 local Audit tracer. It establishes package boundaries, the CLI interaction contract, shared Agent Skill packaging, and one deterministic Web baseline Check. Production evidence collectors, initialization writes, plans, and the verification engine are intentionally not implemented yet.

## Quick start

```bash
npm install
npm run build
npm test
npm run rally -- audit --json
```

The first Audit invocation performs a Local Safe Scan and returns a versioned Audit Brief interaction. Unknown release intent becomes typed input, inferred values remain candidates until the builder confirms the complete Check plan, and public or Provider permissions are requested as separate boundaries. Resume tokens preserve repository scope and earlier decisions without repository writes.

After explicit confirmation and permission decisions, the Audit checks for a dependency lockfile through the Web Check Catalog path. A passing baseline remains `Inconclusive` because P0 coverage is incomplete; a failed baseline is `No Go`. Denied permissions become explicit Verification Gaps rather than aborting the Audit.

The Local Safe Scan collects provenance-backed facts from supported source and configuration files without retaining their contents in facts or outputs. It respects repository ignore rules and built-in exclusions for dependencies and build outputs, rejects binary and oversized artifacts, never follows symlinks, and stops at nested repository boundaries. Environment files are the deliberate ignore-rule exception: even a gitignored `.env*` file contributes variable names only. Package scripts likewise contribute script names rather than commands, so secret values cannot flow into snapshots, evidence, reports, terminal output, or errors.

## Repository layout

```text
packages/
  contracts/       Public protocol and schema constants
  core/            Framework-neutral discovery, Check Catalog, and audit orchestration
  cli/             The `rally` executable
skills/
  launchrally/     Canonical Agent Skill source
adapters/
  codex/           Codex Plugin package
  claude/          Claude Code Plugin package
scripts/
  sync-skills.mjs  Keeps both Plugin copies aligned with the canonical Skill
test/
  scaffold.test.js Initial contract and safety tests
```

## Current safety boundary

- No LaunchRally account or server is used.
- `audit` performs a boundary-checked Local Safe Scan and deterministic lockfile Check without repository writes.
- Human Mode explains missing intent and previews the complete plan before permission; Agent Mode exposes versioned typed interaction states.
- Local scan, public verification, and each Provider read are distinct authorization boundaries.
- Local facts include their repository-relative source path and scanner policy version.
- Environment values and raw package script commands are never included in Audit output.
- Provider access and network checks are not implemented.
- `init`, `plan`, and `verify` return an explicit `not_implemented` state.
- Missing P0 coverage is always reported as a Verification Gap, so the local tracer cannot return `Launch Ready`.

## Contribution flow

- Open feature and fix pull requests against `dev`.
- Promote releases with a pull request from `dev` to `main`.
- Pull requests into `main` from any other branch are closed automatically.

`dev` is the repository's default branch so new pull requests target it by default.

## Licence

The Phase 0 open-source licence must be selected before Repository Publication. No licence is asserted by this initial scaffold.
