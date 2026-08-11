# LaunchRally

**Know what stands between your repository and a trustworthy launch.**

[![Experimental release](https://img.shields.io/npm/v/@launchrally/cli/experimental?label=experimental)](https://www.npmjs.com/package/@launchrally/cli)
[![CI](https://github.com/codeacme17/launchrally/actions/workflows/ci.yml/badge.svg)](https://github.com/codeacme17/launchrally/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js 20.12+](https://img.shields.io/badge/node-%3E%3D20.12-339933.svg)](https://nodejs.org/)

LaunchRally is a local-first, open-source launch-readiness audit and verification tool for repository-owning AI builders. It turns repository facts, declared launch intent, and explicitly approved read-only evidence into a deterministic assessment and an ordered path to verification.

It needs no LaunchRally account, uses no default telemetry, and makes no repository, deployment, or Provider write during an Audit.

> **Status: Experimental P0.** P0 is Product Complete and `0.2.2` is publicly available on the non-stable `experimental` channel. Telemetry-Free Validation is collecting aggregate directional signals; LaunchRally is not P0 Validated.

## First Audit

Install the exact Experimental Launcher through your current npm prefix and verify its structured version output before entering a repository:

```bash
npm install --global @launchrally/cli@0.2.2
rally --version --json
```

If npm reports a prefix permission error or `rally` is not on `PATH`, do not use `sudo`. Follow the [Install guide](docs/getting-started/install.md) to choose a Node version manager or user-writable npm prefix and expose its executable directory yourself.

From the repository root, run the Human Audit and save its complete Report, then separately preview and confirm Init:

```bash
rally audit --plain --cwd . --output ./launchrally-audit-report.json
rally init --plain --cwd . --report ./launchrally-audit-report.json
rally --version --json --cwd .
```

Review the complete Brief before confirming the Audit. Public verification and every Provider read are independent permissions and default-denied. Denial remains a visible Verification Gap. Audit does not create `.launchrally`; the saved Report is an explicit output outside that directory.

Confirmed Init is the first project mutation. Its preview is limited to LaunchRally-owned `.launchrally` paths, materializes the exact Project Toolchain, and leaves application dependency files unchanged. The final read-only version command proves that the Launcher selected the project-pinned Engine through validated Execution Authority. A same, newer, or supported older Launcher follows that project pin instead of silently changing it.

The terminal below uses deterministic synthetic fixture output. Your result reflects your repository, confirmed scope, evidence, and permission choices.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/launchrally-terminal-dark.svg">
  <img src="docs/assets/launchrally-terminal-light.svg" alt="LaunchRally terminal showing an Inconclusive audit with verification gaps and the next init command" width="380">
</picture>

Continue with the [Quickstart](docs/getting-started/quickstart.md) for the complete journey.

## No-install trial and CI fallback

Exact-version npm-exec is supported as a no-install trial and CI fallback, not the default interactive journey. Its follow-ups retain the complete prefix so they remain executable after the first process exits:

```bash
npm exec --package=@launchrally/cli@0.2.2 -- rally audit --plain --cwd . --output ./launchrally-audit-report.json
npm exec --package=@launchrally/cli@0.2.2 -- rally init --plain --cwd . --report ./launchrally-audit-report.json
npm exec --package=@launchrally/cli@0.2.2 -- rally --version --json --cwd .
```

## How it works

1. **Audit** — scan local facts, confirm the complete Brief, decide each optional read, and save the complete Report. Audit does not create project state.
2. **Init and delegate** — preview and confirm LaunchRally-owned files, materialize the exact project Engine, and let the Launcher follow that pin for repository operations.
3. **Plan and Verify** — use the current Report for read-only guidance, hand remediation to your Agent only when requested, and recollect evidence for a fresh result.

The **Launcher** is the user-managed `rally` dispatcher. The **Engine** executes repository operations. The **Project Toolchain** records and materializes the exact project Engine. **Execution Authority** selects and validates it, while **Invocation Context** only describes how the Launcher was entered so safe follow-up commands can be rendered.

## What it checks and produces

| Area | What LaunchRally does |
| --- | --- |
| Repository and release intent | Discovers supported local facts, then asks you to confirm inferred scope. |
| Web launch baseline | Evaluates security, reliability, operability, and release-readiness Checks against versioned policy. |
| Public and Provider evidence | Performs only the bounded, read-only operations you approve; missing evidence stays visible. |
| Audit output | Returns a JSON Report Record, Markdown Report View, Evidence Index, Findings, and Verification Gaps. |
| Follow-up work | Produces a deterministic Launch Plan and fresh full or targeted verification results. |

The [Coverage Acceptance Matrix](docs/reference/coverage-acceptance.md) demonstrates the universal Baseline journey, not a framework or Provider support allowlist.

## Safety and permissions

- No LaunchRally account, private service, default telemetry, or mandatory Report upload.
- Audit performs no repository writes; confirmed Init is preview-first and stays under `.launchrally`.
- Local scan, public verification, and every Provider read are distinct, default-denied authorization boundaries.
- CLI or Plugin installation grants no Provider, deployment, production, credential, or application-source write authority.
- Reports and Evidence remain local unless the repository owner explicitly moves them.
- LaunchRally never installs Provider tools, initiates login, provisions infrastructure, deploys, stages, or commits changes.

Read the complete [privacy and permission model](docs/concepts/privacy.md) and [data model](docs/concepts/data-model.md) before using LaunchRally with sensitive repositories.

## Commands and integrations

| Command or integration | Purpose | Guide |
| --- | --- | --- |
| `rally audit` | Assess confirmed launch scope from local and approved read-only evidence. | [Quickstart](docs/getting-started/quickstart.md) |
| `rally init` | Preview and confirm isolated `.launchrally` project adoption. | [Initialization](skills/launchrally/references/init.md) |
| `rally toolchain` | Inspect, restore, migrate, or clean the project-owned toolchain explicitly. | [Install guide](docs/getting-started/install.md) |
| `rally plan` | Turn current Findings into ordered, read-only remediation guidance. | [Planning](skills/launchrally/references/plan.md) |
| `rally providers` | Compare advisory Provider Decision Cards after confirming constraints. | [Provider guidance](skills/launchrally/references/plan.md) |
| `rally verify` | Recollect evidence and record a fresh full or targeted result. | [Verification](skills/launchrally/references/verify.md) |
| Codex and Claude | Install, update, remove, and validate the Agent adapters separately from the CLI. | [Install guide](docs/getting-started/install.md) |

## Packages

| Package | Audience and purpose |
| --- | --- |
| [`@launchrally/cli`](packages/cli/README.md) | Builders running the first Audit and complete command journey. |
| [`@launchrally/core`](packages/core/README.md) | Library authors embedding deterministic audit and verification logic. |
| [`@launchrally/contracts`](packages/contracts/README.md) | Integrators consuming versioned schemas, constants, and protocol contracts. |
| [`@launchrally/codex-plugin`](adapters/codex/launchrally/README.md) | Codex users installing the canonical Agent Skill adapter. |
| [`@launchrally/claude-plugin`](adapters/claude/launchrally/README.md) | Claude Code users installing the canonical Agent Skill adapter. |

## Documentation and project links

- [Documentation index](docs/README.md)
- [Quickstart](docs/getting-started/quickstart.md)
- [Install and release guide](docs/getting-started/install.md) — lifecycle and troubleshooting authority
- [Project status and Telemetry-Free Validation](docs/maintainers/phase-0-validation.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [GitHub Discussions](https://github.com/codeacme17/launchrally/discussions)
- [GitHub Issues](https://github.com/codeacme17/launchrally/issues)
- [Apache-2.0 license](LICENSE)
