# Plan

Save the complete current Agent Mode Audit JSON and invoke `rally plan --report <path> --json`. Planning is unavailable without a complete current Report and never requires prior initialization.

Treat the versioned `launchrally.dev/launch-plan/v1` result as canonical. Preserve the Report Action Queue order. Each `items` entry explains the confirmed Finding, its declared-release impact, investigation inputs and Evidence targets, remediation guidance, and the exact Evidence kinds and freshness behavior to recollect. The disclosed priority basis is severity, dependency-unblocking value, then core-journey impact.

Keep `verification_gaps` separate from confirmed Finding work. A Gap has `confirmed_fix: false` and is classified as investigation or permission work. Never convert it into a remediation item or infer that missing Evidence proves a defect.

Planning is read-only: `effects` must disclose no source, deployment, Provider, or production mutation. The same applicable Report produces the same plan data without generated timestamps.

Remediation Handoff occurs only after the user explicitly asks the host Agent to perform local remediation. Invoke `--handoff` only for that request. The handoff names the host Agent as owner, grants no Provider, deployment, or production write permission, limits work to confirmed Findings, and directs the builder back to Verify for fresh Evidence and a new Report.

Provider options are advisory. State the capability requirement first, then use confirmed budget, scale, region, stack, operational tolerance, and lock-in preferences. Never treat a recommendation as Machine Evidence or authority to provision resources.
