# Phase 1 telemetry-free validation

LaunchRally records Phase 1 learning without accounts, default telemetry,
mandatory uploads, or user-level analytics. The append-only
[Phase 1 Validation Log](phase-1-validation-log.json) contains reviewed,
aggregate Validation Signals. It does not contain the underlying repository,
conversation, Report, Evidence, or Provider output.

The current state is `collecting / not_validated`. Phase 1 remains on the
Experimental channel and Stable promotion is not approved.

## Independent lifecycle states

The release contract keeps these decisions independent:

1. **P1 Product Complete** describes construction and mandatory release gates.
2. **Experimental publication** makes exact artifacts available for cautious
   use without a stability claim.
3. **P1 Validated** requires a later reviewed qualitative decision supported
   by the Validation Log while the Quality Floor permits that decision.
4. **Stable-promotion approval** is a separate maintainer decision with its own
   exact tag and release gates.

Publication, passing CI, package downloads, elapsed time, or the presence of a
single Validation Log entry cannot advance another state. P0 Stable remains an
independent read-only input.

## Permitted sources

Only these source classes may contribute aggregate categories:

- clean-environment checks;
- opt-in maintainer summaries;
- public aggregate package trends; and
- voluntary GitHub feedback.

Participation is optional. Public aggregate package trends are directional
context only; they are never an adoption quota, threshold, or validation
trigger.

## Prohibited data

Do not record repository identity or name, repository paths, target URLs,
provider or account identifiers, credentials, secrets, personal data,
user-level events, business payloads, raw terminal output, raw Provider output,
support messages, or Report or Evidence content. Product Intent Profiles,
Architecture Records, Task Graphs, receipts, PRDs, and deployment identifiers
also remain outside the log.

The machine contract uses exact fields and a strict reviewed aggregate taxonomy.
Issue references are normalized LaunchRally `#NNN` identifiers, never URLs.
Free-form qualitative messages do not belong in the log. A new category must
be added to the taxonomy and reviewed in the same pull request that first uses
it.

## Review and append procedure

Update the log only through a reviewed pull request. Preserve every reviewed
entry byte-for-byte and append a new entry; never edit, delete, or reorder
history. Update `updated_at` to the appended entry date. CI compares the log
with the reviewed Git base, while local validation can use `--baseline-log` for
the same append-only check.

Each entry records permitted sources, represented aggregate contexts, journey
outcome, comprehension categories, normalized defect patterns, resulting
product decisions, a Quality Floor event snapshot, and the independent
lifecycle snapshot. Repository-specific evidence stays in its authorized local
or issue context and is not copied into the log.

## Quality Floor and authority

`release/p1-acceptance.json` and
`release/p1-regression-registry.json` remain the canonical P1 Quality Floor and
regression assignment records. The Validation Log records append-only lifecycle
events for those same stable `P1-REG-NNNN` identifiers; it does not create a
second Quality Floor.

An open regression suspends only its declared P1 authority scopes. Unrelated
P1 authorities and P0 Stable do not change. A later verified-fix entry is
required before a separate later restoration entry can restore the suspended
authority. The log, matrix, registry, release contract, and derived suspended
authority set must agree.

Product defect references are not automatically Quality Floor regressions.
Maintainers first decide whether a finding violates a named condition. Only a
reviewed violation receives a stable regression identifier and affected
authority scopes.

## First aggregate input

The first entry summarizes the `0.4.1` CLI Human Mode P0 + P1 end-to-end
journey. It records one TypeScript/pnpm web-monorepo context and staging
verification only as normalized aggregate categories. The journey completed
with documented workarounds and produced LaunchRally issues `#187`, `#188`,
and `#191` through `#194`.

That input supports continued collection and product decisions. It is not
sufficient evidence for P1 Validated or Stable promotion.
