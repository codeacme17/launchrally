# Manifest, Report, and Evidence

LaunchRally keeps declared intent, conclusions, and supporting observations separate so that missing or stale Evidence cannot silently become a passing Check.

## Launch Manifest

`.launchrally/manifest.yaml` is the canonical deterministic project-owned Manifest v2 created only through the separately previewed and confirmed `rally init` flow. Its Project, Release, Execution, Support, and Providers sections use uniform declared, unknown, or evidenced not-applicable states. Not-applicable intent always includes a reason and the source Report field that establishes it. A later Provider selection changes only the exact previewed intent. The Manifest is not Machine Evidence and cannot make a Check pass.

A valid legacy `.launchrally/launch-manifest.json` Manifest v1 is readable only for migration. Init previews the canonical YAML creation and legacy JSON deletion together, then applies neither without confirmation. Invalid, ambiguous, symlinked, or unsupported inputs fail closed.

Manifest and Report v2 retain `production_targets` as a compatibility field. Its values are the confirmed public targets for `intended_environment`; the field name does not independently assert that the reviewed environment is production.

## Isolated toolchain

`.launchrally/toolchain/package.json` and `package-lock.json` are the committed execution dependency boundary for every ecosystem. They contain the exact `@launchrally/cli` version and are previewed and recovered with the other Init-owned files. LaunchRally never adds itself to an application manifest or application lockfile. Toolchain resolution tries npm's offline cache first; only an explicit `npm_registry_read` decision permits the disclosed read from `https://registry.npmjs.org`, and lifecycle scripts remain disabled.

## Report Record

Every completed full Audit or Verify produces a new immutable, time-stamped Report v2 Record bound to Check Catalog v2 and its eight Launch Risk Domains. The Record captures confirmed scope, permission decisions, execution disclosure, Check results, Verification Gaps, policy output, provenance references, limitations, and any current whole-release Assessment. A Markdown Report View is derived only from that Record; it is not a second source of truth. Historical Report v1 packages remain readable but are never emitted by a new run.

Each confirmed Failed Finding contributes one structured Action Queue item with its ordering inputs, safe supporting Evidence references, a concrete normalized observation or Check-result summary, and a deterministic targeted Verify selection for that Check. Public observations use a narrower field allowlist. The derived Markdown View renders those same fields. Historical Report v2 actions without the additive detail fields retain their legacy rendering and remain readable. This concise Audit action does not replace `rally plan`, which remains the deeper investigation and remediation model. Unverified Checks remain Verification Gaps and never enter the confirmed-failure Action Queue.

A targeted Verify result covers only selected Checks and never carries a whole-release Assessment. Init, Plan, and Provider guidance re-evaluate Report currentness at read time from the clock, explicit Manifest digest and intent, the complete repository digest set, Check Catalog and support/Profile/Adapter/scan-policy versions, and Not Applicable evidence. A stale or content-invalidated Report is non-current and carries no current Assessment. Full Verify may accept a structurally valid non-current Report as immutable history so it can recollect Evidence into a new Report.

## Evidence Index

The separately versioned Evidence Index stores normalized, content-addressed Evidence entries. Report Findings reference those entries by digest and collection metadata. Every Check declares separate pass and failure Evidence Requirements. A negative local finding requires a complete target-specific scan and is stored as provenance-bearing `local_observation` Evidence; ignored, symlinked, oversized, binary, unreadable, or otherwise uncovered candidates remain Verification Gaps. Authenticated Core Journey `passed` and `failed` observations become `authenticated_journey_machine_evidence` only through the exact supported host adapter, a fresh permission window, an exact target, and the allowlisted normalized contract. Authentication denial, unavailable capability, stale collection, partial coverage, Agent statements, user assertions, and Execution Receipts never substitute for that Evidence. Content-bound Evidence is invalidated by relevant source changes; live-state Evidence is invalidated by its declared freshness policy. Denied permission, missing tooling, or insufficient observations remain explicit Verification Gaps.

Raw repository contents, environment values, credentials, and raw package-script commands are not Evidence payloads. See the [privacy guide](privacy.md) for the collection boundary.

## Composite Assurance

Phase 1 Composite Assurance is a separate versioned derivation bound to a current full Report and Evidence Index, Capability Graph, immutable Architecture Record, and Integration Contracts for one explicit environment. Each capability retains Requirement, Local Implementation, Provider Configuration, Integration Consistency, Deployment, Operational Delivery, and Downstream Outcome facets. Passing one facet cannot pass a higher facet, and Provider configuration alone cannot prove an end-to-end outcome.

The deterministic states are Unverified, Locally Evidenced, Configured but Not Deployed, Deployed but Not Operationally Verified, Operationally Verified, and Outcome Verified. Required current-release capabilities gate against capability-specific minimum assurance. Optional, deferred, future, and not-applicable capabilities do not silently gate. Incomplete or unsupported negative coverage remains Unverified, and Evidence is never generalized across environments without a future explicit versioned rule. Composite Launch Assessment and Architecture Status remain independent records.

## Immutable local history

Before Init, Audit remains output-only. Confirmed Init persists that source Audit, and every completed full Verify persists its new Report package, beneath the explicit current repository's `.launchrally/` directory. Reports use time-sortable IDs and are committed as complete bundle directories containing canonical `record.json`, its `record.sha256`, the derived `view.md`, and `evidence-index.json`. Normalized safe artifacts are independently stored at `.launchrally/evidence/sha256/<digest>.json`; identical addresses are reused and differing content is treated as tampering or a collision.

Report bundles and their temporary Evidence links are staged under `.launchrally/transactions/` and become visible with one directory commit. A token-owned single-writer lock serializes Evidence publication, Report commit, and recovery. A failed or interrupted write therefore cannot expose a half-written Report or leave newly published Evidence without a recoverable transaction. Validated abandoned transactions are recovered across Report IDs, active writers stop recovery, and invalid transaction names, ownership, or contents fail closed. Recovery never removes Evidence referenced by any visible Report.

`.launchrally/cache/current-report.json` is a best-effort replaceable convenience pointer written only by full Verify, never the history authority. Init does not write it, so it is absent from Init's exact preview and `changes_applied`; a Verify cache failure after an immutable Report commit cannot turn that commit into a false failure. Reports and Evidence are immutable and are never automatically pruned.
