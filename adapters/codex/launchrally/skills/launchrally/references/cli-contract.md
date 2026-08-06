# CLI interaction contract

Invoke Agent Mode with `--json`. Read the `contract`, `status`, and `operation` fields before interpreting any payload.

Audit interaction statuses:

- `needs_input`: answer only the typed fields in `request.fields`, then resume with the returned token.
- `needs_confirmation`: present the complete `audit_brief`, `planned_checks`, and `authorization_plan`; pass `confirm`, `revise`, or `cancel` without inference.
- `needs_permission`: present each entry in `request.permissions` separately and return an explicit `approved` or `denied` decision for each permission ID.
- `completed`: the requested operation completed within its disclosed limitations.
- `unavailable`: a prerequisite such as a complete first Report has not been supplied.
- `not_implemented`: the command is reserved but unavailable in the scaffold.
- `execution_error`: the CLI could not execute the operation.

Read `contract`, `status`, `operation`, and `interaction.schema_version` before the state payload. Preserve `interaction.resume_token` verbatim. A token is repository-root scoped and retains confirmed scope and prior permission decisions; resume errors require a new Audit rather than reconstructed state.

Do not collapse a Check failure, denied permission, missing Evidence, and execution error into one result. A denied permission completes as an explicit Verification Gap. A passing implemented Check does not override incomplete P0 coverage.

Initialization interaction uses `launchrally.dev/init-interaction/v1`. Read the exact `preview.changes`, preserve `interaction.resume_token`, and return only `confirm` or `decline`. Never infer approval from a completed Audit.

Planning uses `launchrally.dev/launch-plan/v1`. Supply a saved complete current Audit with `--report`. Read `items` in rank order and keep `verification_gaps` separate. Confirm `read_only` and every `effects` value before presenting the Plan. Pass `--handoff` only after an explicit user request for host-Agent local remediation; the handoff grants no Provider, deployment, or production write permission and always returns to Verify.
