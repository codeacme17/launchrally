# @launchrally/claude-plugin

This package installs Claude Code Plugin metadata plus a generated copy of the LaunchRally Agent Skill. The Skill guides Claude through the deterministic CLI's Audit → Init → Plan/Handoff → Verify journey while preserving explicit permission and write boundaries.

The optional `@launchrally/claude-plugin/authenticated-journey` host runner uses only absolute references to host-owned, owner-restricted authentication files and submits normalized results directly to Core. On supported POSIX hosts, it rejects plaintext HTTP, invalid TLS peers, symbolic links, files owned by another user, group/world-readable files, and oversized values. Other hosts return a typed `runner_unavailable` Gap. It never accepts credentials as arguments or returns credentials or raw authenticated responses to the Agent.

The `@launchrally/claude-plugin/product-intent` export provides the typed Product Intent discovery bridge, including the no-PRD path and fresh permission before selected product-material reads.

The optional `@launchrally/claude-plugin/resume` host adapter atomically saves validated local Architecture or Handoff resume artifacts and can resume artifacts created by the Codex adapter. It uses the durable owner-restricted `~/.launchrally/host-resume-v1/` registry for its key and encrypted resumable state, without writing project state or a key beside the selected artifact. Resume files bind the exact opaque interaction state and are never reconstructed from prose. The registry persists after Plugin/Launcher removal so retained artifacts remain usable; deleting it removes pending state and invalidates all retained resume artifacts.

## Status

LaunchRally 0.4.0 is an **Experimental Phase 1** release. It adds the Phase 1 Skill and host bridges while Phase 0 Stable 0.3.2 remains on npm `latest`. Publication does not make Phase 1 Validated or Stable.

Phase 0 0.3.2 remains a **Stable** release. It is Product Complete, P0 Validated, and published on the stable channel.

## CLI prerequisite

CLI installation and Plugin installation are separate. Before installing this Plugin, follow the [single CLI installation authority](https://github.com/codeacme17/launchrally/blob/main/docs/getting-started/install.md) and require `rally --version --json --cwd .` to return a supported Launcher and Execution Authority. The Plugin never installs, updates, downgrades, restores, migrates, or removes the Launcher or project toolchain silently.

## Plugin installation and use

The `0.4.0` marketplace catalog pins `@launchrally/claude-plugin@0.4.0`. Add it and install at explicit user scope:

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
