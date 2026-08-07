# Quickstart

LaunchRally is Experimental. Run it against a repository you control and review every disclosed read or write boundary before confirming it.

## Direct CLI Quickstart

Run the exact P0 CLI without a global installation:

```bash
npm exec --package=@launchrally/cli@0.1.0 -- rally audit --json --cwd .
```

The first response is a versioned interaction, not a completed assessment. Supply only the requested typed answers, confirm the complete Check plan, and decide public and Provider read permissions separately. Keep the completed JSON unchanged if you later choose `init`, `plan`, or `verify`; the [data-model guide](data-model.md) explains those artifacts.

Omit `--json` for the Human Mode rendering. It uses the same CLI contract and permission boundaries. The exact package-manager command preserves npm's download confirmation, makes no project change, and performs no global install.

## Skill Quickstart

Install the versioned Codex or Claude Plugin by following the [install guide](install.md), then ask the host Agent:

> Use LaunchRally to audit this repository for launch readiness. Show me the complete scope and every permission before continuing.

The Skill is an interaction layer. The local CLI remains the authority for Checks, Evidence, Severity, gates, and Assessments. The Skill cannot manufacture missing Evidence or silently grant permissions.

## Secret-free ecosystem examples

The committed coverage fixtures use synthetic configuration and `.env.example` variable names only. They contain no credentials and require no LaunchRally account or private service:

```bash
npm exec --package=@launchrally/cli@0.1.0 -- rally audit --json --cwd fixtures/coverage/typescript-astro
npm exec --package=@launchrally/cli@0.1.0 -- rally audit --json --cwd fixtures/coverage/python-fastapi
npm exec --package=@launchrally/cli@0.1.0 -- rally audit --json --cwd fixtures/coverage/split-react-go
npm exec --package=@launchrally/cli@0.1.0 -- rally audit --json --cwd fixtures/coverage/pnpm-edge-monorepo
npm exec --package=@launchrally/cli@0.1.0 -- rally audit --json --cwd fixtures/coverage/custom-self-hosted
```

These represent an Astro TypeScript app, a FastAPI Python service, a split React and Go system, a pnpm Edge monorepo, and a custom self-hosted deployment. They demonstrate the universal Baseline; they are not a framework or deployment allowlist.
