# Experimental release runbook

This runbook is the human-owned control plane for a public
Experimental release. The tagged GitHub Actions workflow is the only approved
publisher. Do not publish from a workstation, add an npm token to GitHub, or
create the GitHub prerelease manually ahead of public smoke.

## 1. Verify external control

The release owner must verify all of these controls before promotion or tag
creation:

- npm identity and write access to the `@launchrally` scope;
- control of all five exact names: `@launchrally/contracts`,
  `@launchrally/core`, `@launchrally/cli`, `@launchrally/codex-plugin`, and
  `@launchrally/claude-plugin`;
- a GitHub environment `npm` restricted to the selected tag pattern
  `v*.*.*`, with its required deployment approval applied before publishing;
- an active GitHub tag ruleset protecting the same release-tag pattern; and
- one npm Trusted Publisher registration for each package.

For every package, `npm trust list <package> --json` must show the GitHub
publisher `codeacme17/launchrally`, workflow file `release.yml`, environment
`npm`, and allowed action `npm publish`. Record the five successful checks in
the release evidence before creating a tag. npm does not validate this
configuration when it is saved, so field names and case must be checked
exactly.

npm requires that a package must already exist before `npm trust` can create a
Trusted Publisher. For a new namespace, stop here until an authenticated scope
owner completes a separately reviewed bootstrap that creates all five names
without consuming the approved Release Candidate version. Configure and verify
all five Trusted Publishers immediately after bootstrap. Bootstrap is not an
Experimental release and must not create the release tag or GitHub prerelease.

## 2. Promote one approved commit

Merge the approved `dev` Release Candidate into `main` through the repository's
promotion pull request. Wait for every required matrix and quality-floor check.
Record the resulting `main` commit SHA and confirm that the workspace is still
one coherent version with:

```bash
npm ci --ignore-scripts
npm run build
git diff --exit-code
npm test
npm run validate:acceptance
npm run validate:p0
npm run validate:p1 -- --require-publish-ready
npm run validate:release
npm run test:p1-exact-artifacts
node scripts/verify-experimental-release.mjs --phase candidate --json
```

The P1 exact-artifact result must name all five Product journeys, all eight
Integration families and their digest-bound fresh-Verify outcomes, both typed
Host journeys and their native validation/installation commands, successful
plus interrupted P0-to-P1 adoption, the authority/interruption scenario roster,
and the environment-bound downstream outcomes. CI and the
release workflow pass an exact matrix target to the artifact runner; a target
that does not match the actual OS, Node major, and shell fails before packing.
This gate does not satisfy the separate public external-verification gate.

Create a protected annotated tag on that exact `main` commit and push only the
tag:

```bash
git tag --annotate v0.4.0 <approved-main-sha> --message "LaunchRally 0.4.0 Phase 1 Experimental"
git push origin v0.4.0
```

The release workflow independently rejects a lightweight tag, a tag whose
SemVer differs from the packages, or a tag whose commit differs from
`origin/main`.

## 3. Publish, verify, then announce

The protected workflow reruns the Node 20/22/24 contracts and the Node 22
Linux/macOS/Windows journeys. Its `npm` environment then publishes the five
packages in dependency order with OIDC provenance and the `experimental`
dist-tag. No package uses the stable `latest` channel.

After publication, a separate clean job waits for all five `experimental`
dist-tags to resolve to the exact release version, installs all five exact
versions with lifecycle scripts disabled, runs `npm audit signatures`, executes
the direct CLI journeys, strictly validates the Claude Plugin, and installs and
removes the Codex Plugin in an isolated user scope. The GitHub prerelease is
created only after this public smoke job succeeds.

npm package pages update only after new package versions are published. Confirm
that every new page shows its package-specific README and keywords during the
public smoke check; source changes alone do not update the registry pages.

Attach the successful workflow URL, five public package URLs, attestation
result, exact CLI result, and both Plugin results to issue #141. Keep Phase 1
Incomplete, Experimental, and Not Validated until those external results have
been independently reviewed and merged into the P1 evidence and governance
records. Publication never moves npm `latest`; Phase 0 Stable 0.3.2 remains
independently supported.

The workflow's public smoke proves installation and typed packaged behavior;
it does not claim model-driven Agent execution. After publication, complete
the separate [Phase 1 external verification
procedure](p1-external-verification.md) in clean Codex and Claude hosts. That
procedure is the only path to completing `p1_external_verification` and must
remain pending if either native Agent journey is unavailable or inconclusive.

## 4. Partial publication

npm versions are immutable. If any package publishes but a later package
fails, do not retry the same version and do not move its dist-tag by hand. Fix
the cause, choose a new coherent version for the root, all five packages,
internal dependencies, Plugin manifests, marketplaces, and bundled Skills,
then repeat approval, promotion, and protected-tag publication. The publisher
preflight rejects any attempt to reuse a version already visible for even one
package.
