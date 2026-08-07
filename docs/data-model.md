# Manifest, Report, and Evidence

LaunchRally keeps declared intent, conclusions, and supporting observations separate so that missing or stale Evidence cannot silently become a passing Check.

## Launch Manifest

`.launchrally/launch-manifest.json` is project-owned intent created only through the separately previewed and confirmed `rally init` flow. It records release, execution, support, and Provider-role intent as declared, unknown, or reasoned not-applicable states. A later Provider selection changes only the exact previewed intent. The Manifest is not Machine Evidence and cannot make a Check pass.

## Report Record

Every completed full Audit or Verify produces a new immutable, time-stamped Report Record. The Record captures confirmed scope, permission decisions, execution disclosure, Check results, Verification Gaps, policy output, provenance references, limitations, and any current whole-release Assessment. A Markdown Report View is derived only from that Record; it is not a second source of truth.

A targeted Verify result covers only selected Checks and never carries a whole-release Assessment. A stale or content-invalidated Report is non-current and carries no current Assessment.

## Evidence Index

The separately versioned Evidence Index stores normalized, content-addressed Evidence entries. Report Findings reference those entries by digest and collection metadata. Content-bound Evidence is invalidated by relevant source changes; live-state Evidence is invalidated by its declared freshness policy. Denied permission, missing tooling, or insufficient observations remain explicit Verification Gaps.

Raw repository contents, environment values, credentials, and raw package-script commands are not Evidence payloads. See the [privacy guide](privacy.md) for the collection boundary.
