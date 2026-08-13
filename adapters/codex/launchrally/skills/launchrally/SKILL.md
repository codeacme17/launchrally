---
name: launchrally
description: Audit, initialize, plan, and verify production launch readiness for an existing Web repository through the local LaunchRally CLI. Use when a builder asks whether a repo is ready to launch, wants a launch-readiness report, needs a read-only remediation plan or bounded Provider options, or wants to verify changes after remediation.
---

# LaunchRally

Use the local CLI as the only authority for Checks, Evidence, Severity, release gates, Assessments, and Report Records. Act as the interaction and explanation layer; never replace missing Machine Evidence with user or Agent confidence.

## Route the request

- For the complete Audit → optional Init → Read-only Plan → explicit Remediation Handoff → Verify flow, read [references/reference-journey.md](references/reference-journey.md).
- For a first or repeated readiness assessment, read [references/audit.md](references/audit.md).
- For post-report project adoption, read [references/init.md](references/init.md).
- For remediation guidance or Provider choices, read [references/plan.md](references/plan.md).
- For post-remediation evidence collection, read [references/verify.md](references/verify.md).
- Before any network or Provider access, read [references/permissions.md](references/permissions.md).
- When Audit or Verify returns an authenticated Core Journey request, read [references/protected-journeys.md](references/protected-journeys.md).
- When a completed Audit or Verify contains `provider_tool_recoveries`, read [references/provider-tool-recovery.md](references/provider-tool-recovery.md).
- When invoking the CLI or handling its states, read [references/cli-contract.md](references/cli-contract.md).
- When inspecting or exchanging a Phase 1 architecture record, read [references/phase-1-contracts.md](references/phase-1-contracts.md). Contract availability alone does not make a Phase 1 operation executable.
- When a typed `architect` interaction enters Product Intent discovery, read [references/product-intent.md](references/product-intent.md) before presenting semantic-analysis permission or confirmation.
- When presenting a Capability Catalog, derived obligations, a Capability Graph, or an Integration Contract, read [references/capability-model.md](references/capability-model.md).
- When presenting layered capability Evidence, Composite Assurance, or its Launch Assessment, read [references/assurance.md](references/assurance.md).
- When presenting Provider Knowledge, Provider Cards, extensions, or Provider Verification Gaps, read [references/provider-knowledge.md](references/provider-knowledge.md).
- When a typed `architect` interaction enters Blueprint review or decision confirmation, read [references/architect.md](references/architect.md).
- When a typed external Executor handoff is requested from a current Task Graph, read [references/handoff.md](references/handoff.md).

## Preserve these invariants

- CLI installation is a user-managed prerequisite separate from Codex or Claude Plugin installation. Installing or removing a Plugin never installs or removes the Launcher or project-owned data.
- Use only a Launcher and selected Engine declared by the release compatibility matrix. Do not install, update, downgrade, restore, migrate, clean, remove, or substitute either one silently.
- For an explicitly user-selected exact-version npm-exec trial or CI entry, preserve the package manager's download confirmation.
- Treat CLI structured output as canonical. Do not scrape human terminal prose.
- Render Provider tool recovery only from `launchrally.dev/provider-tool-recovery/v1`; use its exact reviewed commands and preserve `continue_with_gap` as the default.
- Confirm material release intent before passing it to the CLI.
- Ask for explicit permission at the boundary requested by the CLI.
- Use only an existing user-managed authenticated host session for approved protected journeys, then return the exact normalized result fields requested by the CLI.
- Never change a Check result, Severity, Gate, Assessment, or immutable Report.
- Keep Phase 0 read-only outside approved local initialization and explicitly confirmed Provider Manifest intent. Never create or modify production resources.
- Present Provider guidance only for the CLI-reported evidenced gap or confirmed constraint mismatch. Never rank a Card as universally best or present its pricing as live.
- Treat a confirmed Provider selection as Manifest intent only. It is not Machine Evidence and remains Unverified until Verify succeeds.
- If the user explicitly requests local code remediation, state that it is a host-Agent task outside LaunchRally controlled Apply guarantees, then return to `verify`.
- Present Verify scope, fresh-read permissions, Manifest Drift, and source comparison exactly as returned; only a full current Report can carry a whole-release Assessment.
- Plugin removal never removes the user-managed Launcher, Project Toolchain, Manifest, Reports, Evidence, or history.
- Treat every external Execution Receipt as a claim, never Machine Evidence. Require fresh environment-bound verification before changing assurance.
- Never generalize Evidence across environments or promote one passed Check layer into a higher assurance layer. Incomplete negative coverage remains Unverified.
- Treat Executor discovery, installation, authentication, authority confirmation, external execution, receipt review, and Verify as separate boundaries. Never infer one from another.
- Treat Provider Knowledge as advisory. Only fresh, reviewed, source-backed Core Catalog or exactly registered Reviewed Extension records may participate in normative recommendations; Local Experimental records never gate release or grant write authority.

## Start safely

1. Resolve the exact repository root without changing files.
2. Make `rally --version --json --cwd <repository-root>` the first discovery operation. Do not probe for or invoke a Project Toolchain Engine directly.
3. If `rally` is absent, explain that CLI installation and Plugin installation are separate, link to the repository's single Install authority, present exactly `npm install --global @launchrally/cli@0.3.2` and the structured verification command, then stop before Audit and wait for the user. Do not run the install, automatically substitute the separate exact-version npm-exec trial/CI entry, or change npm prefixes or shell profiles.
4. Validate the complete version response and `launchrally.dev/execution-authority/v1` object through the compatibility matrix and typed authority router in [references/cli-contract.md](references/cli-contract.md). Plugin, Launcher, selected Engine, and project-pin versions are separate facts and need not be equal when each is supported.
5. For `ready`, invoke every repository operation through `rally` so the Launcher follows the selected Engine. For restore, migrate, or clean, show the exact operation, permissions, targets, and effects and wait for explicit user approval before Agent execution.
6. Invoke Agent Mode with structured output and handle the returned state. Stop on unknown contracts or versions, invalid descriptors or paths, and malformed output.
7. Always disclose scaffold limitations and Verification Gaps.
