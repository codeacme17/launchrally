# Phase 0 release and validation

LaunchRally uses four deliberately separate states:

- **P0 Product Complete** means the P0 scope, documentation, license, clean Reference Journey, Coverage Acceptance Matrix, release packaging, and Quality Floor are delivered. It describes product construction, not field validation.
- **Experimental release** means those artifacts are public for cautious real-world use. Contracts may change, and users should review every permission and preview.
- **Telemetry-Free Validation** is the current learning period. Aggregate trends, voluntary feedback categories, represented framework and deployment contexts, repeated value and defect patterns, recurring P1 requests, and resulting decisions are recorded without default telemetry or mandatory uploads.
- **P0 Validated** is a future product decision supported by the published Validation Log. It is not implied by publication, passing CI, package downloads, or elapsed time.

P0 is Product Complete and `0.3.0` is a public Experimental release. Telemetry-Free Validation is collecting directional signals, but LaunchRally is not P0 Validated. P1 discovery and design may continue; authority-expanding P1 implementation remains blocked.

## Decision method

No hard download quota determines validation. Maintainers review the shape and consistency of evidence instead: whether builders complete the Reference Journey, which contexts are represented, where permission or comprehension failures recur, what P1 capabilities are repeatedly requested, and whether the P0 safety boundaries hold.

Sources are limited to voluntary Issues and Discussions, opt-in maintainer conversations summarized without user identity, public aggregate package trends, and clean-environment quality checks. Do not add account tracking, default telemetry, user-level analytics, private-service dependencies, or mandatory Report/Evidence uploads.

## Updating the log

Update `docs/maintainers/phase-0-validation-log.json` only through a reviewed pull request. Preserve every existing entry exactly and append aggregate, non-identifying observations. Use the permitted voluntary GitHub feedback, opt-in maintainer summary, public aggregate package trend, and clean-environment sources. Record broad represented contexts, repeated value and defect patterns, recurring P1 needs, and resulting decisions. Never record usernames, repository names, URLs, credentials, Report contents, Evidence contents, or raw support messages.

New entries use the reviewed per-field aggregate taxonomy enforced by `npm run validate:p0`; raw qualitative text does not belong in the log. Extend a field taxonomy in the same reviewed pull request when a genuinely new aggregate category is needed. Quality Floor regressions use stable non-identifying `qf-YYYY-MM-DD-NN` IDs so each open regression requires its own verified-fix record.

Every entry records the current Quality Floor, an explicit qualitative validation decision, and the P1 gate. Any known Quality Floor regression suspends completion claims and the machine validation authority state, invalidates a P0 Validated claim, and keeps authority-expanding P1 implementation blocked until a verified fix and a later reviewed entry restore the floor. This suspension does not stop permitted aggregate, telemetry-free signal collection. Download counts, elapsed time, quotas, or numeric adoption thresholds cannot make P0 Validated.
