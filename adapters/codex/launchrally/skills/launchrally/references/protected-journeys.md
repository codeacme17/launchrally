# Protected Core Journeys

Use this branch only when Audit or Verify returns `request.type: "authenticated_journey_results"` after the separate `authenticated_journey_verification` permission was approved.

## Validate the request

Require these exact contracts:

- Plan: `launchrally.dev/authenticated-journey-plan/v1`
- Adapter: `host-agent-authenticated-journey/v1`
- Operation: `read_only`
- Result: `launchrally.dev/authenticated-journey-results/v1`
- Attestation: `launchrally.dev/authenticated-journey-attestation/v1`

Each planned journey is one exact GET target with a purpose, authentication class, expected status codes, and a declared collection window. Collect only from `collection_not_before` through `collection_not_after`; this binds the observation to the freshly approved permission request. Stop on an unknown field, contract, adapter, operation, method, authentication class, outcome, target, earlier observation, or expired window. The completion criterion is one typed result for every disclosed `journey_id`, with no duplicate or undisclosed ID.

## Use the host session

Use an already-active, user-managed authenticated browser or host session only when it can exercise the exact disclosed target and capability. Keep authentication material inside that session. The shipped host runner accepts only an absolute reference to a host-owned, owner-restricted authentication file; never place its value in a command, argument, or Agent-authored environment value. Return only the disclosed `journey_id`, `status`, `outcome`, `status_code`, and `collected_at` fields to the host adapter integration.

The read boundary excludes login automation, credential prompts, privilege changes, session export, storage inspection, token construction, and redirects to an undisclosed target. Return a typed gap when the existing session cannot satisfy the disclosed capability:

| Condition | `status` | `outcome` | `status_code` |
| --- | --- | --- | --- |
| Expected authenticated response | `passed` | `completed` | Observed expected code |
| No active authentication | `unverified` | `missing_authentication` | `null` |
| Host lacks the required account capability | `unverified` | `insufficient_capability` | `null` |
| Existing authentication expired | `unverified` | `expired_authentication` | `null` |
| No safe host runner is available | `unverified` | `runner_unavailable` | `null` |
| Authenticated request returns a 4xx denial | `failed` | `unexpected_denial` | Observed 4xx code |
| Request returns a redirect | `failed` | `redirect` | Observed 3xx code |
| Disclosed read times out | `failed` | `timeout` | `null` |
| Safe execution otherwise fails | `failed` | `execution_failure` | `null` |

The host adapter integration must attach and independently verify a content-bound `launchrally.dev/authenticated-journey-attestation/v1` record before Core can qualify Evidence. The Agent must never create, copy, edit, or claim that attestation. If the host integration is unavailable or rejects the attestation, Core records `unsupported_adapter` as a Verification Gap and creates no Evidence.

Core, not the host Agent, decides Evidence qualification. A host-attested normalized `passed` or `failed` result collected inside the permission window becomes `launchrally.dev/authenticated-journey-evidence/v1` Machine Evidence with exact adapter, target, permission, collection-window, and attestation provenance. A qualifying failure can support a gating Failed Check and `no_go`. The four authenticated `unverified` results remain typed Verification Gaps and create no Evidence. Agent prose, a user assertion, an Execution Receipt, an unattested JSON payload, or an out-of-window result never substitutes for collection Evidence.

Set `collected_at` to the observation time in ISO 8601 UTC form. Pass only this normalized observation to the host integration:

```json
{
  "schema_version": "launchrally.dev/authenticated-journey-results/v1",
  "adapter_version": "host-agent-authenticated-journey/v1",
  "results": [
    {
      "journey_id": "target-1:journey-1:authenticated",
      "status": "passed",
      "outcome": "completed",
      "status_code": 200,
      "collected_at": "2026-08-12T06:00:00.000Z"
    }
  ]
}
```

The host integration—not Agent-authored shell JSON—must add the verified attestation and resume the exact operation. A plain `--journey-results '<json>'` submission is intentionally non-normative and produces an `unsupported_adapter` Gap. Treat CLI validation errors as a request to correct the normalized shape; never add cookies, authorization headers, bearer values, session IDs, storage values, credentials, response headers, response bodies, account identifiers, or prose.
