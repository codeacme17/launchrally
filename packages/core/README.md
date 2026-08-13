# @launchrally/core

`@launchrally/core` is the deterministic audit and verification library behind LaunchRally. It is intended for JavaScript tool authors who need LaunchRally's repository discovery, policy evaluation, planning, Provider guidance, reporting, and verification APIs without the interactive CLI presentation layer.

## Status

LaunchRally 0.3.2 is a **Stable** release. The package is Product Complete, P0 Validated, and published on the stable channel. Pin the exact version and review release changes before upgrading.

The additive Phase 1 Core exports `runProductIntentDiscovery` for permissioned, local Product Intent discovery. It separates Local Safe Scan observations, selected-material candidates, explicit user confirmation, conflicts, Unknowns, and coverage. It never persists selected source text and grants no Provider or deployment authority.

The Provider-neutral capability APIs create the independently versioned 13-domain Catalog, build environment-bound Capability Graphs from confirmed Product Intent, explicitly confirm derived obligations, create synchronous or asynchronous Integration Contracts, and calculate precise declared invalidation. Requirement, decision, implementation, and Evidence states remain separate and are never collapsed into a completion percentage.

`createProviderKnowledge` and `assessProviderKnowledge` enforce independently versioned Provider Cards, exact digest trust, review and expiry, source provenance, and the `Core Catalog`, `Reviewed Extension`, and `Local Experimental` tiers. Only fresh, source-backed Core or exactly registered reviewed extensions can participate in normative recommendations. All Knowledge remains advisory, non-Evidence, non-gating, and without write authority; unknown, custom, and self-hosted Providers retain generic manual guidance and explicit Verification Gaps.

`runArchitectureDecisionEngine` requires a structurally valid current full Report, confirmed Product Intent, Catalog, and Capability Graph. It returns a whole-product Blueprint before any decision confirmation, excludes hard-constraint conflicts, retains existing implementations by default, omits unreviewed currency estimates, and supports independent per-decision confirmation or rejection without repository or Provider writes.

Confirmed decisions can be materialized with `createArchitecturePackageBundle`. The bundle keeps Product Intent, Capability Graph, Architecture Record, optional Task Graph, and a dependency index as separate versioned semantics. `evaluateArchitecturePackageCurrentness` reports current, reassessment, partial invalidation, or superseded state without rewriting history. `persistArchitecturePackage` remains output-only before Init unless an output path is explicitly selected; after Init it shares the local-history writer lock and atomically appends an immutable operational package only after digest-bound confirmation. Shareable Product Intent is stored independently by digest and the package references it. Persistence never edits the Manifest or stages or commits files.

`generateTaskGraph` combines a complete current Report with an immutable Architecture Package bundle while preserving Findings, Verification Gaps, unresolved decisions, and implementation work as distinct Task sources. It validates environment and digest bindings, declares Provider-neutral effects and prohibitions, and computes only the safe ready frontier. Reusing the same interface with a previous graph and typed status updates deterministically recomputes blocked and ready work after cancellation or partial execution, including after a fresh Report and reassessed Architecture input. A reported success remains a claim; only a `verified` update matching current revalidated Report Evidence can unlock effectful dependents. Architecture and implementation verification additionally requires every Check in that capability's explicit qualification set to pass, so one partial risk-domain observation cannot verify a broader capability. `mapTaskGraphExecutors` separately matches the generic Tasks to zero or more exactly authority-compatible managed Executors while always retaining a manual/custom path and granting no authority.

`runHandoff` discovers exact-version, platform-compatible, reviewed Executor Descriptors for only the current Task Graph frontier. It groups Tasks by environment, effect class, target, and Executor, rejects incompatible cancellation behavior, recommends the narrowest sufficient authority, and emits a versioned Handoff Package only after selection. The exact package discloses tools, user-managed unverified authentication assumptions, secret-reference handling, cancellation, and partial-failure semantics and remains unapproved until explicit confirmation. Core never installs an Executor, starts a login, requests credentials, executes the package, or treats an Execution Receipt as Evidence. Normalized secret-free receipts produce claim-only Task updates and always route to fresh independent Verify; partial claims retain a structured remaining-work outcome, while all-or-nothing batches reject mixed outcomes. Missing, unsupported, expired, cancelled, partial, deferred, and cross-session states remain typed.

`deriveCompositeAssurance` evaluates typed layered Checks directly, while `deriveCompositeAssuranceFromReport` binds the same derivation to a current full Report, its Evidence Index, a Capability Graph, an immutable Architecture Record, and Integration Contracts. Requirement, local implementation, Provider configuration, integration consistency, deployment, operational delivery, and downstream outcome remain separate environment-bound facets. Assurance advances only through contiguous qualifying layers, incomplete negative coverage remains Unverified, and only `current_release` Required capabilities use capability-specific minimum assurance as launch gates. `deriveArchitectureStatus` deterministically summarizes immutable decision state and explicit Architecture currentness independently from Launch Assessment. Composite identities bind exact source-record, Check-set, Evidence Index, and Architecture Status digests.

## Install and use

```sh
npm install @launchrally/core@0.3.2
```

```js
import { runAudit } from "@launchrally/core";

const interaction = await runAudit(process.cwd(), "0.3.2");
console.log(interaction.status, interaction.next);
```

`runAudit` starts with deterministic local repository facts and returns a typed interaction. Callers must preserve its explicit confirmation and permission flow before supplying any optional public or Provider reads.

Missing or unauthenticated Provider executables remain Verification Gaps. The Core attaches `launchrally.dev/provider-tool-recovery/v1`, can reveal only the shared reviewed exact-version route, and can rediscover only through the declared version command. A successful rediscovery returns a new pending Provider-read description and never reuses the earlier approval.

## Compatibility and boundaries

This is an ESM package for Node.js 20.12.0 or newer. The core does not create accounts, provision infrastructure, deploy, or perform autonomous production writes. Audit and Plan are read-only; the separately previewed Init and local intent flows require explicit confirmation. See [privacy and permissions](https://github.com/codeacme17/launchrally/blob/main/docs/concepts/privacy.md) for the authoritative boundary.

## Documentation

- [Data model](https://github.com/codeacme17/launchrally/blob/main/docs/concepts/data-model.md)
- [Privacy and permissions](https://github.com/codeacme17/launchrally/blob/main/docs/concepts/privacy.md)
- [Canonical Agent Skill](https://github.com/codeacme17/launchrally/blob/main/skills/launchrally/SKILL.md)
- [Core public exports](https://github.com/codeacme17/launchrally/blob/main/packages/core/src/index.js)

## Project

[Repository](https://github.com/codeacme17/launchrally) · [Issues](https://github.com/codeacme17/launchrally/issues) · [Security](https://github.com/codeacme17/launchrally/security/policy)

Licensed under [Apache-2.0](https://github.com/codeacme17/launchrally/blob/main/LICENSE).
