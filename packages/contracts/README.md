# @launchrally/contracts

`@launchrally/contracts` is the public contract package for LaunchRally integrators and tool authors. It exports versioned contract identifiers, validators, and the versioned JSON Schemas used by CLI interactions, manifests, reports, plans, evidence indexes, Provider guidance, and verification results.

## Status

LaunchRally 0.3.0 is an **Experimental P0** release. Its public contracts are versioned, and Experimental availability remains non-stable after the reviewed P0 Validated decision. Consumers should reject unsupported contract major versions and pin the package version they have tested.

## Install and import

```sh
npm install @launchrally/contracts@0.3.0
```

```js
import { REPORT_SCHEMA } from "@launchrally/contracts";

console.log(REPORT_SCHEMA); // launchrally.dev/report/v2
```

The package also exports validators such as `assertValidReportPackage` and bundles its JSON Schema files in the published payload.

## Compatibility and versioning

This is an ESM package for the Node.js runtime supported by LaunchRally (Node.js 20.12.0 or newer). Contract names include a major version. Read the [data model](https://github.com/codeacme17/launchrally/blob/main/docs/concepts/data-model.md) before persisting or consuming Manifest, Report, View, or Evidence data, and use the exported compatibility helpers instead of guessing from fields.

## Documentation

- [LaunchRally documentation index](https://github.com/codeacme17/launchrally/blob/main/docs/README.md)
- [Data model and versioned records](https://github.com/codeacme17/launchrally/blob/main/docs/concepts/data-model.md)
- [CLI contract reference](https://github.com/codeacme17/launchrally/blob/main/skills/launchrally/references/cli-contract.md)
- [Published schema sources](https://github.com/codeacme17/launchrally/tree/main/packages/contracts/schemas)

## Project

[Repository](https://github.com/codeacme17/launchrally) · [Issues](https://github.com/codeacme17/launchrally/issues) · [Security](https://github.com/codeacme17/launchrally/security/policy)

Licensed under [Apache-2.0](https://github.com/codeacme17/launchrally/blob/main/LICENSE).
