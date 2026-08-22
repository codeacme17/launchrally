# @launchrally/cli

The LaunchRally CLI provides the `rally` Launcher and deterministic Engine for auditing and verifying an existing repository while keeping the first Audit local-first, account-free, and output-only.

## Status

LaunchRally 0.4.2 is an **Experimental Phase 1** release. Phase 1 adds Product Intent, Provider-neutral Architecture, bounded Executor coordination, and fresh assurance without relabeling Phase 0 Stable 0.3.2 on npm `latest`. Phase 1 publication does not imply Validated or Stable. Review every disclosed permission and preview before continuing.

Phase 0 0.3.2 remains a **Stable** release. P0 is Product Complete and P0 Validated with the Quality Floor satisfied.

## Install and complete the first journey

Install the exact Launcher through your current user-writable npm prefix and verify it before entering a repository:

```sh
npm install --global @launchrally/cli@0.4.2
rally --version --json
```

From the repository root, save the complete Human Audit Report, separately confirm Init, and verify that the Launcher selected the project-pinned Engine:

```sh
rally audit --plain --cwd . --output ./launchrally-audit-report.json
rally init --plain --cwd . --report ./launchrally-audit-report.json
rally --version --json --cwd .
rally verify --plain --cwd . --report ./launchrally-audit-report.json --scope full
```

Audit performs no repository write and does not create `.launchrally`. Public and Provider reads are independent and default-denied. Human Init first shows a concise summary of every affected path, operation, digest, source identity, toolchain materialization, and authority boundary. Choose `View full preview` to inspect every exact diff and after-content before returning to the same confirmation. Confirmed Init is the first project mutation, stays under LaunchRally-owned `.launchrally` paths, materializes the exact Project Toolchain, and leaves application dependency files unchanged.

TTY Human Verify keeps fresh Evidence review in the same process. It shows every public probe, Provider command sequence, and authenticated Core Journey separately; each approval defaults to denied. Approved authenticated reads use only the typed installed host runner, while denial completes with Verification Gaps. Cancellation performs no pending read, and Human prose never exposes resume tokens. `--json` retains the explicit `--resume`, `--permissions`, and `--journey-results` Agent/CI protocol unchanged.

Ordinary Init preserves an existing Manifest while it may preview adoption of a newer Report into immutable history. To replace incorrect or outdated release intent with a current corrected Audit, run `rally init --cwd . --report ./corrected-audit-report.json --rebind`, review the old/new source identities and exact Manifest diff, and confirm that separate preview. Rebind preserves the exact Project Toolchain and all prior Reports and Evidence.

`rally architect` is the read-only Phase 1 whole-product decision flow. It consumes a current full Report plus confirmed Product Intent, Capability Catalog, and Capability Graph files, returns a typed Blueprint before confirmation, and then accepts independent decision responses. A completed confirmed set includes an immutable Architecture Package bundle. Use `rally architecture-package --package <bundle.json> --output <path>` to write only an explicitly selected pre-Init output. After Init, omit `--output` to inspect the exact local-history preview, then repeat with its exact `--resume <token> --confirm confirm` to append the digest-bound package transactionally. Neither command performs Provider writes, stages files, commits files, or turns the Manifest into reasoning history.

`rally handoff` is the typed external Executor coordination flow for the current Task Graph frontier. It accepts exact reviewed Executor Descriptors and observed tool versions, groups compatible Tasks by their real authority boundary, and creates an unapproved Handoff Package for one selected batch. Only `--confirm confirm` approves that exact package; the CLI still performs no installation, login, credential collection, Provider write, deployment, or external execution. A supplied normalized Execution Receipt remains an unverified claim and routes to fresh Verify.

Exact-version npm-exec remains a no-install trial and CI fallback. Keep its full prefix on every follow-up; see the [Quickstart](https://github.com/codeacme17/launchrally/blob/main/docs/getting-started/quickstart.md) for the directly executable sequence.

## Compatibility and boundaries

The CLI requires Node.js 20.12.0 or newer and is verified on Node.js 20, 22, and 24. A supported Launcher follows a valid project Engine through versioned Execution Authority and never silently falls back when project authority is unavailable or invalid.

LaunchRally requires no account or default telemetry. CLI installation grants no Provider, deployment, production, credential, or application-source write authority. Reports and Evidence remain local. Codex and Claude Plugin installation is separate from this package.

When an approved read cannot find its official Provider executable, the Report preserves the Unverified Gap and adds `launchrally.dev/provider-tool-recovery/v1`. `rally providers --report <path> --recover <provider> --json` exposes the default-safe choices; `--choice show_install_instructions` reveals only reviewed exact-version user-managed instructions for the active platform and shell. LaunchRally never executes installation or login. Successful version rediscovery requires a new Audit or Verify Provider-read decision before collection.

## Documentation

- [Install, lifecycle, and troubleshooting](https://github.com/codeacme17/launchrally/blob/main/docs/getting-started/install.md)
- [Quickstart](https://github.com/codeacme17/launchrally/blob/main/docs/getting-started/quickstart.md)
- [Privacy boundary](https://github.com/codeacme17/launchrally/blob/main/docs/concepts/privacy.md)
- [Project data model](https://github.com/codeacme17/launchrally/blob/main/docs/concepts/data-model.md)

## Project

[Repository](https://github.com/codeacme17/launchrally) · [Issues](https://github.com/codeacme17/launchrally/issues) · [Security](https://github.com/codeacme17/launchrally/security/policy)

Licensed under [Apache-2.0](https://github.com/codeacme17/launchrally/blob/main/LICENSE).
