# Manifest, Report, and Evidence

LaunchRally keeps declared intent, conclusions, and supporting observations separate so that missing or stale Evidence cannot silently become a passing Check.

## Launch Manifest

`.launchrally/manifest.yaml` is the canonical deterministic project-owned Manifest v2 created only through the separately previewed and confirmed `rally init` flow. Its Project, Release, Execution, Support, and Providers sections use uniform declared, unknown, or evidenced not-applicable states. Not-applicable intent always includes a reason and the source Report field that establishes it. A later Provider selection changes only the exact previewed intent. The Manifest is not Machine Evidence and cannot make a Check pass.

A valid legacy `.launchrally/launch-manifest.json` Manifest v1 is readable only for migration. Init previews the canonical YAML creation and legacy JSON deletion together, then applies neither without confirmation. Invalid, ambiguous, symlinked, or unsupported inputs fail closed.

## Report Record

Every completed full Audit or Verify produces a new immutable, time-stamped Report v2 Record bound to Check Catalog v2 and its eight Launch Risk Domains. The Record captures confirmed scope, permission decisions, execution disclosure, Check results, Verification Gaps, policy output, provenance references, limitations, and any current whole-release Assessment. A Markdown Report View is derived only from that Record; it is not a second source of truth. Historical Report v1 packages remain readable but are never emitted by a new run.

A targeted Verify result covers only selected Checks and never carries a whole-release Assessment. Init, Plan, and Provider guidance re-evaluate Report currentness at read time from the clock, explicit Manifest digest and intent, the complete repository digest set, Check Catalog and support/Profile/Adapter/scan-policy versions, and Not Applicable evidence. A stale or content-invalidated Report is non-current and carries no current Assessment. Full Verify may accept a structurally valid non-current Report as immutable history so it can recollect Evidence into a new Report.

## Evidence Index

The separately versioned Evidence Index stores normalized, content-addressed Evidence entries. Report Findings reference those entries by digest and collection metadata. Every Check declares separate pass and failure Evidence Requirements. A negative local finding requires a complete target-specific scan and is stored as provenance-bearing `local_observation` Evidence; ignored, symlinked, oversized, binary, unreadable, or otherwise uncovered candidates remain Verification Gaps. Content-bound Evidence is invalidated by relevant source changes; live-state Evidence is invalidated by its declared freshness policy. Denied permission, missing tooling, or insufficient observations remain explicit Verification Gaps.

Raw repository contents, environment values, credentials, and raw package-script commands are not Evidence payloads. See the [privacy guide](privacy.md) for the collection boundary.
