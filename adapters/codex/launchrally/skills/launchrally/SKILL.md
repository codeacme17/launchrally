---
name: launchrally
description: Audit, initialize, plan, and verify production launch readiness for an existing Web repository through the local LaunchRally CLI. Use when a builder asks whether a repo is ready to launch, wants a launch-readiness report, needs a read-only remediation plan or bounded Provider options, or wants to verify changes after remediation.
---

# LaunchRally

Use the local CLI as the only authority for Checks, Evidence, Severity, release gates, Assessments, and Report Records. Act as the interaction and explanation layer; never replace missing Machine Evidence with user or Agent confidence.

## Route the request

- For a first or repeated readiness assessment, read [references/audit.md](references/audit.md).
- For post-report project adoption, read [references/init.md](references/init.md).
- For remediation guidance or Provider choices, read [references/plan.md](references/plan.md).
- For post-remediation evidence collection, read [references/verify.md](references/verify.md).
- Before any network or Provider access, read [references/permissions.md](references/permissions.md).
- When invoking the CLI or handling its states, read [references/cli-contract.md](references/cli-contract.md).

## Preserve these invariants

- Use an exact compatible CLI version. Do not install or upgrade it silently.
- Treat CLI structured output as canonical. Do not scrape human terminal prose.
- Confirm material release intent before passing it to the CLI.
- Ask for explicit permission at the boundary requested by the CLI.
- Never change a Check result, Severity, Gate, Assessment, or immutable Report.
- Keep Phase 0 read-only outside approved local initialization and explicitly confirmed Provider Manifest intent. Never create or modify production resources.
- Present Provider guidance only for the CLI-reported evidenced gap or confirmed constraint mismatch. Never rank a Card as universally best or present its pricing as live.
- Treat a confirmed Provider selection as Manifest intent only. It is not Machine Evidence and remains Unverified until Verify succeeds.
- If the user explicitly requests local code remediation, state that it is a host-Agent task outside LaunchRally controlled Apply guarantees, then return to `verify`.
- Present Verify scope, fresh-read permissions, Manifest Drift, and source comparison exactly as returned; only a full current Report can carry a whole-release Assessment.

## Start safely

1. Resolve the exact repository root without changing files.
2. Check for a project-pinned compatible CLI.
3. If absent, disclose the exact package, version, source, and command before proposing `npm exec`.
4. Preserve the package manager's download confirmation.
5. Invoke Agent Mode with structured output and handle the returned state.
6. Always disclose scaffold limitations and Verification Gaps.
