# Audit

1. Resolve the repository root and exact CLI version.
2. Run `rally audit --json --cwd <repo>` through the documented package-manager path.
3. Treat the returned Snapshot, Assessment, gaps, and limitations as canonical.
4. If the CLI requests input, confirmation, or permission, present that request without adding inferred approval.
5. Never describe `Inconclusive` as ready to launch.

The initial scaffold performs local project discovery only. It has no implemented Check Catalog and must return `Inconclusive`.
