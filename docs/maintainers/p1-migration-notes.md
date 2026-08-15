# Phase 1 Experimental migration notes

LaunchRally 0.4.0 introduces an additive Phase 1 layer. Existing Phase 0
projects and the public 0.3.2 Stable line remain independently valid.

## Adoption

Install 0.4.0 only by selecting the non-stable `experimental` channel or the
exact version. Architect previews a versioned Phase 1 adoption before any
project write. Confirmation creates only the disclosed `.launchrally/phase-1`
records and retains existing Phase 0 bytes. Denial and interruption leave the
Phase 0 project usable; an interrupted transaction is recovered before retry.

Phase 1 Architecture, Task, Handoff, and Evidence meanings are not inferred
from old prose or receipts. Re-run the typed journey and fresh Verify when an
input, environment, Architecture dependency, or reviewed source becomes stale.

## Removal and retained local data

Removing the CLI or either Plugin does not delete project-owned `.launchrally`
records. Owner-only resumable host state may remain in the documented local
host registry. Delete retained project or host state only after separately
reviewing whether another supported host or historical record still needs it.

## Failed Experimental publication

npm versions are immutable and LaunchRally does not promise transactional
rollback across npm and GitHub. If no package was published, fix the candidate
and publish a new coherent version. If only some packages were published, do
not reuse that version: record the partial publication, advance every package,
internal dependency, Plugin manifest, marketplace pin, bundled Skill, and tag
to one new coherent version, then repeat the protected workflow.

If all packages were published but external verification finds an artifact
defect, withdraw the GitHub prerelease announcement and deprecate the affected
exact npm versions with an owner-reviewed administrative action. Do not move
`latest`, do not delete immutable versions, and do not claim an unsupported
rollback. Publish and verify a corrected coherent Experimental version. A
transient registry or verification-service failure may resume the same tagged
workflow only when all five exact artifacts and their digests remain coherent.
