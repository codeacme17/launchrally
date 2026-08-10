# @launchrally/codex-plugin

This package is the LaunchRally Plugin adapter for Codex. It installs Codex Plugin metadata plus a generated copy of the LaunchRally Agent Skill, which guides Codex through the deterministic CLI's Audit → Plan/Remediate → Verify workflow while preserving explicit permission and write boundaries.

## Status

LaunchRally 0.2.1 is an **Experimental P0** release. It is Product Complete at P0, but it is not presented as stable or P0 Validated. Review every permission request and proposed local change.

## Install and use

Codex installs Plugins at user scope. Pin the marketplace to this release tag, then install LaunchRally:

```sh
codex plugin marketplace add codeacme17/launchrally --ref v0.2.1
codex plugin add launchrally@launchrally
```

In Codex, ask: `Audit this repository for production launch readiness.` The Skill will use the exact versioned CLI path and stop for required user input or permission decisions.

## Update or remove

For a deliberate update, remove the installed Plugin and marketplace, then add the new exact `vX.Y.Z` release tag:

```sh
codex plugin remove launchrally@launchrally
codex plugin marketplace remove launchrally
codex plugin marketplace add codeacme17/launchrally --ref vX.Y.Z
codex plugin add launchrally@launchrally
```

To uninstall, run only the first two removal commands.

## Compatibility and canonical source

This adapter targets Codex installations that support Plugins and Plugin marketplaces. Its CLI workflow requires Node.js 20.12.0 or newer. The bundled Skill is generated from the [canonical Agent Skill](https://github.com/codeacme17/launchrally/blob/main/skills/launchrally/SKILL.md); the adapter changes host discovery metadata, not LaunchRally semantics. See the [install guide](https://github.com/codeacme17/launchrally/blob/main/docs/getting-started/install.md) for current verification and lifecycle guidance.

## Documentation and project

[Quickstart](https://github.com/codeacme17/launchrally/blob/main/docs/getting-started/quickstart.md) · [Privacy and permissions](https://github.com/codeacme17/launchrally/blob/main/docs/concepts/privacy.md) · [Repository](https://github.com/codeacme17/launchrally) · [Issues](https://github.com/codeacme17/launchrally/issues) · [Security](https://github.com/codeacme17/launchrally/security/policy)

Licensed under [Apache-2.0](https://github.com/codeacme17/launchrally/blob/main/LICENSE).
