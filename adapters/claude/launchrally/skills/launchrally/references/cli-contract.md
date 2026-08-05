# CLI interaction contract

Invoke Agent Mode with `--json`. Read the `contract`, `status`, and `operation` fields before interpreting any payload.

Initial statuses:

- `completed`: the requested operation completed within its disclosed limitations.
- `not_implemented`: the command is reserved but unavailable in the scaffold.
- `execution_error`: the CLI could not execute the operation.

Future Phase 0 states will add explicit input, scope-confirmation, and permission requests. Do not collapse a Check failure, denied permission, missing Evidence, and execution error into one result.

The initial Audit result includes an `initial_readiness_snapshot` and a versioned Report Record. Interpret `results.checks`, `results.verification_gaps`, `results.coverage_summary`, and `limitations` together; a passing implemented Check does not override incomplete P0 coverage.
