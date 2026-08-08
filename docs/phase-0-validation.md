# Phase 0 release and validation

LaunchRally uses four deliberately separate states:

- **P0 Product Complete** means the P0 scope, documentation, license, clean Reference Journey, Coverage Acceptance Matrix, release packaging, and Quality Floor are delivered. It describes product construction, not field validation.
- **Experimental release** means those artifacts are public for cautious real-world use. Contracts may change, and users should review every permission and preview.
- **Telemetry-Free Validation** is a later learning period. Aggregate trends, voluntary feedback categories, represented framework and deployment contexts, recurring P1 requests, and resulting decisions are recorded without default telemetry or mandatory uploads.
- **P0 Validated** is a future product decision supported by the published Validation Log. It is not implied by publication, passing CI, package downloads, or elapsed time.

P0 is not Product Complete and no public Experimental release exists. Release-blocking acceptance requirements remain open, so Telemetry-Free Validation has not started and LaunchRally is not P0 Validated.

## Decision method

No hard download quota determines validation. Maintainers review the shape and consistency of evidence instead: whether builders complete the Reference Journey, which contexts are represented, where permission or comprehension failures recur, what P1 capabilities are repeatedly requested, and whether the P0 safety boundaries hold.

Sources are limited to voluntary Issues and Discussions, opt-in maintainer conversations summarized without user identity, public aggregate package trends, and clean-environment quality checks. Do not add account tracking, default telemetry, user-level analytics, private-service dependencies, or mandatory Report/Evidence uploads.

## Updating the log

Update `docs/phase-0-validation-log.json` with aggregate, non-identifying observations. Use broad context labels, category counts or qualitative trends, and decision rationales. Never record usernames, repository names, URLs, credentials, Report contents, Evidence contents, or raw support messages.
