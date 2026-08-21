# Phase 1 acceptance and release governance

`release/p1.json` and `release/p1-acceptance.json` are the independent Phase 1
release and traceability contracts. They supplement, and never rewrite,
`release/p0.json` or `release/p0-acceptance.json`. P0 remains Stable while P1
is Product Complete, not validated, and limited to the Experimental channel.

Every requirement below names a versioned contract, implementation, exact
test, tracking issue, state, and mandatory gate in the machine-readable
matrix. A row can be Complete while P1 Product Complete remains blocked by an
open requirement or pending mandatory gate.

| ID | Requirement | Executable evidence | Tracking | Status |
| --- | --- | --- | --- | --- |
| P1-INTENT-01 | Product Intent discovery keeps inferred candidates separate from confirmed declarations | approved semantic analysis produces normalized candidates and a confirmed profile | #126 | Complete |
| P1-INTENT-02 | Product Intent discovery completes with or without selected product materials | discovery completes without a PRD and after semantic permission denial | #126 | Complete |
| P1-INTENT-03 | Confirmed hard constraints and preferences remain independently queryable | conflicting materials and user-declared no-PRD behavior remain separately queryable | #126 | Complete |
| P1-SCAN-01 | Semantic material reads require an explicit fresh permission | Product Intent discovery requests semantic permission before reading selected material | #126 | Complete |
| P1-SCAN-02 | Unsupported semantic material remains explicit partial coverage | unsupported selected material preserves partial coverage and cannot prove absence | #126 | Complete |
| P1-SCAN-03 | Scan observations never silently become declared intent or composite assurance | cross-environment or incomplete negative observations remain Unverified | #133 | Complete |
| P1-CAPABILITY-01 | The Provider-neutral Capability Catalog independently versions all launch domains | the core Capability Catalog independently versions all 13 launch domains | #127 | Complete |
| P1-CAPABILITY-02 | Capability requirements, configuration, operation, and outcomes remain orthogonal | the graph keeps four state facets orthogonal and obligations inspectable | #127 | Complete |
| P1-INTEGRATION-01 | Integration Contracts remain Provider-neutral and versioned | Provider-neutral Integration Contracts cover sync and async semantics | #127 | Complete |
| P1-INTEGRATION-02 | Synchronous and asynchronous success conditions require truthful downstream observations | an accepted transport response cannot prove an asynchronous business outcome | #134 | Complete |
| P1-ARCH-01 | Architect requires current whole-product inputs before recommendation | Architect requires a current full Report and produces the whole Blueprint first | #128 | Complete |
| P1-ARCH-02 | Architecture recommendations never violate confirmed hard constraints | hard-constraint violations are excluded and never recommended | #128 | Complete |
| P1-ARCH-03 | Architecture alternatives preserve explainable replacement rationale | Architecture alternatives cover every decision action with replacement rationale | #128 | Complete |
| P1-ARCH-04 | Each Architecture decision is independently confirmable | each Blueprint decision can be accepted or rejected independently | #128 | Complete |
| P1-ARCH-05 | Confirmed decisions produce immutable versioned Architecture Packages | confirmed decisions create separate immutable versioned Architecture Package semantics | #129 | Complete |
| P1-ARCH-06 | Architecture currentness invalidates only declared dependencies | currentness invalidates only declared decision dependencies and reassesses stale inputs | #129 | Complete |
| P1-ARCH-DESKTOP-01 | Desktop shared-backend topology excludes distribution readiness | desktop shared-backend assessment keeps distribution readiness explicitly Unknown | #136 | Complete |
| P1-KNOWLEDGE-01 | Normative Provider Knowledge is reviewed, source-backed, current, and digest-bound | Core Provider Knowledge is independently versioned, source-backed, and digest-bound | #130 | Complete |
| P1-KNOWLEDGE-02 | Expired or unproven Provider claims never participate in recommendations | only fresh reviewed source-backed supply-chain artifacts participate in normative recommendations | #130 | Complete |
| P1-EXTENSION-01 | Provider extensions require reviewed trust without making generic implementations unsupported | unknown, custom, and self-hosted Providers retain generic manual guidance with honest depth | #130 | Complete |
| P1-PLAN-01 | Task Graphs preserve exact source meaning, dependencies, authority, and safe recomputation | current Findings and Architecture Decisions produce one deterministic source-preserving Task Graph | #131 | Complete |
| P1-HANDOFF-01 | Executor discovery exposes compatible choices without granting authority | Executor discovery exposes compatible authority batches without granting authority | #132 | Complete |
| P1-HANDOFF-02 | Every external effect is previewed and independently approved | every ordinary write effect class is disclosed in a separately approvable batch | #132 | Complete |
| P1-HANDOFF-03 | Handoff denial and cancellation stop before external authority | denial and cancellation terminate before any external authority is granted | #132 | Complete |
| P1-HANDOFF-04 | Partial execution and remaining work stay explicitly typed | partial failure stays typed and cannot be promoted to Evidence | #132 | Complete |
| P1-HANDOFF-05 | Receipts remain claims and route completion through fresh Verify | a normalized receipt remains a claim and produces only unverified Task updates | #132 | Complete |
| P1-VERIFY-01 | Composite assurance advances only through contiguous qualifying layers | assurance advances only through contiguous environment-bound Check layers | #133 | Complete |
| P1-VERIFY-02 | Assurance Evidence remains explicitly environment-bound | cross-environment or incomplete negative observations remain Unverified | #133 | Complete |
| P1-VERIFY-03 | Capability-specific minimum assurance gates only the current release | future Required capabilities remain explicit without gating the current release | #133 | Complete |
| P1-VERIFY-04 | Active verification is separately approved, privacy-safe, and production default-denied | production active verification is default-denied without a production-safe recipe and separate approval | #134 | Complete |
| P1-VERIFY-05 | Architecture Status and Launch Assessment remain independent and deterministic | assurance identity binds exact derivation inputs and Architecture Status stays independent | #133 | Complete |
| P1-AUTH-01 | Authenticated success and failure become Machine Evidence only through exact host provenance | authenticated Journey success and failure are normative Phase 1 Machine Evidence | #135 | Complete |
| P1-PRIVACY-01 | Persisted Phase 1 records reject credentials, business payloads, raw Provider output, and personal data | focused negative fixtures reject sensitive persistence and receipt-as-Evidence | #134 | Complete |
| P1-COMPAT-01 | P0-to-P1 adoption is additive, transactional, explicit, and byte-preserving on denial | confirmed P1 adoption commits atomically and interruption preserves the P0 project | #136 | Complete |
| P1-HOST-01 | Codex and Claude resume exact Architecture and Handoff state without prose reconstruction | Claude Handoff state resumes in Codex from one validated local artifact | #136 | Complete |
| P1-COVERAGE-01 | Representative Provider-neutral Packs preserve honest depth for managed and generic implementations | reference packs cover every product shape and integration family without Provider semantics | #137 | Complete |
| P1-DOCS-01 | Agent and Human users can follow the complete authority-aware Phase 1 journey | documented Phase 1 commands are equivalent across POSIX and PowerShell | #138 | Complete |
| P1-RELEASE-01 | Exact P1 artifacts publish only as Experimental before separate external verification and Stable promotion | P1 Experimental publication readiness permits only external verification to remain open; P1 external verification cannot complete without its signed aggregate record; published P1 artifacts match candidate digests, provenance, and the preserved latest line; the P1 announcement and external Agent procedure preserve every lifecycle boundary; external Phase 1 results require machine-checked CLI, Codex, and Claude scenario coverage; packed artifacts complete installation, delegation, lifecycle, and full verification journeys | #183 | Open |

## Independent lifecycle

P0 Product Complete, P0 Validated, and P0 Stable are read-only inputs to this
contract. They do not imply any P1 state. P1 cannot become Stable until its
own Product Complete, validation, publication, Quality Floor, external
verification, and separate Stable-promotion records all agree. Experimental
P1 artifacts never replace the P0 `latest` line.

## Quality Floor and restoration

The machine-readable matrix defines exactly 14 stable, non-identifying
conditions (`P1-QF-01` through `P1-QF-14`). A regression uses a stable
`P1-REG-NNNN` ID and names only the affected authority scopes. An open or
fixed-but-not-restored regression suspends those scopes without changing P0
or unrelated P1 authorities. Restoration requires both a reviewed fix record
and a restoration record before the condition returns to `satisfied`. Every
ID-to-condition/scope assignment is reserved in the append-only
`release/p1-regression-registry.json`; CI compares that registry with the
reviewed Git base so restored IDs cannot be deleted and reused.

## Mandatory gates

Traceability, the P1 Quality Floor, supply-chain integrity, exact packed
artifacts, and external verification are mandatory and independently
addressable. Cards, Packs, Executor Descriptors, public commands, generated
copies, effects, exact versions, provenance, platform claims, and any
authority expansion remain fail-closed under the supply-chain gate. The exact
artifact gate and external verification are Complete, so P1 is Product Complete
and published while remaining Experimental, not P1 Validated, and not Stable.
Completed P0 behavior remains independently available.
Supply-chain freshness is evaluated at the explicit
`supply_chain_assessment_at` timestamp in `release/p1.json`, and release
validation requires that timestamp to match its current UTC date. A historical
assessment cannot authorize a later publication.

## Exact-artifact matrix

`npm run test:p1-exact-artifacts` packs and installs the declared CLI, Core,
Contracts, canonical Skill, Codex, and Claude artifacts before observing any
P1 result. It runs the five representative Product journeys through fresh full
Verify, and runs every managed implementation in all eight Integration
families through both installed Host adapters. Receipts stay claim-only and
produce an exact fresh-Verify request. For every family, the packed CLI then
executes that request's local Evidence target and binds the resulting content
digest to fresh environment-bound Evidence. Independently collected
authenticated success and failure bind the exact host-adapter Evidence digest
and provenance to truthful Assessment.

The CI journey matrix binds each invocation to its actual runtime rather than
trusting a label:

| Runner | Node | Published shell form |
| --- | --- | --- |
| Ubuntu | 20.12, 22, 24 | POSIX |
| macOS | 22 | POSIX |
| Windows | 22 | PowerShell |

The gate invokes the exact native Codex and Claude local marketplace,
installation, discovery, and removal commands in isolated configuration roots,
then runs the typed packaged adapter journeys under a deny-by-default Node
effect boundary. Model-driven native Agent execution was not inferred from
plugin discovery or adapter imports: it ran in protected clean external hosts
with short-lived authentication and is retained only through the signed
aggregate under `p1_external_verification`. The same installed-artifact gate
exercises no-PRD and incomplete semantic
coverage, denied write authority, missing Executor, cancellation, partial
receipt, stale Architecture, Unknown Provider, environment isolation,
cross-host resume (or the explicit unsupported Windows boundary), additive
P0-to-P1 migration denial, successful adoption, injected interruption rollback
and retry, project-pinned execution, uninstall, and retained local project
data. The reported clean-host result covers the packed adapter and CLI journey:
typed adapter imports and no-effect calls are guarded across asynchronous and
synchronous process, filesystem, network, worker, and native-addon seams;
authorized package-manager and authenticated loopback operations are recorded
separately; and application-tree, installed-prefix, and normalized outputs are
inspected for boundary drift. Native host discovery has a separate result and
does not claim that model execution or all native-binary effects were observed.
