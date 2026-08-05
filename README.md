# LaunchRally

LaunchRally is a local-first, open-source launch readiness audit and verification tool for repository-owning AI builders.

This repository is the initial Phase 0 scaffold. It establishes package boundaries, the CLI interaction contract, and shared Agent Skill packaging. The Check Catalog, production evidence collectors, initialization writes, plans, and verification engine are intentionally not implemented yet.

## Quick start

```bash
npm install
npm run build
npm test
npm run rally -- audit --json
```

The scaffold audit only performs safe local project discovery. It returns `Inconclusive` because no production Checks have been implemented, and it does not create `.launchrally/` or contact external services.

## Repository layout

```text
packages/
  contracts/       Public protocol and schema constants
  core/            Framework-neutral discovery and audit orchestration
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
- `audit` performs local discovery only and makes no repository writes.
- Provider access and network checks are not implemented.
- `init`, `plan`, and `verify` return an explicit `not_implemented` state.
- No Check can be marked `Passed` by this scaffold.

## Contribution flow

- Open feature and fix pull requests against `dev`.
- Promote releases with a pull request from `dev` to `main`.
- Pull requests into `main` from any other branch are closed automatically.

`dev` is the repository's default branch so new pull requests target it by default.

## Licence

The Phase 0 open-source licence must be selected before Repository Publication. No licence is asserted by this initial scaffold.
