# @launchrally/claude-plugin

This package installs Claude Code Plugin metadata plus a generated copy of the LaunchRally Agent Skill. The Skill guides Claude through the deterministic CLI's Audit → Init → Plan/Handoff → Verify journey while preserving explicit permission and write boundaries.

## Status

LaunchRally 0.3.0 is an **Experimental P0** release. It is Product Complete at P0, but it is not presented as stable or P0 Validated.

## CLI prerequisite

CLI installation and Plugin installation are separate. Before installing this Plugin, follow the [single CLI installation authority](https://github.com/codeacme17/launchrally/blob/main/docs/getting-started/install.md) and require `rally --version --json --cwd .` to return a supported Launcher and Execution Authority. The Plugin never installs, updates, downgrades, restores, migrates, or removes the Launcher or project toolchain silently.

## Plugin installation and use

The `0.3.0` marketplace catalog pins `@launchrally/claude-plugin@0.3.0`. Add it and install at explicit user scope:

```sh
claude plugin marketplace add codeacme17/launchrally --scope user
claude plugin install launchrally@launchrally --scope user
claude plugin list --json
```

The JSON list must contain the installed and enabled `launchrally@launchrally` Plugin. Then ask: `Use LaunchRally to audit this repository for launch readiness. Show the complete scope and every permission before continuing.` The Skill begins by running `rally --version --json --cwd .`; it accepts only a supported Plugin, Launcher, selected Engine, project pin, and contract combination before following the project-pinned Engine through `rally`.

## Update or remove

Refresh the exact catalog and deliberately update the Plugin:

```sh
claude plugin marketplace update launchrally
claude plugin update launchrally@launchrally --scope user
```

To remove the Plugin and marketplace entry:

```sh
claude plugin uninstall launchrally@launchrally --scope user
claude plugin marketplace remove launchrally
```

Plugin removal preserves project-owned `.launchrally` data, the Project Toolchain, Manifest, Reports, Evidence, immutable history, and the separately installed Launcher.

## Compatibility and canonical source

This adapter targets Claude Code installations that support Plugins and third-party marketplaces. Its CLI workflow requires Node.js 20.12.0 or newer. The bundled Skill is generated from the [canonical Agent Skill](https://github.com/codeacme17/launchrally/blob/main/skills/launchrally/SKILL.md); host discovery metadata never changes LaunchRally semantics.

## Documentation and project

[Quickstart](https://github.com/codeacme17/launchrally/blob/main/docs/getting-started/quickstart.md) · [Privacy and permissions](https://github.com/codeacme17/launchrally/blob/main/docs/concepts/privacy.md) · [Repository](https://github.com/codeacme17/launchrally) · [Issues](https://github.com/codeacme17/launchrally/issues) · [Security](https://github.com/codeacme17/launchrally/security/policy)

Licensed under [Apache-2.0](https://github.com/codeacme17/launchrally/blob/main/LICENSE).
