# CLI interaction contract

Invoke Agent Mode with `--json`. Require `contract: "launchrally.dev/cli/v2"`, then read `status` and `operation` before interpreting any payload. When `interaction` is present, read `interaction.schema_version` before its state payload and require the exact supported schema for that operation. Stop on an unknown contract, operation, status, or schema version. Never parse or branch on Human Mode terminal prose.

## State router

Use this router for every operation. Operation-specific sections below constrain which fields and response values are valid.

| `status` | Required handling |
| --- | --- |
| `needs_input` | Present only typed fields from the structured request, collect the user's answers, and resume with those answers. Never fill a material release fact silently. |
| `needs_confirmation` | Present the exact structured preview and only offer the response values declared by that operation. Never infer confirmation. |
| `needs_permission` | Present every structured permission separately and resume with an explicit decision for each permission ID. Never reuse earlier permission for a fresh-read boundary. |
| `needs_refresh` | Present the typed reason, then run the exact `request.operation` and `request.scope` against the Manifest-bound source Report. Use the refreshed full Report only for the blocked Plan or Handoff operation. |
| `completed` | Validate the operation's versioned result shape and explain it without changing its Checks, Evidence, policy, Report, or Assessment. |
| `unavailable` | Stop the operation and present the structured prerequisite or reason. Do not synthesize the missing input. |
| `execution_error` | Stop and present the structured error. Do not reinterpret it as a Check failure or reconstruct interaction state. |

Preserve `interaction.resume_token` verbatim. A token is repository-root scoped and retains confirmed scope and prior permission decisions; resume errors require a new operation rather than reconstructed state.

Do not collapse a Check failure, denied permission, missing Evidence, and execution error into one result. A denied permission completes as an explicit Verification Gap. A passing implemented Check does not override incomplete P0 coverage.

Audit interaction uses `launchrally.dev/audit-interaction/v1`. For `needs_input`, answer only `request.fields`. For `needs_confirmation`, present the complete `audit_brief`, `planned_checks`, and `authorization_plan`; pass only `confirm`, `revise`, or `cancel`. For `needs_permission`, return only explicit `approved` or `denied` decisions for the requested permission IDs.

The v2 JSON contract keeps `production_targets` as a compatibility field. Treat its values as the confirmed public targets for `intended_environment`, not as proof that the environment is production. When rendering structured data, use the reviewed environment label when available and `confirmed target` when it is not.

Initialization interaction uses `launchrally.dev/init-interaction/v2`. Require `interaction.source_report.role: "manifest_source"`, match its `report_id` to the saved immutable Report package, and retain that package for every whole-release Verify. If isolated toolchain resolution misses the offline npm cache, present the sole `npm_registry_read` permission with its exact package, version, registry source, and command; resume with only `approved` or `denied`. Registry approval does not confirm file changes. After resolution, read the exact `preview.changes`, preserve `interaction.resume_token`, and return only `confirm` or `decline`. Never infer either permission or confirmation from a completed Audit.

Planning uses `launchrally.dev/launch-plan/v2`. Supply a saved complete current Audit with `--report`. Read `items` in rank order and keep `verification_gaps` separate. Confirm `read_only` and every `effects` value before presenting the Plan. Pass `--handoff` only after an explicit user request for host-Agent local remediation; the handoff grants no Provider, deployment, or production write permission and always returns to Verify.

`providers` is a supporting advisory operation. It uses `launchrally.dev/provider-guidance-interaction/v1`, versioned Cards, and `launchrally.dev/provider-guidance/v2`. Start from the CLI's supported Failed Check or current Provider-role path. Preserve the constraint-first states and do not disclose recommendation brands before `constraint_confirmation` receives `confirm`. A shortlist uses Card-ID ordering, not a best-Provider rank. Pass `--select` only for an offered Card, present the exact Manifest intent preview, and require a second `confirm` or `decline`. A completed selection has `machine_evidence: false`, `verification_status: unverified`, and `passed: false`; follow its required `verify` next step.

Verification uses `launchrally.dev/verify-interaction/v2` and completes as `launchrally.dev/verification-result/v2`. For every whole-release Verify, supply the saved Report matching `interaction.source_report.report_id` and require its role to be `manifest_source`. A completed full Verify exposes the newly generated latest current Report as `interaction.current_report`; use that Report for Plan and Handoff, never as the input to a repeated whole-release Verify. Present `verification_scope`, each fresh permission, `assessment_scope`, `manifest_drift`, `history`, and `comparison` without reinterpretation. A full result includes a new Report v2 and Evidence Index. A targeted result includes `targeted_result`, carries no Report, and has a null whole-release Assessment. Historical Report v1 packages remain readable inputs; new runs produce Report v2.
