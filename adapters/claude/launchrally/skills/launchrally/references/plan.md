# Plan

Save the complete current Agent Mode Audit JSON and invoke `rally plan --report <path> --json`. Planning is unavailable without a complete current Report and never requires prior initialization.

Treat the versioned `launchrally.dev/launch-plan/v2` result as canonical. Preserve the Report Action Queue order. Each `items` entry explains the confirmed Finding, its declared-release impact, investigation inputs and Evidence targets, remediation guidance, and the exact Evidence kinds and freshness behavior to recollect. The disclosed priority basis is severity, dependency-unblocking value, then core-journey impact.

Keep `verification_gaps` separate from confirmed Finding work. A Gap has `confirmed_fix: false` and is classified as investigation or permission work. Never convert it into a remediation item or infer that missing Evidence proves a defect.

Planning is read-only: `effects` must disclose no source, deployment, Provider, or production mutation. The same applicable Report produces the same plan data without generated timestamps.

Remediation Handoff occurs only after the user explicitly asks the host Agent to perform local remediation. Invoke `--handoff` only for that request. The handoff names the host Agent as owner, grants no Provider, deployment, or production write permission, limits work to confirmed Findings, and directs the builder back to Verify for fresh Evidence and a new Report.

Provider options use a separate, bounded CLI workflow. Start only from a supported Failed Check in the current Report with `rally providers --report <path> --gap <check-id> --json`, or evaluate a current confirmed Provider role with `--role <role>`. Do not invoke either path for generic greenfield architecture generation. A role path that has no confirmed constraint mismatch completes without disclosing alternatives.

On `needs_input`, answer all six typed constraints: budget, scale, region, existing stack, operational ability, and lock-in preference. On `needs_confirmation`, present the normalized constraint set and pass `confirm`, `revise`, or `cancel` exactly. Provider brands remain hidden until this confirmation.

Treat the resulting `launchrally.dev/provider-guidance/v2` shortlist as advisory and unranked. State the capability first. For every option, preserve the Card's reasons, limits, compatibility, operations, lock-in, cost-model caveats, official sources, review date, and explicit Unknowns. Never claim a universal best Provider or guaranteed live pricing.

Pass `--select <card-id>` only after the builder chooses. Selection requires an initialized Launch Manifest and returns an exact local intent preview. Pass the second `--confirm confirm` only after the builder approves that preview; use `decline` otherwise. Confirmation changes only local Manifest Provider intent. It performs no account creation, tool installation, login, provisioning, deployment, or Provider write.

A selected Provider is not Machine Evidence, cannot become Passed from guidance, and remains Unverified until configuration is completed outside LaunchRally and `verify` recollects successful evidence.

When a confirmed immutable Architecture Package is available, add `--architecture-package <bundle-json>` to `rally plan`. The result keeps the existing Launch Plan fields unchanged and adds `task_graph`. Each Task preserves exactly one source meaning: confirmed Finding, Verification Gap, unresolved Architecture decision, or implementation work. Present its environment, prerequisites, effect class, expected target, allowed and prohibited effects, recovery notes, minimum Executor capability, Evidence targets, cancellation behavior, and follow-up Verify request. Desired effects are Provider-neutral and do not select or authorize an Executor.

Treat `ready_frontier` as the only safe work frontier. To recompute after cancellation or a partial result, pass the prior graph with `--task-graph <task-graph-json>` and typed updates with `--task-updates <json>`. `reported_succeeded` is only an external claim and never means `verified`; an effectful dependent remains blocked until a fresh Report supplies current matching Evidence for a typed `verified` update. A stale graph has an empty frontier and requires current Report/Architecture inputs rather than execution.

Executor mapping is separate from Task generation. The same generic Task can match multiple compatible managed Executors or remain a manual/custom procedure. A match grants no installation, login, credential handling, Provider write, deployment, or production authority; #132 owns any future explicit Handoff Package and approval boundary.
