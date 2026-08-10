# P0 acceptance contract

This is the repository-visible traceability contract for Phase 0. The detailed
product-planning sources are intentionally local and ignored under
`docs/product/`; therefore every release-blocking requirement needed by CI
must be represented here and in the linked GitHub issues.

P0 is Product Complete and `0.2.1` is publicly available as an Experimental
release. Telemetry-Free Validation is collecting directional signals and P0
Validated remains false.

The canonical requirement-ID registry is independently committed in
`release/p0.json`; the machine-readable traceability source is
`release/p0-acceptance.json`. It maps every normative row below to its
versioned contracts, implementation paths, named tests, tracking issue,
status, and mandatory release gates. CI runs
`npm run validate:acceptance` so removed requirements, renamed tests, missing
paths, stale status, and omitted safety gates fail closed. The initial tagged
publication passed `--require-publish-ready`; that transition required the
approved Release Candidate identity and every pre-publication requirement to
be Complete. Before the first publication, only publication, exact public
smoke, and later Telemetry-Free Validation requirements could remain Open.
Subsequent tagged releases pass the stricter `--require-release-ready` gate,
which requires Product Complete status and every requirement to remain
Complete.

## Status model

1. P0 Release Candidate
2. Experimental artifact publication under non-stable tags
3. Clean external installation and journey verification
4. P0 Product Complete
5. Experimental Release announcement
6. Telemetry-Free Validation
7. P0 Validated
8. P1 implementation

## Release-blocking requirements

| ID | Requirement | Executable evidence | Tracking | Status |
| --- | --- | --- | --- | --- |
| P0-CONTRACT-01 | Canonical deterministic `.launchrally/manifest.yaml` and previewed v1 migration | Contract and migration fixtures | #35 | Complete |
| P0-CONTRACT-02 | Manifest v2 contains Project, Release, Execution, Support, and Providers with uniform intent states | Schema and CLI interaction tests | #35 | Complete |
| P0-CONTRACT-03 | Check Catalog v2 uses the eight approved Launch Risk Domains | Catalog contract tests | #35 | Complete |
| P0-CONTRACT-04 | CLI Interaction Contract v2 exposes typed `needs_refresh` and advisory `providers` behavior | Direct CLI and Skill parity tests | #35 | Complete |
| P0-EVIDENCE-01 | Passed and Failed outcomes satisfy distinct Evidence Requirements | Policy invariant tests | #36 | Complete |
| P0-EVIDENCE-02 | Negative findings require complete provenance-bearing local observations | Safe-scan and insufficient-scope tests | #36 | Complete |
| P0-ASSESS-01 | Gating Unverified is Inconclusive; non-gating Unverified is Ready with Warnings | Assessment precedence fixtures | #36 | Complete |
| P0-ASSESS-02 | No-Go requires a gating failure supported by qualifying Machine Evidence | Adversarial policy fixtures | #36 | Complete |
| P0-CURRENT-01 | Currentness is reevaluated from clock, Manifest, repository, catalog, support, and applicability evidence | Clock-forward and drift tests | #36 | Complete |
| P0-CURRENT-02 | Init, Plan, and Providers require current Reports; Verify can refresh valid history | Operation contract tests | #36 | Complete |
| P0-HISTORY-01 | Initialized full Audit and Verify persist atomic immutable local history | Persistence and recovery tests | #37 | Complete |
| P0-HISTORY-02 | Historical Records remain immutable and Report/Evidence history is never automatically pruned | Integrity and retention tests | #37 | Complete |
| P0-TOOLCHAIN-01 | Every ecosystem uses an isolated exact LaunchRally npm toolchain without modifying application dependencies | Cross-ecosystem Init tests | #38 | Complete |
| P0-PERMISSION-01 | Registry fallback is disclosed and separately approved; lifecycle scripts never execute | Network-denial and permission tests | #38 | Complete |
| P0-COVERAGE-01 | Direct full journey passes for all five representative repositories | Coverage Acceptance Matrix | #38 | Complete |
| P0-COVERAGE-02 | Skill full journey passes for JavaScript and non-JavaScript representatives under complete and partial permissions | Skill Reference Journey matrix | #38 | Complete |
| P0-QUALITY-01 | PRD traceability, secret safety, permission boundaries, false-confidence invariants, migrations, and recovery are release gates | CI validation | #39 | Complete |
| P0-PLATFORM-01 | Contract suites cover Node 20, 22, and 24; clean journeys cover Linux, macOS, and Windows on Node 22 | GitHub Actions matrix | #39 | Complete |
| P0-RELEASE-01 | Five exact public packages publish with provenance under the Experimental channel | Registry and provenance verification | #40 | Complete |
| P0-RELEASE-02 | Exact public CLI and both Plugin paths pass clean external smoke tests before GitHub prerelease creation | Post-publication workflow | #40 | Complete |
| P0-VALIDATE-01 | Validation Log remains aggregate, non-identifying, append-only, and reviewed | Validation contract tests | #41 | Complete |
| P0-VALIDATE-02 | P0 Validated requires a documented qualitative decision while the Quality Floor remains satisfied | Maintainer validation record | #41 | Complete |

## Quality Floor

P0 cannot proceed to P1 while any known secret disclosure, unauthorized data
egress, permission violation, unreliable representative install-to-Report
journey, insufficiently evidenced Passed result, or untrustworthy Launch Ready
assessment remains unresolved.

Issue #17 remains the phase tracker. Issue #34 owns corrective conformance work.
