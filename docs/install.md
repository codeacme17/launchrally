# Install and release guide

LaunchRally `0.1.0` is one release across the CLI, canonical Skill, Codex Plugin, and Claude Plugin. Package and Plugin metadata, the bundled Skill contract, native marketplace manifests, and internal dependencies are validated against that SemVer before publication.

## First Audit without installation

Run the exact public CLI version without a global install:

```bash
npm exec --package=@launchrally/cli@0.1.0 -- rally audit --json --cwd .
```

If npm needs to download the package, review its normal confirmation. Do not bypass that prompt. The first Audit does not modify the project. Optional project adoption happens later through the separately confirmed `rally init` preview, which records `@launchrally/cli` as an exact devDependency and updates the detected committed lockfile.

## Codex Plugin

Codex installs Plugins at user scope. Pin the marketplace checkout to the exact release tag, then install LaunchRally:

```bash
codex plugin marketplace add codeacme17/launchrally --ref v0.1.0
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

Publishing is performed only by the repository's release workflow on a matching `v0.1.0` tag. npm Trusted Publishing supplies short-lived OIDC credentials and provenance; no long-lived npm token is used.
