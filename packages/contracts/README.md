# @launchrally/contracts

`@launchrally/contracts` is the public contract package for LaunchRally integrators and tool authors. It exports versioned contract identifiers, validators, and the versioned JSON Schemas used by CLI interactions, manifests, reports, plans, evidence indexes, Provider guidance, Provider tool recovery, verification results, and the additive Phase 1 architecture contract foundation.

The Task Graph contract validates a Provider-neutral DAG of environment-bound Tasks, exact source and Architecture bindings, explicit effect boundaries, cancellation behavior, currentness, verification Evidence, and a complete safe ready frontier. Completion is bound to Evidence from the current, revalidated Report rather than inline result claims. Missing or cyclic dependencies, cross-environment Tasks, hidden effects, secret values, and a `verified` state without current typed Evidence fail closed.

The Composite Assurance contract validates deterministic capability-specific derivations across seven orthogonal Check layers. Every Evidence reference and capability is bound to one explicit environment; assurance states cannot skip a missing layer, only current-release Required capabilities gate, and future scope remains explicit. Exact source and Architecture Status digests bind the derivation identity while Architecture Status remains independent from Launch Assessment.

## Status

LaunchRally 0.3.2 is a **Stable** release. Its public contracts are versioned, and Stable availability follows the reviewed P0 Validated decision and satisfied Quality Floor. Consumers should reject unsupported contract major versions and pin the package version they have tested.

## Install and import

```sh
npm install @launchrally/contracts@0.3.2
```

```js
import { REPORT_SCHEMA } from "@launchrally/contracts";

console.log(REPORT_SCHEMA); // launchrally.dev/report/v2
```

The package also exports validators such as `assertValidReportPackage` and bundles its JSON Schema files in the published payload.

The Phase 1 foundation exports one validator per record, including digest-bound Provider Knowledge and Executor Descriptors, plus `assertValidPhase1Record`, `assertValidPhase1References`, `assertSupportedPhase1Version`, and `PHASE_1_SCHEMA_VERSIONS`. Use `assertValidPhase1References` with an external trusted ID/version/digest index to validate cross-record bindings without embedding the referenced records. Executor tools declare an exact executable and version, and Descriptor trust declares a self-binding digest plus review and expiry timestamps. These contracts define data semantics only: validating a Descriptor, Handoff Package, or Receipt never installs software, grants authority, executes work, or creates Evidence.

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
