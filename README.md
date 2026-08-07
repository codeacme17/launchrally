# LaunchRally

LaunchRally is a local-first, open-source launch readiness audit and verification tool for repository-owning AI builders.

> **Status: Experimental.** The P0 delivery and quality floor is Product Complete, but real-world Telemetry-Free Validation is still in progress. LaunchRally is not yet P0 Validated, and its contracts may change before P1.

Use the [Quickstart](docs/quickstart.md), understand the [Manifest, Report, and Evidence model](docs/data-model.md), and review the [permission and privacy boundaries](docs/privacy.md). Questions and voluntary field reports belong in [GitHub Discussions](https://github.com/codeacme17/launchrally/discussions); actionable defects belong in [GitHub Issues](https://github.com/codeacme17/launchrally/issues). See [SECURITY.md](SECURITY.md) for private vulnerability reports and [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes.

This repository contains the Phase 0 Audit, post-Report initialization, read-only Launch Plan, bounded Provider guidance, and post-remediation Verify paths. It establishes package boundaries, the CLI interaction contract, shared Agent Skill packaging, a deterministic Web baseline, a policy-driven launch assessment, read-only public verification, approved Provider metadata reads, preview-first local adoption, deterministic remediation guidance, open Provider Decision Cards, and immutable verification history.

## First Audit

```bash
npm exec --package=@launchrally/cli@0.1.0 -- rally audit --json --cwd .
```

This exact-version path requires no global installation and makes no project change. When npm needs to download the package, review and accept its normal package-manager confirmation; LaunchRally never bypasses that prompt. After a completed Audit, optional `rally init` separately previews an exact CLI devDependency and lockfile update before asking for confirmation.

For Codex and Claude Plugin installation, controlled updates, uninstallation, and artifact verification, see the [Install and release guide](docs/install.md).

For repository development, use the committed workspace lockfile:

```bash
npm ci
npm run build
npm test
```

For runnable cross-ecosystem examples, use the [Coverage Acceptance Matrix](docs/coverage-acceptance.md). Its JavaScript, non-JavaScript, split, multi-app, and custom fixtures are public demonstrations of the universal Baseline entry path, not a framework or Provider support allowlist.

The first Audit invocation performs a Local Safe Scan and returns a versioned Audit Brief interaction. Unknown release intent becomes typed input, inferred values remain candidates until the builder confirms the complete Check plan, and public or Provider permissions are requested as separate boundaries. Resume tokens preserve repository scope and earlier decisions without repository writes.

After explicit confirmation and permission decisions, the Audit evaluates every Web Baseline Check against its declared severity, release-gate, evidence, freshness, and remediation-order policies. Critical failures are always gating; Major failures gate only under policy with confirmed scope; Moderate failures remain non-gating in Phase 0. Denied permissions and insufficient evidence become explicit Verification Gaps rather than aborting the Audit.

The same deterministic policy result drives both the JSON Record and Markdown View. Current reports are `Launch Ready` when all applicable Checks pass, `Ready with Warnings` for non-gating failures, `No Go` for gating failures, and `Inconclusive` when verification gaps remain. Declared content changes or stale live-state evidence mark affected Evidence Index entries and the Report non-current, in which case it carries no current Launch Assessment. The Action Queue contains only Failed Checks, ordered by severity, dependency-unblocking value, and core-journey impact; Verification Gaps contain only Unverified Checks.

Each completed Audit returns an immutable, time-stamped JSON Report Record, a Markdown Report View generated only from that Record, and a separately versioned Evidence Index. The Record captures its exact scope, permissions, execution disclosure, results, provenance, and limitations. Evidence is content-addressed and referenced by digest and collection metadata; normalized artifacts live in the Index rather than becoming uncontrolled Report content. The complete Audit remains in CLI output and no LaunchRally project file is written until the builder separately previews and confirms `init`.

Save a completed Agent Mode Audit and pass it to `rally init --report <path>`. Initialization displays exact before/after contents, digests, and diffs for every proposed change. Only `--confirm confirm` applies the previewed `.launchrally` Manifest and ignore rules, exact CLI devDependency, and lockfile update. Declining, stale previews, and dependency-planning failures write nothing; interrupted partial writes are rolled back or recovered from the ignored transaction journal on the next `init`. LaunchRally never stages or commits these project-owned files.

Pass the same saved current Audit to `rally plan --report <path>`. The versioned Launch Plan preserves the Report Action Queue order and explains each confirmed Finding, its declared-release impact, investigation locations, remediation guidance, and required Evidence recollection. Verification Gaps remain separate investigation or permission work. Planning performs no source, deployment, Provider, or production mutation. Only an explicit `--handoff` assigns local remediation to the host Agent; it grants no external write authority and directs the builder back to Verify.

`providers` is a supporting advisory operation. It starts only from a supported Failed Check (`rally providers --report <path> --gap <check-id>`) or an existing confirmed Provider role whose Decision Card conflicts with newly confirmed constraints (`--role <role>`). Before showing recommendation brands, it validates and separately confirms budget, scale, region, existing stack, operational ability, and lock-in preference. The resulting `launchrally.dev/provider-guidance/v2` shortlist is advisory, unranked, and deterministic. Each open, versioned Decision Card records capability scope, fit and non-fit contexts, compatibility, operations, lock-in, cost-model caveats, official sources, review date, and explicit Unknowns; it never claims a universal best Provider or live pricing.

Selecting a Card only previews a canonical `.launchrally/manifest.yaml` intent change. A second explicit confirmation records that local intent, replacing only the selected capability role and binding the decision to its source Report and versioned Card so Verify can distinguish it from unrelated Manifest Drift. The selection is not Machine Evidence, never marks a Check Passed, performs no account creation, install, login, provisioning, deployment, or Provider write, and always directs the builder to configure outside LaunchRally and return to Verify. A missing initialized Manifest, a declined selection, or a Manifest changed after preview writes nothing.

After remediation, run `rally verify --report <path> --scope full`. Verify reads the initialized Manifest, discloses fresh public and Provider permission boundaries, and recollects Evidence instead of reusing live observations. Full verification creates a new immutable Report and Evidence Index with an explicit comparison to the source history. Use `--scope targeted --checks '["check.id"]'` for selected Checks; targeted results are explicitly limited and never carry a whole-release Launch Assessment. Manifest/observed-state conflicts are reported as Manifest Drift and never update project intent silently.

Cloudflare and Vercel have versioned, read-only Provider Adapters. Before approval, the Audit discloses the existing CLI executable, exact arguments, target, and allowlisted fields for each Provider. Successful reads become provenance-backed Machine Evidence for the catalog-declared Provider Check; missing tools or authentication and Adapter failures leave that Check Unverified. LaunchRally never installs a Provider tool, initiates login, supplies or retains credentials, or performs Provider writes.

The Local Safe Scan collects provenance-backed facts from supported source and configuration files without retaining their contents in facts or outputs. It respects repository ignore rules and built-in exclusions for dependencies and build outputs, rejects binary and oversized artifacts, never follows symlinks, and stops at nested repository boundaries. Environment files are the deliberate ignore-rule exception: even a gitignored `.env*` file contributes variable names only. Package scripts likewise contribute script names rather than commands, so secret values cannot flow into snapshots, evidence, reports, terminal output, or errors.

## Repository layout

```text
packages/
  contracts/       Public protocol and schema constants
  core/            Framework-neutral discovery, Check Catalog, Decision Cards, and orchestration
  cli/             The `rally` executable
skills/
  launchrally/     Canonical Agent Skill source
adapters/
  codex/           Codex Plugin package
  claude/          Claude Code Plugin package
scripts/
  sync-skills.mjs  Keeps both Plugin copies aligned with the canonical Skill
fixtures/
  coverage/         Cross-ecosystem acceptance representatives
test/
  scaffold.test.js Initial contract and safety tests
```

## Current safety boundary

- No LaunchRally account or server is used.
- `audit` performs a boundary-checked Local Safe Scan and deterministic policy evaluation without repository writes.
- Human Mode explains missing intent and previews the complete plan before permission; Agent Mode exposes versioned typed interaction states.
- Local scan, public verification, and each Provider read are distinct authorization boundaries.
- Local facts include their repository-relative source path and scanner policy version.
- Environment values and raw package script commands are never included in Audit output.
- Approved public probes and Cloudflare/Vercel Adapter reads are bounded, read-only, and retain only normalized evidence.
- Provider guidance reads only the supplied current Report and open local Decision Cards; it contacts no Provider and performs no external mutation.
- Report Records and Evidence Indexes are unique, frozen in-process, and never overwrite repository files.
- `init` is available only from a saved completed Audit and always requires preview confirmation; `plan` is deterministic and read-only from a saved current Audit; `providers` requires constraint confirmation and a second confirmation for local Manifest intent; `verify` creates a new immutable full Report or an explicitly limited targeted result.
- Missing P0 coverage is always reported as a Verification Gap and cannot be treated as Passed or `Launch Ready`.

## Contribution flow

- Open feature and fix pull requests against `dev`.
- Promote releases with a pull request from `dev` to `main`.
- Pull requests into `main` from any other branch are closed automatically.

`dev` is the repository's default branch so new pull requests target it by default.

## License

LaunchRally source, documentation, and public release artifacts are licensed under [Apache-2.0](LICENSE).
