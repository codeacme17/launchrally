# Complete Phase 1 journey

Use this sequence only after validating `launchrally.dev/cli/v2` and the selected Engine through [cli-contract.md](cli-contract.md). Preserve every typed interaction and opaque resume token exactly; never branch on Human Mode prose.

1. **Confirm intent.** Start `rally architect --json` with the current full Report and the matching Phase 1 inputs. Follow [product-intent.md](product-intent.md) when intent is incomplete or product materials are selected. A repository observation, PRD statement, or Agent inference is a candidate until the builder confirms it. Keep hard constraints separate from preferences.
2. **Review architecture.** Follow [capability-model.md](capability-model.md) and [architect.md](architect.md). Present the Capability Graph, Integration Contracts, whole-product Blueprint, currentness, Unknowns, and each decision independently. Provider examples are non-canonical; custom, self-hosted, retained, deferred, and unknown implementations remain valid. Configuration does not prove an operational or downstream outcome.
3. **Build tasks.** Run `rally plan --json` with the current Report and confirmed Architecture Package. Follow [plan.md](plan.md). Preserve each Task's source meaning, state, prerequisites, effects, Evidence targets, and ready frontier. A Task in `reported_succeeded` is still unverified.
4. **Approve authority.** Start `rally handoff --json` only for a ready Task Graph and exact reviewed Executor inputs. Follow [handoff.md](handoff.md). Keep discovery, availability, installation, authentication, selection, authority confirmation, external execution, and receipt review separate. An Execution Receipt is a claim, never Machine Evidence.
5. **Verify independently.** Choose the typed `verify` continuation after receipt review, then run the requested `rally verify --json` flow under [verify.md](verify.md). Each permission is fresh and environment-bound. Active verification follows its reviewed recipe and exact effect approval; production remains default-denied. Only qualifying fresh Evidence may change Task or Composite Assurance state.

For denial, missing Executor, cancellation, partial execution, stale architecture, unknown Provider, or denied active verification, preserve the returned Gap, remaining work, or stale state. Restart only from current typed inputs. Never fill missing state with Agent confidence.

Human Mode can guide an interactive Architecture review, but it cannot provide external Executor automation or cross-host Agent resume. Agent Mode must use typed interactions. For a supported Codex-to-Claude or Claude-to-Codex pause, use only the adapter `./resume` export and its validated local Host Resume Artifact; never paste or reconstruct state.

The shell-neutral argument vectors and their POSIX and PowerShell renderings are in [phase-1-command-examples.json](phase-1-command-examples.json). Use the exact vector for the selected operation; substitute only explicit local artifact paths.
