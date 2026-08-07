# Permission and privacy boundaries

LaunchRally is local-first. P0 requires no LaunchRally account, no default telemetry, no mandatory Report upload, no user-level analytics, and no LaunchRally private service.

## Local reads

The Local Safe Scan reads supported source and configuration metadata inside the selected repository boundary. It respects ignore rules, rejects binary and oversized inputs, does not follow symlinks, and stops at nested repositories. Environment files contribute variable names only; package manifests contribute script names rather than commands. Secret values and raw file contents are not retained in facts, Evidence, Reports, terminal output, or errors.

## Network and Provider reads

Public verification and every Provider Adapter are separate permission boundaries. LaunchRally shows the target, method or executable, exact arguments, and retained fields before access. Denial completes with a reasoned Verification Gap. P0 never installs a Provider CLI, initiates login, accepts credentials, or performs Provider, deployment, or production writes.

## Local writes

Audit and Plan are read-only. Optional Init and Provider-intent selection display exact local changes and require separate confirmation. LaunchRally never stages or commits files. Verify creates new immutable result data and never silently updates intent.

## Telemetry-Free Validation

LaunchRally does not send usage events, repository identities, Reports, Evidence, or analytics to the project. Phase 0 learning uses voluntary GitHub feedback and aggregate public ecosystem signals recorded in the [Phase 0 Validation Log](phase-0-validation.md). Participation is optional and product use does not depend on it.
