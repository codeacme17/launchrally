# Permission and privacy boundaries

LaunchRally is local-first. P0 requires no LaunchRally account, no default telemetry, no mandatory Report upload, no user-level analytics, and no LaunchRally private service.

## Local reads

The Local Safe Scan reads supported source and configuration metadata inside the selected repository boundary. It respects ignore rules, rejects binary and oversized inputs, does not follow symlinks, and stops at nested repositories. Environment files contribute variable names only; package manifests contribute script names rather than commands. Secret values and raw file contents are not retained in facts, Evidence, Reports, terminal output, or errors.

## Network and Provider reads

Public verification and every Provider Adapter are separate permission boundaries. LaunchRally shows the target, method or executable, exact arguments, and retained fields before access. Denial completes with a reasoned Verification Gap. P0 never installs a Provider CLI, initiates login, accepts credentials, or performs Provider, deployment, or production writes.

Audit actions cite only allowlisted Evidence provenance and normalized failed-observation fields: probe identity, method, safe path, outcome, and status code when present. Response bodies, secret-bearing headers, credentials, raw Provider output, and unallowlisted Evidence fields cannot enter the Action Queue or its derived Markdown View. An HTTP status is reported as an observation, never converted into a guessed internal root cause.

## Local writes

Audit and Plan are read-only. Before Init, Audit is output-only. Optional Init and Provider-intent selection display exact local changes and require separate confirmation. Confirmed Init and completed full Verify keep canonical Reports, derived Views, Evidence Indexes, and structurally allowlisted normalized Evidence only in the explicit current repository's ignored `.launchrally/` local-history boundaries. Persisted Views are rederived from Records, and unreferenced or non-allowlisted Evidence is rejected. LaunchRally never stages or commits files through Git. Verify creates new immutable result data and never silently updates intent; local history is never automatically uploaded or pruned.

## Telemetry-Free Validation

LaunchRally does not send usage events, repository identities, Reports, Evidence, or analytics to the project. Phase 0 learning uses voluntary GitHub feedback and aggregate public ecosystem signals recorded in the [Phase 0 Validation Log](../maintainers/phase-0-validation.md). Participation is optional and product use does not depend on it.

Initialization resolves its isolated `.launchrally/toolchain` from the local npm cache first. A cache miss does not contact npm automatically: the CLI discloses the exact package, version, `https://registry.npmjs.org` source, and lifecycle-script-disabled command and requires a separate `npm_registry_read` decision. Denial writes nothing and no application dependency file is read for toolchain planning or changed.
