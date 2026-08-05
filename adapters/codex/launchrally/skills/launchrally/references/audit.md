# Audit

1. Resolve the repository root and exact CLI version.
2. Run `rally audit --json --cwd <repo>` through the documented package-manager path.
3. Treat the returned Snapshot, Assessment, gaps, and limitations as canonical.
4. If the CLI requests input, confirmation, or permission, present that request without adding inferred approval.
5. Never describe `Inconclusive` as ready to launch.

The initial local tracer discovers normalized Web project facts and runs the deterministic lockfile baseline through the Check Catalog path. A passing baseline remains `Inconclusive` while the Report contains a P0 Verification Gap. A failed P0 baseline returns `No Go`.
