# Verify

Run verification only after the user or an external Coding Agent reports remediation complete. The claim itself is not Evidence.

Use `rally verify --report <path> --scope full --json`, inspect the disclosed fresh-read permissions, then resume with `--resume <token> --permissions '<json>'`. Rely on the new immutable Report, Evidence Index, Manifest Drift list, and source-to-current comparison.

For a limited recheck, use `--scope targeted --checks '["check.id"]'`. A targeted result has `assessment_scope: "targeted_only"`, carries no Report, and must never be presented as a whole-release Launch Ready assessment.
