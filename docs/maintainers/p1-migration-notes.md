# Phase 1 Experimental migration notes

LaunchRally 0.4.3 continues the additive Phase 1 layer. Existing Phase 0
projects and the public 0.3.2 Stable line remain independently valid.

## Project Toolchain migration: 0.4.2 to 0.4.3

This procedure is only for an initialized project whose established Engine pin
is `0.4.2`. LaunchRally 0.4.3 remains **Experimental** on npm's
`experimental` channel; completing this migration does not make Phase 1 P1
Validated or Stable. Phase 0 `0.3.2` remains the release on npm `latest`.

Treat these as five separate facts and lifecycles:

- the **Launcher** is the user-managed `rally` dispatcher installed through the
  current npm prefix;
- the selected **Engine** executes repository operations;
- the **project pin** and rebuildable Engine materialization make up the
  repository-owned Project Toolchain;
- a Codex or Claude **Plugin** supplies host interaction guidance and never
  selects or replaces the Engine; and
- `0.4.3` is on the **Experimental** channel, independently of those versions.

Updating the Launcher does not update an initialized project's valid pin. Thus,
after the first install below, structured version output with
`launcher_version: "0.4.3"`, `cli_version: "0.4.2"`, and
`authority.source: "project_toolchain"` is expected. It proves that the newer
Launcher followed the established Engine; it is not a failed installation.
Only an explicitly confirmed `toolchain migrate` changes that pin. `init` is
not a migration mechanism.

Before confirmation, review the complete preview. Migration changes only the
owned Project Toolchain package, lock, authority descriptor, and rebuildable
materialization. It preserves the Manifest, immutable Reports, Evidence,
Architecture history, Provider intent, host application source, application
dependencies, and external saved Reports. It marks the prior current Report
non-current with `execution_authority_changed`, so a fresh full Verify is
required after migration.

Keep the original Manifest-bound source Audit Report used by confirmed Init.
In the examples, set `SOURCE_REPORT` to that external JSON file, not to the
prior or new `.launchrally/reports/<report-id>/record.json` current Report.

### Current 0.4.3 confirmation behavior

In an interactive TTY, the shipped 0.4.3 `toolchain migrate` command keeps its
resume token internal, renders a styled concise preview, defaults to decline,
allows the complete exact diff to be reviewed, and returns to the same prompt
before completing a confirmed migration in-process. Cancellation, denial, or a
stale preview changes no Project Toolchain state.

The copy-pasteable procedures below intentionally use Agent/CI `--json` so the
complete `launchrally.dev/toolchain-lifecycle/v1` protocol remains explicit
and shell-equivalent. Validate every typed field, preserve each opaque token
verbatim, and keep the optional registry permission separate from migration
confirmation. Never parse Human prose or infer either decision.

### POSIX

Set the two paths first. Keep the response files outside `.launchrally` and
delete them yourself after the migration if they are no longer needed.

```sh
PROJECT_ROOT=/path/to/project
SOURCE_REPORT=/path/to/original-manifest-bound-audit-report.json
MIGRATION_RESPONSE=./launchrally-0.4.3-migration-response.json

npm install --global @launchrally/cli@0.4.3
rally --version --json
rally --version --json --cwd "$PROJECT_ROOT"
rally toolchain status --json --cwd "$PROJECT_ROOT"

rally toolchain migrate --to 0.4.3 --json --cwd "$PROJECT_ROOT" > "$MIGRATION_RESPONSE"
node -e 'const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); console.log(value.status); console.log(JSON.stringify(value.request ?? {}, null, 2));' "$MIGRATION_RESPONSE"
```

Before migrating, require the repository-scoped version and status results to
identify the established 0.4.2 project pin and selected Engine separately from
the 0.4.3 Launcher.

If the status is `needs_permission`, review the exact `npm_registry_read`
request. To deny it, replace `approved` with `denied`; denial preserves the
0.4.2 pin and returns `registry_permission_denied`. To approve only that bounded
read and obtain the migration preview:

```sh
MIGRATION_TOKEN="$(node -e 'const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(value.interaction.resume_token);' "$MIGRATION_RESPONSE")"
rally toolchain migrate --to 0.4.3 --json --cwd "$PROJECT_ROOT" --resume "$MIGRATION_TOKEN" --permissions '{"npm_registry_read":"approved"}' > "$MIGRATION_RESPONSE"
node -e 'const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); console.log(value.status); console.log(JSON.stringify(value.preview ?? {}, null, 2));' "$MIGRATION_RESPONSE"
```

When the response is `needs_confirmation`, inspect every `preview.changes`
entry. Resume with `decline` to leave the pin and project unchanged, or confirm
that exact preview:

```sh
MIGRATION_TOKEN="$(node -e 'const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(value.interaction.resume_token);' "$MIGRATION_RESPONSE")"
rally toolchain migrate --to 0.4.3 --json --cwd "$PROJECT_ROOT" --resume "$MIGRATION_TOKEN" --confirm confirm

rally --version --json --cwd "$PROJECT_ROOT"
rally verify --cwd "$PROJECT_ROOT" --report "$SOURCE_REPORT" --scope full
```

Require `authority.state: "ready"`, `authority.source: "project_toolchain"`,
`launcher_version: "0.4.3"`, and `cli_version: "0.4.3"` before Verify. A
completed Verify creates a new current Report. Use the exact current Report path
printed by completion for Plan or Architect; retain `SOURCE_REPORT` as the
Manifest-bound input to future whole-release Verify runs.

### PowerShell

```powershell
$ProjectRoot = 'C:\path\to\project'
$SourceReport = 'C:\path\to\original-manifest-bound-audit-report.json'
$MigrationResponse = '.\launchrally-0.4.3-migration-response.json'

npm install --global @launchrally/cli@0.4.3
rally --version --json
rally --version --json --cwd $ProjectRoot
rally toolchain status --json --cwd $ProjectRoot

rally toolchain migrate --to 0.4.3 --json --cwd $ProjectRoot | Set-Content -Encoding utf8 $MigrationResponse
$Migration = Get-Content -Raw $MigrationResponse | ConvertFrom-Json
$Migration.status
$Migration.request | ConvertTo-Json -Depth 20
```

If `$Migration.status` is `needs_permission`, review the exact
`npm_registry_read` request. Use `denied` to preserve the 0.4.2 pin, or approve
only that request and obtain the preview:

```powershell
rally toolchain migrate --to 0.4.3 --json --cwd $ProjectRoot --resume $Migration.interaction.resume_token --permissions '{"npm_registry_read":"approved"}' | Set-Content -Encoding utf8 $MigrationResponse
$Migration = Get-Content -Raw $MigrationResponse | ConvertFrom-Json
$Migration.status
$Migration.preview | ConvertTo-Json -Depth 20
```

When the response is `needs_confirmation`, inspect every
`$Migration.preview.changes` entry. Resume with `decline` to change nothing, or
confirm the exact preview:

```powershell
rally toolchain migrate --to 0.4.3 --json --cwd $ProjectRoot --resume $Migration.interaction.resume_token --confirm confirm

rally --version --json --cwd $ProjectRoot
rally verify --cwd $ProjectRoot --report $SourceReport --scope full
```

Apply the same postconditions as the POSIX path. Use the new current Report for
Plan or Architect, and keep `$SourceReport` for future whole-release Verify.

### Denial, recovery, restore, and downgrade

- A denied registry read, `--confirm decline`, an abandoned preview, or Ctrl-C
  before adoption preserves the 0.4.2 project authority. Start a new migrate
  operation if an opaque token is lost or invalid; never reconstruct it.
- Missing registry access is not permission to use `sudo`, a floating version,
  a silent npm action, a changed npm prefix or shell profile, a copied
  unvalidated Engine, Provider installation or login, or a mutated application
  dependency. Retry after the exact package is available in an authorized npm
  cache, or explicitly approve the typed bounded registry read.
- A later lifecycle command recovers a safely recognizable interrupted
  transaction before proceeding. Inconsistent or malformed transaction state
  fails closed; preserve it and inspect `rally toolchain status --json --cwd
  <project>` rather than editing owned files or invoking an Engine directly.
- `rally toolchain restore --cwd <project>` only rebuilds the established exact
  pin; it does not undo a completed migration. It may independently request the
  same bounded registry read.
- With Launcher 0.4.3, the only supported downgrade target is the allowlisted
  legacy Engine: `rally toolchain migrate --to 0.2.2 --cwd <project>`. It uses
  the same preview/resume protocol, makes the prior current Report non-current,
  and requires fresh full Verify. A 0.4.2 direct downgrade is unsupported by
  the shipped lifecycle; `restore` cannot be used to bypass that restriction.
  There is no automatic rollback or arbitrary unsupported-version bypass.

### Update a Plugin separately

The migration does not update either host Plugin. If one is installed, update
it only after the Launcher and Project Toolchain checks above.

#### Codex Plugin

Replace the installed Codex Plugin and pin the marketplace checkout to the
exact release tag:

```sh
codex plugin remove launchrally@launchrally
codex plugin marketplace remove launchrally
codex plugin marketplace add codeacme17/launchrally --ref v0.4.3
codex plugin add launchrally@launchrally
codex plugin list --json
```

#### Claude Plugin

Replace the installed Claude Plugin and marketplace checkout, pinning the
repository to the exact `v0.4.3` tag at explicit user scope:

```sh
claude plugin uninstall launchrally@launchrally --scope user
claude plugin marketplace remove launchrally
claude plugin marketplace add codeacme17/launchrally@v0.4.3 --scope user
claude plugin install launchrally@launchrally --scope user
claude plugin list --json
```

Require the list to show the installed and enabled `launchrally@launchrally`
Plugin. Do not use a floating marketplace update as a substitute for the exact
tagged checkout.

Plugin update or removal leaves the Launcher, Project Toolchain, Manifest,
Reports, Evidence, Architecture history, Provider intent, application source,
and owner-restricted host resume registry unchanged. Removing that separate
host registry invalidates retained resumable host artifacts; it is not part of
Project Toolchain migration.

## Project Toolchain migration: 0.4.1 to 0.4.2

This historical procedure remains available for an initialized project whose
established Engine pin is `0.4.1`. LaunchRally 0.4.2 is Experimental; Phase 0
Stable remains `0.3.2` on npm `latest`. Updating the global Launcher does not
change a valid project pin, so `launcher_version: "0.4.2"` together with
`cli_version: "0.4.1"` and `authority.source: "project_toolchain"` is expected
before migration. Only an explicitly confirmed `toolchain migrate` changes the
pin; `init` is not a migration mechanism.

Migration changes only the owned Project Toolchain package, lock, authority
descriptor, and rebuildable materialization. It preserves the Manifest,
immutable Reports, Evidence, Architecture history, Provider intent,
application dependencies and source, and external saved Reports. It marks the
prior current Report non-current with `execution_authority_changed`, requiring
a fresh full Verify against the original Manifest-bound source Audit Report.

The shipped 0.4.2 default TTY flow emits typed permission and confirmation
states and requires explicit resume commands. Review every field, keep opaque
resume tokens outside the repository, and treat registry permission and
migration confirmation as separate decisions.

### POSIX

```sh
PROJECT_ROOT=/path/to/project
SOURCE_REPORT=/path/to/original-manifest-bound-audit-report.json
MIGRATION_RESPONSE=./launchrally-0.4.2-migration-response.json

npm install --global @launchrally/cli@0.4.2
rally --version --json
rally --version --json --cwd "$PROJECT_ROOT"
rally toolchain status --json --cwd "$PROJECT_ROOT"

rally toolchain migrate --to 0.4.2 --cwd "$PROJECT_ROOT" > "$MIGRATION_RESPONSE"
node -e 'const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); console.log(value.status); console.log(JSON.stringify(value.request ?? {}, null, 2));' "$MIGRATION_RESPONSE"
```

If the response is `needs_permission`, review the exact `npm_registry_read`
request. Denial preserves the 0.4.1 pin. Approval authorizes only that bounded
read and returns the exact migration preview:

```sh
MIGRATION_TOKEN="$(node -e 'const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(value.interaction.resume_token);' "$MIGRATION_RESPONSE")"
rally toolchain migrate --to 0.4.2 --cwd "$PROJECT_ROOT" --resume "$MIGRATION_TOKEN" --permissions '{"npm_registry_read":"approved"}' > "$MIGRATION_RESPONSE"
node -e 'const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); console.log(value.status); console.log(JSON.stringify(value.preview ?? {}, null, 2));' "$MIGRATION_RESPONSE"
```

When the response is `needs_confirmation`, inspect every
`preview.changes` entry. Resume with `decline` to change nothing, or confirm the
exact preview and perform the mandatory full Verify:

```sh
MIGRATION_TOKEN="$(node -e 'const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(value.interaction.resume_token);' "$MIGRATION_RESPONSE")"
rally toolchain migrate --to 0.4.2 --cwd "$PROJECT_ROOT" --resume "$MIGRATION_TOKEN" --confirm confirm
rally --version --json --cwd "$PROJECT_ROOT"
rally verify --cwd "$PROJECT_ROOT" --report "$SOURCE_REPORT" --scope full
```

### PowerShell

```powershell
$ProjectRoot = 'C:\path\to\project'
$SourceReport = 'C:\path\to\original-manifest-bound-audit-report.json'
$MigrationResponse = '.\launchrally-0.4.2-migration-response.json'

npm install --global @launchrally/cli@0.4.2
rally --version --json
rally --version --json --cwd $ProjectRoot
rally toolchain status --json --cwd $ProjectRoot

rally toolchain migrate --to 0.4.2 --cwd $ProjectRoot | Set-Content -Encoding utf8 $MigrationResponse
$Migration = Get-Content -Raw $MigrationResponse | ConvertFrom-Json
$Migration.status
$Migration.request | ConvertTo-Json -Depth 20
```

Approve only the exact registry request when required, then inspect and confirm
the exact preview:

```powershell
rally toolchain migrate --to 0.4.2 --cwd $ProjectRoot --resume $Migration.interaction.resume_token --permissions '{"npm_registry_read":"approved"}' | Set-Content -Encoding utf8 $MigrationResponse
$Migration = Get-Content -Raw $MigrationResponse | ConvertFrom-Json
$Migration.preview | ConvertTo-Json -Depth 20

rally toolchain migrate --to 0.4.2 --cwd $ProjectRoot --resume $Migration.interaction.resume_token --confirm confirm
rally --version --json --cwd $ProjectRoot
rally verify --cwd $ProjectRoot --report $SourceReport --scope full
```

After migration require ready `project_toolchain` authority and both Launcher
and selected Engine at 0.4.2. Use the new current Report printed by Verify for
Plan or Architect, while retaining the Manifest-bound source Report for future
whole-release Verify runs.

Denial, cancellation, abandoned or stale previews, and missing registry access
preserve the 0.4.1 pin. Interrupted transactions recover only when their state
is safely recognizable; malformed state fails closed. `restore` rebuilds the
established pin and is not a downgrade. Launcher 0.4.2 supports only the
allowlisted legacy downgrade target `0.2.2`; direct downgrade to 0.4.1 is
unsupported.

Update an installed Plugin separately and pin its checkout to the exact tag:

```sh
codex plugin remove launchrally@launchrally
codex plugin marketplace remove launchrally
codex plugin marketplace add codeacme17/launchrally --ref v0.4.2
codex plugin add launchrally@launchrally
codex plugin list --json

claude plugin uninstall launchrally@launchrally --scope user
claude plugin marketplace remove launchrally
claude plugin marketplace add codeacme17/launchrally@v0.4.2 --scope user
claude plugin install launchrally@launchrally --scope user
claude plugin list --json
```

Plugin update or removal does not change the Launcher, Project Toolchain,
project-owned data, application source, or owner-restricted host resume state.

## Adoption

Install 0.4.3 only by selecting the non-stable `experimental` channel or the
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
