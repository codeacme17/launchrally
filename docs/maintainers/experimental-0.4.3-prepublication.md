# Phase 1 Experimental 0.4.3 prepublication checks

Assessment date: 2026-09-07 UTC.

This record covers checks performed before publishing the 0.4.3 candidate.
It does not establish public availability, independent external verification,
P1 Validated status, or Stable-promotion approval.

## Candidate identity

- Version: `0.4.3` across all five packages.
- Candidate manifest: `release/p1-release-candidate.json`.
- Assessed correction commit: `08907b8c21d0f21a5f022b4740271dd153943583`.
- Dev integration commit: `4f5b5a033899e3ee9323e1c087df08e8d31955d6`.
- Correction: refresh the supply-chain assessment from August 23 to September 7.
- The correction changes no candidate package digest.
- Release channel: `experimental`; preserved Stable channel: `latest` at `0.3.2`.

The final release tag must identify the approved main promotion commit.
Neither commit above is a substitute for that final main identity.

## npm identity and publisher controls

Authenticated package-access checks confirmed write access to every package.
All five `npm trust list` checks returned the following exact configuration:

| Package | Provider | Repository | Workflow | Environment |
| --- | --- | --- | --- | --- |
| `@launchrally/contracts` | GitHub | `codeacme17/launchrally` | `release.yml` | `npm` |
| `@launchrally/core` | GitHub | `codeacme17/launchrally` | `release.yml` | `npm` |
| `@launchrally/cli` | GitHub | `codeacme17/launchrally` | `release.yml` | `npm` |
| `@launchrally/codex-plugin` | GitHub | `codeacme17/launchrally` | `release.yml` | `npm` |
| `@launchrally/claude-plugin` | GitHub | `codeacme17/launchrally` | `release.yml` | `npm` |

Each publisher allows `publish` and `stage publish`. The release workflow uses
the approved direct publication path; no publisher configuration was changed.
The GitHub `npm` environment requires deployment review and permits `v*.*.*`
tags. An active tag ruleset protects `refs/tags/v*.*.*`.

At assessment time all five public `experimental` tags resolved to `0.4.2`,
and all five `latest` tags resolved to `0.3.2`.

## Verification results

| Check | Result |
| --- | --- |
| Locked dependency installation with scripts disabled | Passed |
| Build and generated Skill synchronization | Passed; no generated diff |
| Supply-chain test suite | 68 passed, 0 failed |
| Full test suite after the assessment correction | 849 passed, 0 failed, 3 existing TODOs |
| Exact packed-artifact journeys within the full suite | Passed |
| Acceptance traceability | 25 P0 requirements, 39 P1 requirements, 17 release gates validated |
| P0 governance | Passed |
| P1 publication readiness | 39 requirements and 5 mandatory gates validated |
| Tagged release validation for `v0.4.3` | Passed on the assessment date |
| Candidate digest verification | All five npm pack digests match the committed manifest |
| Independent standards and specification review of the correction | No findings on either axis |
| Correction PR CI | All nine executed jobs passed; branch-policy job skipped |

The separate optional preflight fan-out was declined by the maintainer.
Same-day tagged-release validation must be repeated if publication moves to
another UTC date; this record does not extend the assessment's validity.

## Public references and remaining gates

- [Assessment correction PR #213](https://github.com/codeacme17/launchrally/pull/213).
- [Correction CI](https://github.com/codeacme17/launchrally/actions/runs/34081920547).
- [Main promotion PR #212](https://github.com/codeacme17/launchrally/pull/212).
- [Release tracker #210](https://github.com/codeacme17/launchrally/issues/210).

Main promotion, protected annotated-tag publication, public digest/provenance
smoke, and the published-artifact Human Mode checks required by #187 remain
separate gates. Independent CLI, Codex, and Claude external verification must
be recorded through the existing signed-result procedure after publication.
No public-release or external-verification gate is marked complete here.
