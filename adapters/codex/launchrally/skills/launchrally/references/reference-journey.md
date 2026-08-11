# Reference Journey

Use this flow when the user wants to complete Audit, optional Init, Read-only Plan, explicit Remediation Handoff, and Verify. The same flow applies in the Codex and Claude Plugin adapters; host metadata changes discovery only, never LaunchRally semantics.

## Discover the Launcher and execution authority

The user-managed `rally` Launcher is a prerequisite separate from the Codex or Claude Plugin. Make `rally --version --json --cwd <repository-root>` the first discovery operation. Never discover or invoke a Project Toolchain Engine directly.

If `rally` is absent, present these exact user-managed commands, stop before Audit, and wait:

```bash
npm install --global @launchrally/cli@0.3.0
rally --version --json --cwd <repository-root>
```

Do not run the installation, automatically switch to npm-exec, use `sudo`, alter the npm prefix, or modify a shell profile. An exact-version npm-exec trial/CI entry remains a separate explicit user choice, never a fallback inferred from missing `rally`. CLI installation grants no Provider, deployment, production, credential, or application-source write authority.

Require `contract: "launchrally.dev/cli/v2"`, keep `launcher_version` separate from the selected `cli_version`, and validate the response against the compatibility matrix and authority router in [cli-contract.md](cli-contract.md). A `ready` authority follows the selected Engine through the Launcher even when the supported Plugin, Launcher, and Engine versions differ. `needs_toolchain_restore` and `needs_toolchain_migration` stop the requested operation until the exact lifecycle action receives explicit user approval. `invalid_toolchain` always stops. Never substitute the Plugin or Launcher version for a valid project pin.

For every command below, use `--json`, read only the versioned structured interaction, and follow the state router in [cli-contract.md](cli-contract.md). The native adapters ship compatibility, installation verification, authority and lifecycle routing, and the exact journey invocation order in [reference-journey.json](reference-journey.json); treat its arguments and guards as the machine-readable companion to this explanation. Never parse terminal prose.

Keep two Report identities separate after Init:

- The **Manifest-bound source Report** is immutable. Init and every whole-release Verify use this Report. Read its typed identity from `interaction.source_report`.
- The **latest current Report** is the newest current full Verify result. Plan and Handoff use this Report. Read its typed identity from `interaction.current_report`, then match that ID to the saved immutable result.

When the CLI returns `needs_refresh`, run its typed full Verify request with the Manifest-bound source Report. Preserve that source Report for later whole-release Verify runs, and replace only the blocked Plan or Handoff input with the refreshed latest current Report.

## 1. Audit

Run `rally audit --json --cwd <repository-root>`. Confirm all inferred release facts with the user through the returned typed states. Ask separately for every permission requested by the CLI. Preserve resume tokens exactly and save the completed Audit JSON unchanged. When Init binds that Report to the Manifest, retain it as `<manifest-source-report-json>` for every later whole-release Verify.

Explain the CLI's Checks, Evidence, policy, Verification Gaps, and final Assessment without reclassifying them. Missing or denied Evidence remains a Gap. Neither the host model nor this Skill may manufacture Evidence or independently mark a Check Passed.

## 2. Optional Init

Offer Init only after a complete Audit and only if the user wants project adoption. Run `rally init --json --cwd <repository-root> --report <manifest-source-report-json>`. Require `interaction.source_report.role: "manifest_source"` and preserve the saved Report whose `report.report_id` matches `interaction.source_report.report_id`. Init uses the committed `.launchrally/toolchain` npm package and lockfile for every ecosystem and never changes application dependencies. It attempts offline resolution first. If the result is `needs_permission`, present the exact `npm_registry_read` package, version, `https://registry.npmjs.org` source, and lifecycle-script-disabled command, then resume with the user's explicit decision. Registry approval does not approve file changes. Present every exact local change in `preview.changes`, and apply it only after the user explicitly confirms the returned interaction. Declining Init or denying registry access leaves the repository unchanged and does not block Plan.

Init is the only LaunchRally-controlled mutation in this journey. It is local, bounded to its preview, and grants no deployment, production, or Provider write authority. Its confirmed dependency and Manifest changes make the Manifest-bound source Report historical; follow the typed `needs_refresh` response with full Verify. Retain the source Report for future whole-release Verify runs, and use the new `interaction.current_report` Report only for Plan and Handoff.

After Init, run `rally --version --json --cwd <repository-root>` again and require a `ready` response with `authority.source: "project_toolchain"`. Then invoke Plan, Handoff, and Verify through `rally`; the Launcher delegates to the validated project pin, and the Plugin and bundled Launcher Engine are not substitutes.

## 3. Read-only Plan

Run `rally plan --json --cwd <repository-root> --report <current-report-json>` without `--handoff`. Present ranked items and Verification Gaps separately, preserving their Check IDs, Severity, gate effects, Evidence targets, and Report semantics. Require `read_only: true` and `none` for every returned mutation effect.

Provider Decision Guidance is optional and advisory. Decision Cards, third-party Skills, host-model output, and user statements are never Provider Evidence and cannot change a Check, Severity, gate, Report, or Assessment. Only the CLI may record confirmed local Manifest intent; it still remains Unverified until Verify collects acceptable Evidence.

## 4. Explicit Remediation Handoff

Run the Plan again with `--handoff` only after the user explicitly asks the host Agent to remediate local code: `rally plan --json --cwd <repository-root> --report <current-report-json> --handoff`. Explain that the handoff assigns local implementation to the host Agent outside LaunchRally controlled Apply guarantees. It grants no Provider, deployment, production, secret, or network-write permission.

After the host Agent changes local code, do not claim the Findings are fixed. Return to the CLI for Verify.

## 5. Verify

Run `rally verify --json --cwd <repository-root> --report <manifest-source-report-json> --scope full` for a whole-release reassessment. Require `interaction.source_report.role: "manifest_source"`, and require its `report_id` to match the supplied saved Report. Do not pass `<current-report-json>` to whole-release Verify. If the user explicitly requests a bounded check subset, use targeted scope and the exact Check IDs instead. Present each fresh permission request and preserve every denial as a Verification Gap.

Explain `verification_scope`, Manifest Drift, Evidence, history, comparison, policy currentness, and Assessment exactly as returned. A targeted result has no whole-release Assessment. Only a full, current CLI Report may carry the final whole-release Assessment.

## Offline and account boundary

The local journey requires no LaunchRally account and no private LaunchRally service. If public or Provider Evidence requires network access, the CLI must request it explicitly; denial completes with the corresponding Gap. Never send repository contents or secrets to an undisclosed service.
