# Init

Initialization is optional and available only after the builder has received a complete first Report. Save the full Agent Mode Audit JSON, then invoke `rally init --report <path> --json`.

The first invocation returns `needs_confirmation` with the complete Launch Manifest and exact before/after content, digests, and diff for every local change. Present every change. Resume with the returned token and pass `--confirm confirm` only after explicit approval; use `--confirm decline` otherwise.

Initialization may create or update only:

- `.launchrally/launch-manifest.json`;
- `.launchrally/.gitignore`, which keeps Reports, Evidence, and recovery state local;
- the exact `@launchrally/cli` devDependency in `package.json`;
- the corresponding detected package-manager lockfile.

The Manifest records project, release, execution, support, and Provider intent as `declared`, `unknown`, or reasoned `not_applicable` states. It is derived only from secret-safe Report fields.

Declining or abandoning the preview writes nothing. A stale preview fails before writing. Partial write failures roll back automatically; if rollback is interrupted, the next `init` recovers from the ignored transaction journal. LaunchRally never stages or commits project files. Project-owned `.launchrally` data remains after Plugin uninstall.

Existing supported Manifest changes use the same diff-and-confirm migration flow. Unsupported future major versions fail closed.
