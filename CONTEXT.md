# LaunchRally

LaunchRally separates product construction, cautious public availability, field learning, and authority expansion so evidence from one state cannot silently grant another.

## Language

**P0 Product Complete**:
The P0 product contract, representative journeys, release packaging, and Quality Floor are complete. It is a construction state, not evidence of field validation.
_Avoid_: P0 Validated, generally available

**Experimental Release**:
The Product Complete artifacts are publicly available for cautious use without a stability claim.
_Avoid_: Stable release, generally available

**Telemetry-Free Validation**:
The append-only learning period that records aggregate non-identifying Validation Signals and resulting decisions without accounts, default telemetry, or mandatory uploads.
_Avoid_: Analytics, adoption tracking

**Validation Signal**:
A directional aggregate observation from a permitted voluntary, public aggregate, or clean-environment source. It never identifies a person or repository and is not a hard quota.
_Avoid_: User event, telemetry event

**P0 Validated**:
An explicit qualitative maintainer decision supported by the Validation Log while the Quality Floor is satisfied.
_Avoid_: Product Complete, published, download target reached

**Quality Floor**:
The non-negotiable safety, reliability, permission, and evidence-integrity conditions that must remain satisfied for completion claims and authority expansion.
_Avoid_: Quality score, adoption target

**P1 Discovery**:
Non-authoritative research and design work that may continue during Telemetry-Free Validation.
_Avoid_: P1 implementation

**Authority-Expanding P1 Implementation**:
P1 product work that adds write authority or otherwise expands LaunchRally's authority and remains blocked until P0 Validated.
_Avoid_: P1 discovery

**Launcher**:
The dispatcher entered through the user-managed `rally` command or a supported exact-version npm-exec invocation.
_Avoid_: Global CLI, current CLI

**Engine**:
The selected LaunchRally CLI implementation that executes repository operations.
_Avoid_: Project CLI, effective CLI

**Project Toolchain**:
The repository-owned exact Engine pin, authority descriptor, and rebuildable materialization.
_Avoid_: Local install, project dependencies

**Execution Authority**:
The versioned rule and result that select and validate the Engine for a repository.
_Avoid_: CLI precedence, version preference

**Invocation Context**:
The non-authoritative description of how a user entered the Launcher.
_Avoid_: Execution Authority, reconstructed command

**Product Intent Profile**:
The versioned distinction between explicitly confirmed desired behavior, observed implementation facts, provenance, unresolved conflicts, coverage, and Unknowns.
_Avoid_: Agent summary, inferred requirements

**Local Semantic Analysis**:
A separately disclosed, explicitly approved read of selected local product materials that retains only normalized Product Intent candidates and provenance.
_Avoid_: Local Safe Scan, unrestricted repository analysis

**Product Intent Candidate**:
A normalized behavior or obligation suggested by observed facts or approved materials that remains unconfirmed until the builder explicitly accepts it.
_Avoid_: Confirmed Product Intent, Agent conclusion

**Capability Catalog**:
The Provider-neutral, independently versioned vocabulary of launch capabilities and their requirement, decision, implementation, and Evidence facets.
_Avoid_: Provider catalog, feature checklist

**Provider Knowledge**:
The independently versioned, source-provenance-bearing advisory record used to assess Provider fit under explicit trust, review, and expiry rules. It never constitutes Machine Evidence or grants release-gating or write authority.
_Avoid_: Capability Catalog, live Provider state, verified implementation

**Capability Graph**:
The environment-bound applicability and dependency graph derived from a confirmed Product Intent Profile and a Capability Catalog.
_Avoid_: Completion score, Provider architecture

**Derived Obligation**:
An inspectable candidate requirement linked from a confirmed source behavior to a target capability; it becomes confirmed only through explicit builder selection.
_Avoid_: Hidden requirement, automatic Product Intent change

**Integration Contract**:
The Provider-neutral semantics required between two capabilities, including delivery, failure, privacy, Evidence, and invalidation behavior.
_Avoid_: Provider webhook definition, SDK contract

**Architecture Blueprint**:
The whole-product comparison of existing and alternative implementation paths under confirmed constraints before individual decisions are confirmed.
_Avoid_: Provider ranking, accepted architecture

**Architecture Record**:
An immutable set of individually confirmed Architecture decisions bound to exact source records and provenance.
_Avoid_: Mutable architecture document, Blueprint

**Architecture Package**:
The versioned envelope that references separate Product Intent, Capability Graph, Architecture Record, and optional Task Graph records while declaring their currentness.
_Avoid_: Monolithic architecture record, Manifest

**Task Graph**:
A Provider-neutral directed acyclic graph of bounded work, dependencies, effects, Executor requirements, result claims, and follow-up Verify requests.
_Avoid_: Script, deployment plan

**Executor**:
An external, explicitly selected actor described by a versioned capability and effect contract; installing or discovering one grants it no authority.
_Avoid_: LaunchRally Core, automatically authorized tool

**Handoff Package**:
The versioned source of explicitly approved external Task authority, including its exact Executor, environment, target, and effects.
_Avoid_: Natural-language prompt, implicit permission

**Execution Receipt**:
A normalized secret-free claim about externally attempted Task results that never constitutes Machine Evidence.
_Avoid_: Verification result, Evidence

**Active Verification**:
An explicitly approved, environment-bound synthetic action and observation performed through a supported external Executor.
_Avoid_: Ordinary read verification, production test by default

**Architecture Status**:
The currentness and decision completeness of an Architecture Record, kept independent from Launch Assessment.
_Avoid_: Launch readiness, Assessment
