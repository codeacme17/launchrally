# Quickstart

LaunchRally `0.3.2` is a public Stable release. Run it against a repository you control and review every disclosed read or write boundary before confirming it. Stable means the reviewed P0 Validated decision and Quality Floor requirements are satisfied.

## Direct CLI Quickstart

LaunchRally's default interactive journey uses a user-managed PATH installation. Install the exact Launcher through your current npm prefix, then verify structured output before entering a repository:

```bash
npm install --global @launchrally/cli@0.3.2
rally --version --json
```

Do not use `sudo`, a floating tag, a pipe-to-shell installer, or an automatic shell-profile change. If the prefix is not writable or the command is missing, use the [Install guide](install.md) to choose and expose a user-writable prefix.

## Audit, save, Init, and prove delegation

Enter the repository root and run this continuous Human Mode path:

```bash
rally audit --plain --cwd . --output ./launchrally-audit-report.json
rally init --plain --cwd . --report ./launchrally-audit-report.json
rally --version --json --cwd .
rally verify --plain --cwd . --report ./launchrally-audit-report.json --scope full
```

The Audit presents the complete Brief and Check plan before work begins. Local scan, public verification, and every Provider read are independent permissions and default-denied. A denial completes transparently with a Verification Gap; it is never reused as permission for another boundary. The complete Report and Evidence stay local.

Audit does not create `.launchrally`; `--output` saves the complete Report at the explicit path shown above. Confirmed Init is the first project mutation. In TTY Human Mode, Init remains in the same process: approve or deny any separate `npm_registry_read` request, then review a concise decision summary with the affected root, operation counts, every affected path and digest, Manifest source identity, Project Toolchain materialization, and write-authority boundaries. Choose `View full preview` to inspect every exact diff and complete after-content, then return to the same digest-bound preview to confirm or decline it. Viewing details, declining, or pressing Ctrl-C leaves project-owned files unchanged. Init changes only LaunchRally-owned `.launchrally` paths, materializes the exact Project Toolchain, and leaves application dependency files unchanged.

TTY Human Verify also remains in one process. It presents every fresh public, Provider, and authenticated-Journey permission independently, defaults each decision to denied, and sends approved authenticated reads only through the installed typed host runner. Denial completes with explicit Verification Gaps. Cancellation performs no pending read, and Human output never exposes a resume token. A full completion writes only the normal immutable Report and structurally allowlisted Evidence history under `.launchrally`.

Agent Mode, including CI use, retains the explicit structured protocol. Start Init with `rally init --json --cwd . --report ./launchrally-audit-report.json` or Verify with `rally verify --json --cwd . --report ./launchrally-audit-report.json --scope full`, then use each returned `--resume <token>` with only the requested permission, confirmation, or typed Journey-result option. Non-TTY Human Mode fails safely and prints a complete shell-safe Agent command instead of presenting an inactive choice.

Re-running ordinary Init preserves an existing Manifest and identifies the explicit replacement action. If a corrected current Audit should become the new source of project-owned release intent, run `rally init --plain --cwd . --report ./corrected-audit-report.json --rebind`. Confirm only after reviewing both source Report identities and the exact Manifest diff. Decline, abandonment, or a stale preview changes nothing, and rebind preserves the Project Toolchain and immutable history.

The final version command is read-only. Require `authority.state: "ready"` and, after Init, `authority.source: "project_toolchain"`. The Launcher then delegates repository commands to the project-pinned Engine. A supported same, newer, or older Launcher follows the valid pin; it does not upgrade, downgrade, or replace it.

After obtaining a current full Report, continue with the [Phase 1 Agent and Human journey](phase-1.md) to confirm Product Intent, review Architecture, build a Task Graph, coordinate bounded external work, and independently Verify it.

Init makes the saved Manifest-bound Audit Report historical. Follow the typed `needs_refresh` response with a full Verify, use the new current Report for Plan and Handoff, and retain the original saved Report for future whole-release Verify input. The [Agent reference journey](../../skills/launchrally/references/reference-journey.md) shows that complete typed flow.

After a whole-release Human Verify commits immutable history, its completion summary separately labels the Manifest-bound source Report and the new current Report, explains failed Checks and Verification Gaps, and prints the current input as `.launchrally/reports/<current-report-id>/record.json`. Run the exact displayed `rally plan --cwd ... --report ...` command; Plan reconstructs the complete package from the Record, View, and Evidence Index, validates their digests and currentness, and fails closed if local history is missing, incomplete, tampered, stale, symlinked, or ambiguous. Continue using the original saved Audit JSON—not this current Plan input—for later whole-release Verify runs.

## No-install trial and CI fallback

Exact-version npm-exec is a no-install trial and CI fallback. It is not the default Agent prerequisite. Use complete npm-exec follow-ups because the first ephemeral process does not leave `rally` on PATH:

```bash
npm exec --package=@launchrally/cli@0.3.2 -- rally audit --plain --cwd . --output ./launchrally-audit-report.json
npm exec --package=@launchrally/cli@0.3.2 -- rally init --plain --cwd . --report ./launchrally-audit-report.json
npm exec --package=@launchrally/cli@0.3.2 -- rally --version --json --cwd .
npm exec --package=@launchrally/cli@0.3.2 -- rally verify --plain --cwd . --report ./launchrally-audit-report.json --scope full
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
