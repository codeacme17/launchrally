# Quickstart

LaunchRally `0.2.2` is a public Experimental release. Run it against a repository you control and review every disclosed read or write boundary before confirming it. Experimental means the product is not presented as stable or P0 Validated.

## Direct CLI Quickstart

Run its exact P0 CLI without a global installation:

```bash
npm exec --package=@launchrally/cli@0.2.2 -- rally audit --json --cwd .
```

The first response is a versioned interaction, not a completed assessment. Supply only the requested typed answers, confirm the complete Check plan, and decide public and Provider read permissions separately. Keep the completed JSON unchanged if you later choose `init`, `plan`, or `verify`; the [data-model guide](../concepts/data-model.md) explains those artifacts.

The v2 JSON contract retains `production_targets` as a compatibility field. Its values are the confirmed public targets for the reviewed `intended_environment`, so a staging Audit stores staging targets in `production_targets`; Human Mode and derived Report Views label them with the reviewed environment.

Omit `--json` in a TTY to run the complete Human Mode wizard in one process. It asks for release intent, plan confirmation, and each public or Provider read separately. Every permission defaults to denied. Use `--plain` for a framework-free numbered interface or when terminal styling is unsuitable; `TERM=dumb` selects it automatically.

Human Mode prints prompts to stderr and a concise assessment to stdout. Its completion summary gives the explicit assessment, Failed Findings, Verification Gaps, Report destination, and exact next command in separate labeled sections. Styling is enabled only for a compatible TTY; `--plain`, `TERM=dumb`, `NO_COLOR`, and redirected stdout preserve the same labels without ANSI styling. Human Mode does not expose resume tokens or write `.launchrally/**`. Add `--output <path>` or explicitly confirm saving the complete Audit JSON. The interactive save flow suggests `<cwd>/launchrally-audit-report.json` for one-selection acceptance, validates custom paths, and offers a native system file picker when a supported local GUI is available. It discloses the exact resolved destination before writing, rejects `.launchrally/**`, and never silently overwrites an existing file. A cancelled picker returns to the save menu; declining or pressing Ctrl-C writes nothing. Use the saved file with `rally init --report <path>`. Non-TTY callers must use `--json`, which preserves the versioned one-transition Agent/CI protocol.

The exact package-manager command preserves npm's download confirmation, makes no project change, and performs no global install.

## Skill Quickstart

Install the versioned Codex or Claude Plugin by following the [install guide](install.md), then ask the host Agent:

> Use LaunchRally to audit this repository for launch readiness. Show me the complete scope and every permission before continuing.

The Skill is an interaction layer. The local CLI remains the authority for Checks, Evidence, Severity, gates, and Assessments. The Skill cannot manufacture missing Evidence or silently grant permissions.

Optional Init pins the exact CLI in `.launchrally/toolchain` for every ecosystem, without editing application dependency files. It tries offline npm resolution first. If the cache is insufficient, approve or deny the separately disclosed `npm_registry_read` request before Init prepares its file preview; npm lifecycle scripts remain disabled.

## Secret-free ecosystem examples

The committed coverage fixtures use synthetic configuration and `.env.example` variable names only. They contain no credentials and require no LaunchRally account or private service:

```bash
npm exec --package=@launchrally/cli@0.2.2 -- rally audit --json --cwd fixtures/coverage/typescript-astro
npm exec --package=@launchrally/cli@0.2.2 -- rally audit --json --cwd fixtures/coverage/python-fastapi
npm exec --package=@launchrally/cli@0.2.2 -- rally audit --json --cwd fixtures/coverage/split-react-go
npm exec --package=@launchrally/cli@0.2.2 -- rally audit --json --cwd fixtures/coverage/pnpm-edge-monorepo
npm exec --package=@launchrally/cli@0.2.2 -- rally audit --json --cwd fixtures/coverage/custom-self-hosted
```

These represent an Astro TypeScript app, a FastAPI Python service, a split React and Go system, a pnpm Edge monorepo, and a custom self-hosted deployment. They demonstrate the universal Baseline; they are not a framework or deployment allowlist.
