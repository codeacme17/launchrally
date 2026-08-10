# Install and release guide

LaunchRally CLI requires Node.js 20.12.0 or newer.

LaunchRally `0.1.1` is the public Experimental P0 release across the CLI, canonical Skill, Codex Plugin, and Claude Plugin. Package and Plugin metadata, the bundled Skill contract, native marketplace manifests, and internal dependencies are validated against that exact SemVer. Experimental availability is not a stability claim or a P0 Validated decision.

## Exact-version Audit

Run the exact public CLI version without a global install. Node.js 20.12.0 is the minimum supported CLI runtime and is verified directly alongside Node.js 22 and 24:

```bash
npm exec --package=@launchrally/cli@0.1.1 -- rally audit --json --cwd .
```

If npm needs to download the package, review its normal confirmation. Do not bypass that prompt. The first Audit does not modify the project. Optional project adoption happens later through `rally init`, which pins `@launchrally/cli` in the committed `.launchrally/toolchain/package.json` and npm lockfile without changing application dependencies. Init tries npm's offline cache first. A cache miss produces a typed permission request that discloses the exact package, version, registry source, and lifecycle-script-disabled command before any registry read; the file preview and confirmation follow only after resolution succeeds.

For an interactive TTY wizard, omit `--json`. Add `--plain` for numbered choices and `[y/N]` confirmations. Human Mode writes prompts to stderr, prints a concise assessment to stdout, and writes full Report JSON only after `--output <path>` or an explicit save confirmation. After confirmation, accept the disclosed `<cwd>/launchrally-audit-report.json` suggestion with one selection, enter a custom path, or use the optional native system file picker when a supported local GUI is available. LaunchRally validates custom destinations, shows the exact resolved destination before writing, rejects `.launchrally/**`, and requires a separate decision before overwriting an existing file. Non-TTY automation must keep `--json`.

## Codex Plugin

Codex installs Plugins at user scope. Pin the marketplace checkout to the exact release tag, then install LaunchRally:

```bash
codex plugin marketplace add codeacme17/launchrally --ref v0.1.1
codex plugin add launchrally@launchrally
```

To update deliberately, remove the installed Plugin and pinned marketplace, then add the exact new release tag in place of `vX.Y.Z`:

```bash
codex plugin remove launchrally@launchrally
codex plugin marketplace remove launchrally
codex plugin marketplace add codeacme17/launchrally --ref vX.Y.Z
codex plugin add launchrally@launchrally
```

To uninstall the Plugin and its catalog entry:

```bash
codex plugin remove launchrally@launchrally
codex plugin marketplace remove launchrally
```

## Claude Plugin

The Claude marketplace resolves `@launchrally/claude-plugin` through an exact npm version. Add the marketplace and install at explicit user scope:

```bash
claude plugin marketplace add codeacme17/launchrally --scope user
claude plugin install launchrally@launchrally --scope user
```

Third-party marketplace auto-update is not required. To update deliberately after a new release, refresh the catalog and ask Claude to install its newly pinned package version:

```bash
claude plugin marketplace update launchrally
claude plugin update launchrally@launchrally --scope user
```

To uninstall from user scope:

```bash
claude plugin uninstall launchrally@launchrally --scope user
claude plugin marketplace remove launchrally
```

After Plugin removal, project-owned .launchrally data remains with the repository until its owner removes it.

## Verifying a source release

From a release checkout with Node.js 22 or newer:

```bash
npm ci
npm run build
npm run validate:release
npm run test:artifacts
npm test
```

Release validation rejects version drift, dependency ranges, lifecycle install hooks, stale Skill copies, and unexpected tarball files. Artifact testing packs all public workspaces, installs them together with scripts disabled in a clean offline project, smoke-tests the CLI, runs Claude's strict Plugin validator, and exercises Codex marketplace install and removal in an isolated user scope.

Publishing is performed only by the repository's release workflow on a matching `v0.1.1` tag. npm Trusted Publishing supplies short-lived OIDC credentials and provenance; no long-lived npm token is used.

Maintainers use the [Experimental release runbook](../maintainers/release-runbook.md) for the external control checks, protected promotion and tag, public smoke evidence, and partial-publication recovery.
