# Changelog

## 0.4.2 — Phase 1 Experimental

LaunchRally 0.4.2 is a corrective Experimental Phase 1 release that strengthens
Architecture decisions, intent classification, contract validation, and
telemetry-free validation while preserving the separately supported Phase 0
Stable 0.3.2 line on npm `latest`.

### Improved

- Completed and clarified the Architect Human Mode decision flow, including
  readable Architecture Package previews and local-history resume behavior.
- Preserved source Report currentness after Architecture history is persisted.
- Avoided treating push-notification subscriptions as purchase intent and
  aligned Integration Contract idempotency validation with compatibility
  checks.
- Disclosed the public collector version in Audit permission previews.
- Added an append-only, privacy-checked, telemetry-free Phase 1 validation log.

### Release boundary

- 0.4.2 publishes only on npm `experimental` and as a GitHub prerelease.
- Exact 0.4.2 external CLI, Codex, and Claude verification remains a separate
  post-publication gate; publication does not make Phase 1 Validated or Stable.
- Phase 0 Stable 0.3.2 remains on npm `latest`.

See [the Phase 1 migration notes](docs/maintainers/p1-migration-notes.md) for
adoption, retained-data, and recovery details.

## 0.4.1 — Phase 1 Experimental

LaunchRally 0.4.1 is a corrective Experimental Phase 1 release that improves
the complete Human Mode workflow while preserving the separately supported
Phase 0 Stable 0.3.2 line on npm `latest`.

### Improved

- Reduced public-route classification fatigue and preserved protected-journey
  safety when public verification is skipped.
- Made Human Init previews easier to review and completion output directly
  actionable across POSIX and PowerShell.
- Completed Human Audit and Human Verify interaction loops, including
  authenticated journeys and Plan-compatible Verify handoff data.
- Preserved report identity and currentness when rebinding a manifest to an
  updated source Report.

### Release boundary

- 0.4.1 publishes only on npm `experimental` and as a GitHub prerelease.
- Exact 0.4.1 external CLI, Codex, and Claude verification remains a separate
  post-publication gate; publication does not make Phase 1 Validated or Stable.
- Phase 0 Stable 0.3.2 remains on npm `latest`.

See [the Phase 1 migration notes](docs/maintainers/p1-migration-notes.md) for
adoption, retained-data, and recovery details.

## 0.4.0 — Phase 1 Experimental

LaunchRally 0.4.0 adds the Experimental Phase 1 Launch Doctor and
Infrastructure Decision Layer while preserving the separately supported Phase
0 Stable 0.3.2 line on npm `latest`.

### Added

- Product Intent discovery with explicit semantic-read permission and
  no-product-material support.
- Provider-neutral Capability Graphs, Integration Contracts, Architecture
  decisions, immutable Architecture Packages, and Task Graphs.
- Reviewed Provider Knowledge, transparent support depth, bounded Executor
  Handoff Packages, claim-only receipts, and fresh verification.
- Environment-bound composite assurance, privacy-safe active verification,
  authenticated Journey Evidence, and cross-host Architecture/Handoff resume.
- Provider-neutral reference packs, complete Agent/Human documentation, and
  exact Phase 1 artifact, platform, migration, and Quality Floor gates.

### Release boundary

- 0.4.0 is published only on npm `experimental` and as a GitHub prerelease.
- Phase 1 is Product Complete only after the external verification record is
  reviewed; publication does not make Phase 1 Validated or Stable.
- Phase 0 Stable 0.3.2 remains on npm `latest`.

See [the Phase 1 migration notes](docs/maintainers/p1-migration-notes.md) for
adoption, retained-data, and recovery details.
