# Phase 1 Agent and Human journey

Phase 1 extends LaunchRally's Stable Phase 0 readiness audit with Product Intent, Provider-neutral Architecture, a Task Graph, bounded external Executor coordination, and independent verification. Phase 1 is a separate experimental product layer: its presence does not relabel the Phase 0 release state or make Phase 1 Validated or Stable.

This guide assumes the exact Launcher is already installed and `rally --version --json --cwd ./app` returns a supported `launchrally.dev/execution-authority/v1`. Run the examples from a private working directory whose `./app` child is the repository; save structured records beside `./app`, outside the scanned repository and version control. The filenames are placeholders for validated records produced by the preceding typed state, not templates to author by hand.

## Before granting authority

LaunchRally separates four boundaries so a builder can decide before anything happens:

- **Read:** Audit, Architect, and Verify disclose local, network, Provider, protected-journey, or active-test reads separately. A previous approval is not permission for a fresh read.
- **Persist:** pre-Init Audit creates no project record, and a pre-Init Architecture Package is output-only unless the builder selects a path. Starting Architect or Handoff does automatically persist encrypted resumable interaction state in the owner-only host registry outside the repository; it does not persist a Package, Report, or project history. Confirmed Init, full Verify, Phase 1 adoption, and Architecture Package persistence preview exact LaunchRally-owned project paths. LaunchRally does not stage or commit them.
- **Ask an external Executor to write:** a Handoff Package names the exact environment, Tasks, target, allowed and prohibited effects, Executor digest, authentication assumptions, cancellation behavior, and retention boundary. It needs independent confirmation. LaunchRally coordinates the request; Core performs no Provider or deployment write.
- **Fresh Verify:** an external receipt remains a claim. Agent confidence and Provider configuration are also non-Evidence: configuration does not prove operational delivery or a business outcome. Only fresh qualifying Evidence for the exact environment can change verification or assurance.

## 1. Confirm Product Intent

Product Intent discovery works with a PRD, with incomplete product materials, or without a PRD. It is currently a typed installed-host API, not a standalone public CLI subcommand. Codex imports `runCodexProductIntentDiscovery` from `@launchrally/codex-plugin/product-intent`; Claude imports `runClaudeProductIntentDiscovery` from `@launchrally/claude-plugin/product-intent`. Each accepts `(repositoryRoot, options)` and delegates to Core's versioned `runProductIntentDiscovery` interaction. Without product material, omit `selected_materials`; Core uses normalized Local Safe Scan facts and returns `needs_input`. With selected material, pass only explicit repository-relative text paths; Core returns `needs_permission` for `local_semantic_analysis` before reading them and discloses coverage, exclusions, and retention.

The host resumes with the exact opaque token and `permission_decision: "approved"` or `"denied"`, answers only the returned fields (`intended_environment`, `confirmed_behaviors`, `hard_constraints`, and `preferences`), presents the complete unconfirmed preview, and resumes with `confirmation: "confirm"`, `"revise"`, or `"cancel"`. Only the completed confirmed Product Intent Profile may become Architect input. Denied or incomplete material stays explicit in coverage and cannot prove absence.

Observed implementation, inferred behaviors, and confirmed intent stay separate. Incomplete or denied semantic coverage cannot prove a feature is absent. Review the complete Product Intent preview, resolve conflicts, and distinguish hard constraints from preferences. A hard constraint excludes incompatible options; a preference influences trade-offs but is not silently promoted to a constraint.

## 2. Review capabilities and architecture

The Capability Catalog defines Provider-neutral obligations. The Capability Graph records whether each capability is required, optional, deferred, not applicable, or unknown for the current or a future release. Integration Contracts bind endpoints, mode, authentication, privacy, idempotency, retry, failure visibility, and success Evidence without making Provider brands part of product semantics.

The Blueprint explains implementation paths, constraints, compatibility, cost drivers, operational burden, failure domains, lock-in, exit and migration costs, Unknowns, and reevaluation triggers. Recommendations are Provider-neutral fits under confirmed constraints, not universal rankings. Provider examples such as Clerk or Supabase Auth are explicitly non-canonical illustrations; custom, self-hosted, retained, and unknown Provider paths remain valid and receive honest support depth.

Architecture currentness is derived from exact Report, intent, catalog, Integration Contract, Provider Knowledge, constraints, and decision dependencies. A stale dependency produces reassessment rather than rewriting history or invalidating unrelated Evidence.

If the builder does not know whether a Provider is operated through a CLI, Skill, MCP server, dashboard, or manual procedure, keep that fact Unknown. Discovery may expose reviewed candidates and prerequisites, but it does not authorize installation, login, or execution and must not invent support for an unavailable interface.

### architect

POSIX shell:

```bash
rally architect --json --cwd ./app --review-date 2026-08-14 \
  --report ./launchrally-current-report.json \
  --intent ./product-intent.json \
  --catalog ./capability-catalog.json \
  --graph ./capability-graph.json \
  --integrations ./integration-contracts.json
```

PowerShell:

```powershell
rally architect --json --cwd ./app --review-date 2026-08-14 `
  --report ./launchrally-current-report.json `
  --intent ./product-intent.json `
  --catalog ./capability-catalog.json `
  --graph ./capability-graph.json `
  --integrations ./integration-contracts.json
```

Replace the example `2026-08-14` with the actual `YYYY-MM-DD` date on which the Architecture inputs and sources were reviewed. It is provenance, not a floating current date or a value to copy without review. Handle every returned `needs_confirmation` or `partial_completion` state through its typed request. Never invent a resume token or decision response. An initialized Phase 0 project first receives an additive Phase 1 migration preview; denial or interruption preserves Phase 0 bytes.

Success continues with `rally architect --json --cwd ./app --resume <token> --confirm confirm`, then submits only returned pending decision IDs through `--decisions <json>`. Use `--confirm reject` or `--confirm cancel` at Blueprint review. A stale source returns `stale_input`; refresh the changed source rather than resuming it.

## 3. Build the Task Graph

Plan combines the current Report with the confirmed Architecture Package. Each Task retains exactly one meaning: confirmed Finding, Verification Gap, unresolved Architecture decision, or implementation work. Task states, prerequisites, desired effect, expected target, allowed and prohibited effects, cancellation behavior, remaining work, and Evidence targets remain explicit. Only `ready_frontier` is eligible for work.

### plan

POSIX shell:

```bash
rally plan --json --cwd ./app \
  --report ./launchrally-current-report.json \
  --architecture-package ./architecture-package.json
```

PowerShell:

```powershell
rally plan --json --cwd ./app `
  --report ./launchrally-current-report.json `
  --architecture-package ./architecture-package.json
```

Planning is read-only. Recomputing with a previous Task Graph may preserve only semantically unchanged Task state. `reported_succeeded` never means `verified`, and an effectful dependent stays blocked until a fresh Report supplies the required Evidence.

## 4. Approve an external handoff

Executor discovery returns candidate authority batches, not permission. Review each authority batch for the exact Task and Executor references, environment, effect class, target, tools, unverified authentication assumptions, secret-reference handling, cancellation support, partial-failure semantics, availability, and installation guidance. Missing installation or login remains a prerequisite; LaunchRally does not perform either one.

### handoff

POSIX shell:

```bash
rally handoff --json \
  --task-graph ./task-graph.json \
  --executors ./executor-descriptors.json \
  --tools ./tool-observations.json \
  --reviewed-executors ./reviewed-executors.json
```

PowerShell:

```powershell
rally handoff --json `
  --task-graph ./task-graph.json `
  --executors ./executor-descriptors.json `
  --tools ./tool-observations.json `
  --reviewed-executors ./reviewed-executors.json
```

Select only an offered batch, then separately confirm its versioned Handoff Package after reviewing allowed effects and prohibited effects. Approval authorizes only that package. The external Executor returns a normalized secret-free receipt; raw output, credentials, business payloads, and real-user data are excluded. Cancellation and partial execution preserve their exact remaining work. The receipt stays a claim and cannot change assurance.

The same resume commands work in POSIX shells and PowerShell because these values contain no shell-authored JSON. Substitute only values returned by the immediately preceding typed interaction:

```text
rally handoff --json --resume <token> --select <batch-id>
rally handoff --json --resume <token> --confirm confirm
rally handoff --json --resume <token> --confirm deny
rally handoff --json --resume <token> --confirm cancel
rally handoff --json --resume <token> --receipt ./execution-receipt.json
rally handoff --json --resume <token> --choice verify
```

## 5. Verify independently

After receipt review, choose the typed `verify` continuation. Full Verify starts from the Manifest-bound source Report, recollects fresh Evidence, produces a new current Report, and reassesses the release. Targeted Verify covers only selected Checks and never produces a whole-release assessment. Evidence remains bound to its explicit environment.

### verify

POSIX shell:

```bash
rally verify --json --cwd ./app \
  --report ./launchrally-manifest-source-report.json \
  --scope full
```

PowerShell:

```powershell
rally verify --json --cwd ./app `
  --report ./launchrally-manifest-source-report.json `
  --scope full
```

The first result is `needs_permission`. Present every pending permission separately, preserve the opaque token, and resume with an explicit decision for each returned permission ID. The following denies public collection and still reaches an honest completed Verify with corresponding Gaps; approve only boundaries the builder actually accepts.

POSIX shell:

```bash
rally verify --json --cwd ./app \
  --resume <verify-token> \
  --permissions '{"public_verification":"denied"}'
```

PowerShell:

```powershell
$permissions = '{"public_verification":"denied"}'
rally verify --json --cwd ./app `
  --resume <verify-token> `
  --permissions $permissions
```

If the typed result instead requests `authenticated_journey_results`, do not author `--journey-results` JSON in the shell. The installed authenticated-journey host adapter must collect, attest, and resume the exact plan; unsupported collection stays a Gap. A successful continuation requires `status: "completed"`, a new immutable Report and Evidence Index, and no invented Passed Check.

Ordinary verification collection permissions authorize reads only. A completed full Verify separately atomically persists the disclosed local Report, View, Evidence Index, and allowlisted Evidence under `.launchrally/`; targeted Verify does not create a whole-release Report. Active verification is a distinct boundary: each reviewed recipe discloses its real user-visible and cleanup effects and requires exact approval. Production active verification is default-denied unless the production-safe recipe, environment classification, and separate approval rules all qualify. Timeout, late success, duplicate delivery, retries, cleanup failure, and inconclusive observation remain distinct results rather than synthetic success.

Composite Assurance preserves Requirement, Local Implementation, Provider Configuration, Integration Consistency, Deployment, Operational Delivery, and Downstream Outcome as independent facets. Launch Assessment and Architecture Status are separate records.

## Honest non-success paths

| Path | Truthful result | Next action |
| --- | --- | --- |
| Permission denial | Verification Gap with the denied boundary | Continue with reduced coverage or restart a fresh boundary later. |
| Missing Executor or tool | Unavailable candidate with installation/authentication prerequisites, or a manual/custom path | Install or authenticate only through a separate user-managed action; rediscover afterward. |
| Cancellation | Cancelled Task/Handoff with no implied effect | Recompute the frontier from current typed state. |
| Partial execution | Explicit completed and remaining work; never a full success | Review recovery and run only a compatible continuation. |
| Stale architecture | Empty safe frontier or reassessment state | Refresh the changed dependencies and make new decisions without rewriting history. |
| Unknown Provider | Honest generic/custom/self-hosted support depth and Verification Gaps | Supply reviewed knowledge or keep the implementation unknown. |
| Denied or unsupported active verification | Unverified Check plus a transparent Gap | Use ordinary safe Evidence when available; never fabricate an outcome. |

Operation-specific continuations keep these cases typed:

```text
# Plan succeeds with a current package; a stale package returns an empty safe frontier.
rally plan --json --cwd ./app --report ./launchrally-current-report.json --architecture-package ./architecture-package.json

# Missing Executor discovery retains recovery/manual/defer/cancel choices.
rally handoff --json --task-graph ./task-graph.json --executors ./empty-executors.json --tools ./tool-observations.json --reviewed-executors ./empty-reviewed-executors.json

# Authority denial, cancellation, partial receipt review, and fresh Verify are separate resumes.
rally handoff --json --resume <token> --confirm deny
rally handoff --json --resume <token> --confirm cancel
rally handoff --json --resume <token> --receipt ./partial-execution-receipt.json
rally handoff --json --resume <token> --choice verify

# Targeted Verify cannot claim a whole-release assessment.
rally verify --json --cwd ./app --report ./launchrally-manifest-source-report.json --scope targeted --checks '["check.id"]'

# An Integration Contract with provider_binding.kind "unknown" stays unknown through Architect.
rally architect --json --cwd ./app --review-date <actual-reviewed-date> --report ./launchrally-current-report.json --intent ./product-intent.json --catalog ./capability-catalog.json --graph ./capability-graph.json --integrations ./unknown-provider-integration-contracts.json

# An active-verification Check first remains an ordinary unverified targeted Verify result.
rally verify --json --cwd ./app --report ./launchrally-manifest-source-report.json --scope targeted --checks '["<active-check-id>"]'
```

The last `rally verify` command can disclose the Gap but cannot approve an active effect. Active verification is a typed installed-host Core interface rather than another public `rally` flag in this release. The host passes the exact current Task, reviewed recipe, Executor Descriptor, and versioned Integration Contract to `planActiveVerification`; `approveActiveVerification(..., { confirmation: "confirm" })` grants only the previewed active and cleanup effects, while `confirmation: "deny"` returns `active_verification_denied`. The normalized externally attested observation is reviewed separately before it can produce Evidence. This split is the public command boundary: never turn the ordinary `rally verify` permission into active-test authority.

## Agent Mode and Human Mode

Agent Mode always uses `--json`, validates the `launchrally.dev/cli/v2` envelope plus the operation-specific schema, and handles only declared typed interaction values. An Agent must never parse Human Mode prose, fill missing intent or Evidence, reconstruct state, or infer permission.

Human Mode supports an interactive Architecture review in a TTY and prints structured previews for the person to confirm. Human Mode cannot provide external Executor automation or cross-host Agent resume; non-TTY Architect use directs the caller to Agent Mode. Plan, Handoff, and Verify structured automation should use Agent Mode.

For a supported cross-host pause, Codex and Claude use their installed adapter's `./resume` export to save or read one validated `launchrally.dev/host-resume-artifact/v1` at a user-selected local path. Do not paste the opaque token, Task state, Blueprint, or Handoff Package into chat.

## Artifacts, privacy, and compatibility

- **Release states:** the Phase 0 Stable line and its Quality Floor remain independently valid. Phase 1 records are additional and experimental until separately promoted.
- **Shareable artifacts:** confirmed Product Intent and an explicitly saved Host Resume Artifact or pre-Init Architecture Package can be exchanged deliberately. Validate exact schemas, versions, references, and digests before use.
- **Local artifacts:** `.launchrally/` stores ignored project history after confirmation. The owner-only host resume registry stores the key and encrypted Architecture/Handoff state outside the repository; its removal invalidates retained resume artifacts.
- **Privacy:** raw source, Provider output, stdout, stderr, response bodies, secrets, credentials, business payloads, and real-user data do not belong in persisted records. Receipts and normalized observations use narrow allowlists.
- **Desktop limitation:** `desktop_with_shared_backend` assesses the shared backend only. Signing, notarization, store review, distribution, and updater readiness remain explicitly Unknown unless separately verified.
- **Compatibility:** an initialized Phase 0 project remains usable without Phase 1 adoption. Adoption is additive, transactional, and separately confirmed; uninstalling a Plugin or Launcher does not delete project history or the host resume registry.

Detailed privacy and retention behavior is documented in [Permission and privacy boundaries](../concepts/privacy.md). Agent implementations should follow the canonical [complete Phase 1 journey](../../skills/launchrally/references/phase-1-journey.md).
