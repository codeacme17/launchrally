# Init

Initialization is optional and available only after the builder has received a complete first Report. Save the full Agent Mode Audit JSON, then invoke `rally init --report <path> --json`.

The first invocation returns `needs_confirmation` with the complete Launch Manifest and exact before/after content, digests, and diff for every local change. Present every change. The opaque resume token refers to a mode-`0600` local preview record so confirmed contents cannot be substituted. Resume with the returned token and pass `--confirm confirm` only after explicit approval; use `--confirm decline` otherwise.

Initialization may create or update only:

- canonical `.launchrally/manifest.yaml`;
- legacy `.launchrally/launch-manifest.json` only by deleting it in the same confirmed migration that creates the canonical YAML Manifest;
- `.launchrally/.gitignore`, which keeps Reports, Evidence, and recovery state local;
- the complete source Report bundle, Evidence Index, and digest-addressed safe Evidence under `.launchrally/reports/` and `.launchrally/evidence/`;
- the exact `@launchrally/cli` devDependency in `package.json`;
- the corresponding detected package-manager lockfile.

Manifest v2 records Project, Release, Execution, Support, and Providers intent with uniform `declared`, `unknown`, or evidenced `not_applicable` states. Every `not_applicable` state carries its reason and source-Report field evidence. The deterministic YAML is derived only from secret-safe Report fields.

Declining or abandoning the preview writes nothing to the project. A stale or corrupted preview fails before writing; the resume token integrity-checks the serialized preview contents, and confirmation derives its apply set from that validated change list. Confirmed source history is staged and its Report directory becomes visible only when the complete bundle is ready. Init never writes the replaceable current-Report cache, so it is excluded from the exact preview and `changes_applied`. One ownership-safe Init lock covers recovery, mutable adoption, history commit, and journal cleanup; a concurrent Init returns a recoverable busy result. Partial write failures roll back automatically; if rollback is interrupted, the next `init` recovers from the ignored transaction journal. Recovery validates the phase, commit ownership, whether history was preexisting, and the complete physical Report bundle and Evidence before finalizing adoption. It preserves already committed immutable history and post-interruption user edits by returning a recoverable conflict instead of overwriting them. Symlinked initialization paths fail closed. LaunchRally never stages or commits project files. Project-owned `.launchrally` data remains after Plugin uninstall; Reports and Evidence are never automatically pruned.

The dependency preview validates manager-specific exact bindings for npm, pnpm, Yarn, and text `bun.lock`. Legacy binary `bun.lockb` returns a recoverable error and must be migrated to `bun.lock`, followed by a fresh Audit, before initialization.

An existing valid Manifest v2 is canonicalized through the same diff-and-confirm flow. A valid legacy JSON Manifest v1 migration previews both the new YAML and legacy-file deletion; decline leaves both untouched. Invalid, ambiguous, symlinked, or unsupported Manifest inputs fail closed.
