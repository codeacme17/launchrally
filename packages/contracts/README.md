# @launchrally/contracts

`@launchrally/contracts` is the public contract package for LaunchRally integrators and tool authors. It exports versioned contract identifiers, validators, and the versioned JSON Schemas used by CLI interactions, manifests, reports, plans, evidence indexes, Provider guidance, Provider tool recovery, verification results, Host Resume Artifacts, Desktop Shared Backend topology, Reference Integration Packs, and the additive Phase 1 architecture contract foundation.

The Task Graph contract validates a Provider-neutral DAG of environment-bound Tasks, exact source and Architecture bindings, explicit effect boundaries, cancellation behavior, currentness, verification Evidence, and a complete safe ready frontier. Completion is bound to Evidence from the current, revalidated Report rather than inline result claims. Missing or cyclic dependencies, cross-environment Tasks, hidden effects, secret values, and a `verified` state without current typed Evidence fail closed.

The Composite Assurance contract validates deterministic capability-specific derivations across seven orthogonal Check layers. Every Evidence reference and capability is bound to one explicit environment; assurance states cannot skip a missing layer, only current-release Required capabilities gate, and future scope remains explicit. Exact source and Architecture Status digests bind the derivation identity while Architecture Status remains independent from Launch Assessment.

The Active Verification contracts bind reviewed recipes, versioned Integration Contracts, and exact Executor modes to independently approved `active_test` Handoff Packages. Results retain only normalized outcome facts, distinguish asynchronous business outcomes from transport acceptance, and bind qualifying Evidence to the exact Request, Handoff, Executor, Integration Contract, environment, correlation ID, observation time, and cleanup result. Production requires a production-safe recipe plus separate approval.

The authenticated Journey Evidence contract qualifies only structurally validated `passed` and `failed` observations produced by the exact host adapter inside a freshly approved, declared collection window. Protected targets use exact non-root static same-origin GET paths with bounded canonical lowercase ASCII segments; application-specific letters, digits, hyphens, and underscores are accepted, while dynamic placeholders and obvious opaque numeric, hexadecimal, or UUID segment shapes remain excluded. Path spelling implies neither authorization nor personal-data safety, so the builder must classify only an exact concrete path that is appropriate to disclose. Its provenance binds the exact target, permission, adapter, and time window. Authentication denial or unavailable host capability remains a typed Verification Gap without Evidence; Agent statements, user assertions, and Execution Receipts are not substitute Evidence.

## Status

LaunchRally 0.4.0 is an **Experimental Phase 1** release. Its public contracts are versioned independently from package release status. Phase 0 Stable 0.3.2 remains on npm `latest`; publishing Phase 1 does not make it Validated or Stable. Consumers should reject unsupported contract major versions and pin the exact package version they have tested.

Phase 0 0.3.2 remains a **Stable** release. Stable availability follows the reviewed P0 Validated decision and satisfied Quality Floor.

## Install and import

```sh
npm install @launchrally/contracts@0.4.0
```

```js
import { REPORT_SCHEMA } from "@launchrally/contracts";

console.log(REPORT_SCHEMA); // launchrally.dev/report/v2
```

The package also exports validators such as `assertValidReportPackage` and bundles its JSON Schema files in the published payload.

The Phase 1 foundation exports one validator per record, including digest-bound Provider Knowledge and Executor Descriptors, plus `assertValidPhase1Record`, `assertValidPhase1References`, `assertSupportedPhase1Version`, and `PHASE_1_SCHEMA_VERSIONS`. Reference Integration Packs bind a Provider-neutral Capability and Integration Contract to reviewed managed, retained, custom, self-hosted, and Unknown implementations; exact interface versions, allowed/prohibited effects, source review dates, digest-bound Executor references, generic active-test recipes, deterministic synthetic normalization fixtures, and typed outcomes remain explicit. Pack observations are unverified and never create Machine Evidence or change assurance. Use `assertValidPhase1References` with an external trusted ID/version/digest index to validate cross-record bindings without embedding the referenced records. Executor tools declare an exact executable and version, and Descriptor trust declares a self-binding digest plus review and expiry timestamps. These contracts define data semantics only: validating a Descriptor, Handoff Package, or Receipt never installs software, grants authority, executes work, or creates Evidence.

## Compatibility and versioning

This is an ESM package for the Node.js runtime supported by LaunchRally (Node.js 20.12.0 or newer). Contract names include a major version. Read the [data model](https://github.com/codeacme17/launchrally/blob/main/docs/concepts/data-model.md) before persisting or consuming Manifest, Report, View, or Evidence data, and use the exported compatibility helpers instead of guessing from fields.

Phase 1 v1 readers reject malformed records, unknown enum values, and unknown major versions. Historical Report v1 references remain readable where the Phase 1 binding explicitly permits them. Cross-record references retain their own IDs, schema versions, and digests; a receipt remains a claim and can never be represented as Evidence.

## Documentation

- [LaunchRally documentation index](https://github.com/codeacme17/launchrally/blob/main/docs/README.md)
- [Data model and versioned records](https://github.com/codeacme17/launchrally/blob/main/docs/concepts/data-model.md)
- [CLI contract reference](https://github.com/codeacme17/launchrally/blob/main/skills/launchrally/references/cli-contract.md)
- [Published schema sources](https://github.com/codeacme17/launchrally/tree/main/packages/contracts/schemas)

## Project

[Repository](https://github.com/codeacme17/launchrally) · [Issues](https://github.com/codeacme17/launchrally/issues) · [Security](https://github.com/codeacme17/launchrally/security/policy)

Licensed under [Apache-2.0](https://github.com/codeacme17/launchrally/blob/main/LICENSE).
