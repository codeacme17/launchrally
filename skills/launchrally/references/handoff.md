# External Executor handoff

Start only from a valid current `launchrally.dev/task-graph/v1` and its `ready_frontier`. Invoke Agent Mode with the exact reviewed discovery inputs:

```bash
rally handoff --json --task-graph <task-graph-json> --executors <executor-descriptors-json> --tools <tool-observations-json> --reviewed-executors <reviewed-executors-json>
```

Require `launchrally.dev/handoff-interaction/v1`. Preserve the opaque resume token across invocations. Never edit or reconstruct stored state, a Descriptor digest, a candidate batch, or a Handoff Package from terminal prose.

Present each candidate's environment, Tasks, effect class, target, exact tools, authentication assumptions and their unverified state, secret-reference handling, cancellation behavior, partial-failure semantics, availability, and narrowest-match recommendation. An available executable does not prove authentication. An unavailable tool or platform is not permission to install, update, downgrade, authenticate, request credentials, or invoke anything. Show installation commands only when returned from the reviewed exact-version authority; label them user-managed and do not execute them. Preserve manual/custom, defer, and cancel choices.

Resume selection with `--select <batch-id>`. Present the complete versioned Handoff Package, including its exact Task and Executor references, allowed and prohibited effects, target, environment, retention boundary, and `approval.state: required`. Resume with `--confirm confirm` only after the user explicitly approves this package; use `deny` or `cancel` otherwise. Approval does not mean LaunchRally executed external work.

Accept a receipt only from an external Executor through `--receipt <execution-receipt-json>`. Reject raw stdout, stderr, response bodies, credentials, secrets, business payloads, and real-user data; claim codes are restricted to the reviewed normalized vocabulary. Keep every receipt state as a claim and every generated Task update below `verified`. For partial failure or cancellation, preserve `execution_outcomes.receipt_state` and its structured remaining work; reject a partial receipt from an all-or-nothing Executor. On `fresh_verification`, choose `verify` to begin an independent targeted Verify, or preserve `defer` or `cancel`. Never convert receipt claims into Evidence.

If the Task Graph becomes stale, a Descriptor or reviewed installation authority expires, a binding changes, or resume state is unavailable, stop and restart discovery from current inputs. Installing a Skill, Plugin, CLI, MCP server, or Executor never implies Provider, deployment, secret, production-data, active-test, or repository-write authority.
