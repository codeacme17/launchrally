# @launchrally/cli

The LaunchRally CLI provides the `rally` Launcher and deterministic Engine for auditing and verifying an existing repository while keeping the first Audit local-first, account-free, and output-only.

## Status

LaunchRally 0.3.1 is an **Experimental P0** release. P0 is Product Complete and P0 Validated, while the package remains non-stable. Review every disclosed permission and preview before continuing.

## Install and complete the first journey

Install the exact Launcher through your current user-writable npm prefix and verify it before entering a repository:

```sh
npm install --global @launchrally/cli@0.3.1
rally --version --json
```

From the repository root, save the complete Human Audit Report, separately confirm Init, and verify that the Launcher selected the project-pinned Engine:

```sh
rally audit --plain --cwd . --output ./launchrally-audit-report.json
rally init --plain --cwd . --report ./launchrally-audit-report.json
rally --version --json --cwd .
```

Audit performs no repository write and does not create `.launchrally`. Public and Provider reads are independent and default-denied. Confirmed Init is the first project mutation, stays under LaunchRally-owned `.launchrally` paths, materializes the exact Project Toolchain, and leaves application dependency files unchanged.

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
