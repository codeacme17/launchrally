# Quickstart

LaunchRally `0.3.0` is a public Experimental release. Run it against a repository you control and review every disclosed read or write boundary before confirming it. Experimental means the P0 Validated product is not yet presented as Stable.

## Direct CLI Quickstart

LaunchRally's default interactive journey uses a user-managed PATH installation. Install the exact Launcher through your current npm prefix, then verify structured output before entering a repository:

```bash
npm install --global @launchrally/cli@0.3.0
rally --version --json
```

Do not use `sudo`, a floating tag, a pipe-to-shell installer, or an automatic shell-profile change. If the prefix is not writable or the command is missing, use the [Install guide](install.md) to choose and expose a user-writable prefix.

## Audit, save, Init, and prove delegation

Enter the repository root and run this continuous Human Mode path:

```bash
rally audit --plain --cwd . --output ./launchrally-audit-report.json
rally init --plain --cwd . --report ./launchrally-audit-report.json
rally --version --json --cwd .
```

The Audit presents the complete Brief and Check plan before work begins. Local scan, public verification, and every Provider read are independent permissions and default-denied. A denial completes transparently with a Verification Gap; it is never reused as permission for another boundary. The complete Report and Evidence stay local.

Audit does not create `.launchrally`; `--output` saves the complete Report at the explicit path shown above. Confirmed Init is the first project mutation. Review its authoritative preview and any separate `npm_registry_read` request. Init changes only LaunchRally-owned `.launchrally` paths, materializes the exact Project Toolchain, and leaves application dependency files unchanged.

The final version command is read-only. Require `authority.state: "ready"` and, after Init, `authority.source: "project_toolchain"`. The Launcher then delegates repository commands to the project-pinned Engine. A supported same, newer, or older Launcher follows the valid pin; it does not upgrade, downgrade, or replace it.

Init makes the saved Manifest-bound Audit Report historical. Follow the typed `needs_refresh` response with a full Verify, use the new current Report for Plan and Handoff, and retain the original saved Report for future whole-release Verify input. The [Agent reference journey](../../skills/launchrally/references/reference-journey.md) shows that complete typed flow.

## No-install trial and CI fallback

Exact-version npm-exec is a no-install trial and CI fallback. It is not the default Agent prerequisite. Use complete npm-exec follow-ups because the first ephemeral process does not leave `rally` on PATH:

```bash
npm exec --package=@launchrally/cli@0.3.0 -- rally audit --plain --cwd . --output ./launchrally-audit-report.json
npm exec --package=@launchrally/cli@0.3.0 -- rally init --plain --cwd . --report ./launchrally-audit-report.json
npm exec --package=@launchrally/cli@0.3.0 -- rally --version --json --cwd .
```

npm may show its normal package-download confirmation. LaunchRally does not suppress it or add `--yes`.

## Skill Quickstart

CLI installation and Plugin installation are separate prerequisites. After the Launcher works, install the versioned Codex or Claude Plugin from the [single installation authority](install.md), verify host discovery, then ask:

> Use LaunchRally to audit this repository for launch readiness. Show me the complete scope and every permission before continuing.

The Plugin is an interaction layer. It begins with `rally --version --json --cwd .`, validates Execution Authority, and follows the selected Engine through the Launcher. It cannot manufacture Evidence, silently grant permissions, install or migrate a toolchain, or gain Provider, deployment, production, credential, or application-source write authority.

## Lifecycle at a glance

The user-managed **Launcher**, selected **Engine**, repository-owned **Project Toolchain**, versioned **Execution Authority**, and descriptive **Invocation Context** are separate layers. So are their lifecycle actions:

- Update, downgrade, or remove the global Launcher with explicit npm commands.
- Update or remove the Codex or Claude Plugin with the host's commands.
- Inspect, restore, migrate, or clean a Project Toolchain with explicit `rally toolchain` operations.
- Retain or manually delete `.launchrally` project data independently of either uninstall.

See [Install, lifecycle, and troubleshooting](install.md) for exact commands, PATH recovery, offline/cache behavior, legacy `0.2.2`, and safe removal.

## Secret-free ecosystem examples

After installing the Launcher, these committed fixtures exercise the universal Baseline without credentials or private services:

```bash
rally audit --json --cwd fixtures/coverage/typescript-astro
rally audit --json --cwd fixtures/coverage/python-fastapi
rally audit --json --cwd fixtures/coverage/split-react-go
rally audit --json --cwd fixtures/coverage/pnpm-edge-monorepo
rally audit --json --cwd fixtures/coverage/custom-self-hosted
```

They represent an Astro TypeScript app, a FastAPI Python service, a split React and Go system, a pnpm Edge monorepo, and a custom self-hosted deployment. They demonstrate the universal Baseline; they are not a framework or deployment allowlist.
