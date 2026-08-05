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

The Audit performs safe local project discovery and checks for a dependency lockfile through the Web Check Catalog path. A passing baseline remains `Inconclusive` because P0 coverage is incomplete; a failed baseline is `No Go`. The command does not create `.launchrally/` or contact external services.

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
- `audit` performs local discovery and a deterministic lockfile Check without repository writes.
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
