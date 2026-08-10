# Reference Journey

Use this flow when the user wants to complete Audit, optional Init, Read-only Plan, explicit Remediation Handoff, and Verify. The same flow applies in the Codex and Claude Plugin adapters; host metadata changes discovery only, never LaunchRally semantics.

## Pin the execution authority

The required executable is exactly `@launchrally/cli@0.2.1`. Prefer a project-pinned executable. If it is absent, disclose the package, version, registry source, and proposed `npm exec --package=@launchrally/cli@0.2.1 -- rally` command, then preserve the package manager's download confirmation.

Before Audit or any other journey command, invoke the selected executable as `rally --version --json`. Continue only when the structured response has `contract: "launchrally.dev/cli/v2"`, `operation: "version"`, `status: "completed"`, and `cli_version: "0.2.1"`. Stop and explain a missing executable, invalid structured response, or version mismatch. Do not silently install, upgrade, downgrade, or substitute another CLI.

For every command below, use `--json`, read only the versioned structured interaction, and follow the state router in [cli-contract.md](cli-contract.md). The native adapters ship the exact invocation order and expected structured states in [reference-journey.json](reference-journey.json); treat its arguments as the machine-readable companion to this explanation. Never parse terminal prose.

When the CLI returns `needs_refresh`, run its typed full Verify request and replace the blocked operation's input with the refreshed Report before continuing.

## 1. Audit

Run `rally audit --json --cwd <repository-root>`. Confirm all inferred release facts with the user through the returned typed states. Ask separately for every permission requested by the CLI. Preserve resume tokens exactly and save the completed Audit JSON unchanged; it is the immutable source Report package for later steps.

Explain the CLI's Checks, Evidence, policy, Verification Gaps, and final Assessment without reclassifying them. Missing or denied Evidence remains a Gap. Neither the host model nor this Skill may manufacture Evidence or independently mark a Check Passed.

## 2. Optional Init

Offer Init only after a complete Audit and only if the user wants project adoption. Run `rally init --json --cwd <repository-root> --report <audit-json>`. Init uses the committed `.launchrally/toolchain` npm package and lockfile for every ecosystem and never changes application dependencies. It attempts offline resolution first. If the result is `needs_permission`, present the exact `npm_registry_read` package, version, `https://registry.npmjs.org` source, and lifecycle-script-disabled command, then resume with the user's explicit decision. Registry approval does not approve file changes. Present every exact local change in `preview.changes`, and apply it only after the user explicitly confirms the returned interaction. Declining Init or denying registry access leaves the repository unchanged and does not block Plan.

Init is the only LaunchRally-controlled mutation in this journey. It is local, bounded to its preview, and grants no deployment, production, or Provider write authority. Its confirmed dependency and Manifest changes make the immutable Audit Report historical; follow the typed `needs_refresh` response with full Verify and use that new current Report for Plan.

## 3. Read-only Plan

Run `rally plan --json --cwd <repository-root> --report <current-report-json>` without `--handoff`. Present ranked items and Verification Gaps separately, preserving their Check IDs, Severity, gate effects, Evidence targets, and Report semantics. Require `read_only: true` and `none` for every returned mutation effect.

Provider Decision Guidance is optional and advisory. Decision Cards, third-party Skills, host-model output, and user statements are never Provider Evidence and cannot change a Check, Severity, gate, Report, or Assessment. Only the CLI may record confirmed local Manifest intent; it still remains Unverified until Verify collects acceptable Evidence.

## 4. Explicit Remediation Handoff

Run the Plan again with `--handoff` only after the user explicitly asks the host Agent to remediate local code: `rally plan --json --cwd <repository-root> --report <current-report-json> --handoff`. Explain that the handoff assigns local implementation to the host Agent outside LaunchRally controlled Apply guarantees. It grants no Provider, deployment, production, secret, or network-write permission.

After the host Agent changes local code, do not claim the Findings are fixed. Return to the CLI for Verify.

## 5. Verify

Run `rally verify --json --cwd <repository-root> --report <current-report-json> --scope full` for a whole-release reassessment. If the user explicitly requests a bounded check subset, use targeted scope and the exact Check IDs instead. Present each fresh permission request and preserve every denial as a Verification Gap.

Explain `verification_scope`, Manifest Drift, Evidence, history, comparison, policy currentness, and Assessment exactly as returned. A targeted result has no whole-release Assessment. Only a full, current CLI Report may carry the final whole-release Assessment.

## Offline and account boundary

The local journey requires no LaunchRally account and no private LaunchRally service. If public or Provider Evidence requires network access, the CLI must request it explicitly; denial completes with the corresponding Gap. Never send repository contents or secrets to an undisclosed service.
