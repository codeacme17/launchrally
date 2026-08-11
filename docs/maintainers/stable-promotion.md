# Stable promotion runbook

Stable promotion is a reviewed release transition, not a consequence of CI
passing, elapsed time, download counts, or P0 validation alone. P0 Validated
makes a release eligible; an explicit promotion approval authorizes the Stable
channel.

## State transition

The committed transition is:

```text
Experimental + collecting/not validated
  -> P0 Validated + Quality Floor satisfied
  -> maintainer E2E complete
  -> Stable promotion approved for one exact tag
  -> protected Stable workflow approved
  -> npm latest verified
  -> GitHub regular Latest Release created
```

Set `release_status` to `stable` only in the reviewed promotion commit. The same
commit must set `validation_status` to `validated`, `p0_validated` to `true`,
keep `quality_floor_status` satisfied, record completed maintainer E2E, approve
one exact tag in `stable_promotion`, update `release/p0-acceptance.json`, and
replace Experimental status language in every public document and package
README. The approved tag must equal `v` plus the coherent workspace version.

## New coherent version policy

Stable promotion publishes a new coherent version rather than moving `latest`
to an existing Experimental version. [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
currently supports `npm publish` and `npm stage publish`, but it does not
authorize `npm dist-tag add`. Reusing an existing version would therefore
require a traditional write token and would weaken the release boundary.

All five package versions, internal dependency pins, Plugin manifests,
marketplaces, bundled Skills, documentation commands, the approved tag, and the
root version must advance together. Historical Experimental GitHub releases
remain prereleases and their npm versions remain available under explicit
version references.

## Approval and execution

1. Append the reviewed qualitative P0 Validated entry while the Quality Floor
   remains satisfied.
2. Complete and record the direct CLI, Codex Plugin, and Claude Plugin
   maintainer E2E journeys, including approved and denied permission paths.
3. Merge the coherent Stable promotion commit from `dev` to `main`.
4. Run the full release validation commands from `CONTRIBUTING.md`.
5. Create and push a protected annotated tag on the exact `main` commit.
6. Dispatch `.github/workflows/release.yml` for that exact tag and approve the
   protected `npm` environment deployment.

The workflow reruns the complete repository and artifact gates, validates
`--require-stable-ready`, publishes the five new versions with OIDC provenance
under `latest`, runs the exact public CLI and Plugin smoke journeys against
`latest`, and only then creates a regular GitHub Release marked Latest. It uses
no `NPM_TOKEN` or other long-lived registry credential.

## Failure and retry

Before publication, any failure leaves public state unchanged and the same tag
may be retried after the cause is fixed without weakening a gate.

If none of the five versions exists, the workflow starts publication. If all
five exact versions already exist, a retry skips publication and resumes public
smoke and GitHub Release creation. If only a subset exists, stop: npm versions
are immutable, so the incomplete version must not be reused. Record the partial publication,
choose a new coherent version, repeat review and tagging, and use
npm package administration with interactive 2FA to restore the previous
coherent `latest` set before retrying. Never add a registry token to CI and
never move tags from an unattended workstation.

If all packages publish but public smoke fails, keep the GitHub release absent,
fix the defect in a new coherent version when artifact behavior is wrong, or
rerun the same tag only when the failure was an external propagation or tooling
failure and all exact public artifacts remain verified. If GitHub Release
creation alone fails, rerun after confirming all five `latest` tags and public
smoke results.

## Post-promotion Quality Floor regression

A later Quality Floor regression suspends the P0 completion and validation
claims and blocks further authority expansion, but it does not rewrite or
delete historical releases. Publish a corrected coherent version through the
reviewed release process. Use npm/GitHub administrative rollback only for an
active security or integrity incident, record the exact intervention, preserve
the immutable affected version, and restore a coherent five-package channel.
