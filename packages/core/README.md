# @launchrally/core

`@launchrally/core` is the deterministic audit and verification library behind LaunchRally. It is intended for JavaScript tool authors who need LaunchRally's repository discovery, policy evaluation, planning, Provider guidance, reporting, and verification APIs without the interactive CLI presentation layer.

## Status

LaunchRally 0.3.2 is a **Stable** release. The package is Product Complete, P0 Validated, and published on the stable channel. Pin the exact version and review release changes before upgrading.

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
