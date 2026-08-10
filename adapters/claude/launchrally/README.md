# @launchrally/claude-plugin

This package is the LaunchRally Plugin adapter for Claude Code. It installs Claude Plugin metadata plus a generated copy of the LaunchRally Agent Skill, which guides Claude through the deterministic CLI's Audit → Plan/Remediate → Verify workflow while preserving explicit permission and write boundaries.

## Status

LaunchRally 0.2.1 is an **Experimental P0** release. It is Product Complete at P0, but it is not presented as stable or P0 Validated. Review every permission request and proposed local change.

## Install and use

Add the marketplace and install LaunchRally at explicit user scope:

```sh
claude plugin marketplace add codeacme17/launchrally --scope user
claude plugin install launchrally@launchrally --scope user
```

In Claude Code, ask: `Audit this repository for production launch readiness.` The Skill will use the exact versioned CLI path and stop for required user input or permission decisions.

## Update or remove

After a new release, refresh the marketplace catalog and deliberately update the Plugin:

```sh
claude plugin marketplace update launchrally
claude plugin update launchrally@launchrally --scope user
```

To uninstall it and remove the marketplace:

```sh
claude plugin uninstall launchrally@launchrally --scope user
claude plugin marketplace remove launchrally
```

## Compatibility and canonical source

This adapter targets Claude Code installations that support Plugins and third-party marketplaces. Its CLI workflow requires Node.js 20.12.0 or newer. The bundled Skill is generated from the [canonical Agent Skill](https://github.com/codeacme17/launchrally/blob/main/skills/launchrally/SKILL.md); the adapter changes host discovery metadata, not LaunchRally semantics. See the [install guide](https://github.com/codeacme17/launchrally/blob/main/docs/getting-started/install.md) for current verification and lifecycle guidance.

## Documentation and project

[Quickstart](https://github.com/codeacme17/launchrally/blob/main/docs/getting-started/quickstart.md) · [Privacy and permissions](https://github.com/codeacme17/launchrally/blob/main/docs/concepts/privacy.md) · [Repository](https://github.com/codeacme17/launchrally) · [Issues](https://github.com/codeacme17/launchrally/issues) · [Security](https://github.com/codeacme17/launchrally/security/policy)

Licensed under [Apache-2.0](https://github.com/codeacme17/launchrally/blob/main/LICENSE).
