# Install, lifecycle, and troubleshooting

LaunchRally `0.3.0` is the exact Experimental P0 release used by this guide. Experimental availability remains non-stable after the reviewed P0 Validated decision.

## Supported environments

The CLI requires Node.js 20.12.0 or newer and is verified with Node.js 20.12, 22, and 24 on macOS, Linux, and Windows. The commands work in POSIX shells, PowerShell, and `cmd.exe`; path syntax and manual removal commands differ by shell.

The default entry is a user-managed PATH installation. npm's global prefix may be system-scoped or user-scoped, so verify that the active prefix is writable before installation. LaunchRally does not install Node.js, configure a Node version manager, change the npm prefix, or edit a shell profile.

## Lifecycle layers

- **Launcher** — the dispatcher entered through the user-managed `rally` command or a supported exact-version npm-exec invocation.
- **Engine** — the selected CLI implementation that executes Audit, Init, Plan, Provider guidance, and Verify.
- **Project Toolchain** — the exact Engine pin, authority descriptor, lock, and rebuildable materialization under `.launchrally/toolchain`.
- **Execution Authority** — the versioned rule and result that select and validate an Engine for a repository.
- **Invocation Context** — a non-authoritative description of how the Launcher was entered, used to render safe executable next actions.

The Launcher, Plugin, Project Toolchain, and project-owned `.launchrally` data have separate lifecycles. Installing or removing one never silently installs, migrates, cleans, or deletes another.

## Install and verify the Launcher

Before entering a repository, install through the current npm prefix and verify structured version output:

```bash
npm install --global @launchrally/cli@0.3.0
rally --version --json
```

The first command uses exactly the prefix reported by:

```bash
npm prefix --global
```

On macOS and Linux, global executables normally live in the prefix's `bin` directory. On Windows, npm normally places command shims directly in the prefix. Inspect those locations and add the appropriate directory to your `PATH` yourself if required. Do not invoke npm with elevated privileges, use a floating version, suppress npm's confirmation, run a pipe-to-shell installer, or let LaunchRally alter a shell profile.

If the prefix is not user-writable, prefer a Node version manager or deliberately configure a user-writable npm prefix according to npm's documentation. Then open a new shell if your own configuration requires it and rerun both exact commands above.

## First repository journey

From the repository root, run the Human Audit, save the complete Report, separately confirm Init, and prove project delegation with the next read-only operation:

```bash
rally audit --plain --cwd . --output ./launchrally-audit-report.json
rally init --plain --cwd . --report ./launchrally-audit-report.json
rally --version --json --cwd .
```

Review the complete Audit Brief, confirmed scope, planned Checks, and authorization plan. Local scan, public verification, and every Provider read are independent and default-denied. Reports and Evidence remain local. CLI or Plugin installation grants no Provider, deployment, production, credential, or application-source write authority.

Audit does not create `.launchrally`. The saved Report is an explicit output at `./launchrally-audit-report.json`. Confirmed Init is the first project mutation: it previews only LaunchRally-owned `.launchrally` paths, materializes the exact Engine, and leaves application dependency files unchanged. A registry read, when needed after an offline miss, is a separate decision from the file preview and confirmation.

After Init, `rally --version --json --cwd .` must report `authority.state: "ready"` and `authority.source: "project_toolchain"`. Repository operations still enter through `rally`; never invoke a Project Toolchain Engine directly.

## Provider CLI recovery

An approved Provider read can complete with a `missing_provider_tool` Verification Gap. The saved Report then includes `launchrally.dev/provider-tool-recovery/v1` with the Provider, Adapter version, executable, evidence benefit, official source, exact supported version, verification command, active platform and shell, and its available typed choices. `continue_with_gap` is the default and leaves the Check Unverified.

To inspect the typed recovery or reveal its reviewed instructions, use the saved Report:

```bash
rally providers --report ./launchrally-audit-report.json --recover <provider> --json
rally providers --report ./launchrally-audit-report.json --recover <provider> --choice show_install_instructions --json
```

LaunchRally renders only the route stored in `packages/core/provider-tool-installation/v1/authority.json` for the active platform and shell. It never executes that installation command, selects a floating version, invokes `sudo`, changes an npm prefix, edits `PATH` or a shell profile, or starts Provider authentication. Unsupported platforms return `guidance_unavailable` without an invented route. Cloudflare currently returns this state on every platform because its official Wrangler guidance is project-local and this recovery flow does not mutate application dependencies.

After the user-managed installation, choose `rediscover_executable`. LaunchRally runs only the structured `--version` verification command. A missing or wrong executable remains a recovery state. An exact match produces a new pending `provider_read:<provider>` description; start a new Audit or Verify boundary and decide that permission again. The earlier approval is never reused. Missing Provider authentication remains a separate `missing_provider_login` Gap and never starts an automatic login flow.

## No-install trial and CI fallback

Exact-version npm-exec is a no-install trial and CI fallback. It is useful in disposable evaluation or CI environments, but it is not the default interactive or Agent prerequisite. Because the process is ephemeral, every follow-up must retain the complete prefix:

```bash
npm exec --package=@launchrally/cli@0.3.0 -- rally audit --plain --cwd . --output ./launchrally-audit-report.json
npm exec --package=@launchrally/cli@0.3.0 -- rally init --plain --cwd . --report ./launchrally-audit-report.json
npm exec --package=@launchrally/cli@0.3.0 -- rally --version --json --cwd .
```

npm may show its normal download confirmation. LaunchRally does not bypass it. In Agent Mode, use `--json` and follow each returned typed state rather than Human Mode prose.

## Launcher and Engine version behavior

An uninitialized repository uses the Engine bundled with the supported Launcher. A complete initialized repository uses its validated project-pinned Engine instead:

- A same-version Launcher follows the project pin.
- A supported newer Launcher follows the older valid project pin without repinning it.
- A supported older Launcher follows the newer valid project pin when its v1 compatibility matrix allows it.
- An unavailable or invalid Project Toolchain fails closed. The Launcher never substitutes its bundled Engine.

The Execution Authority guarantee begins with Launchers that implement `launchrally.dev/execution-authority/v1`. Historical direct binaries and manual Engine execution cannot be retroactively intercepted.

## Install and verify a Plugin

CLI installation is a prerequisite separate from Plugin installation. First require a successful `rally --version --json --cwd .`; then install one host adapter. The Agent's first LaunchRally operation must repeat that structured discovery and validate Plugin, Launcher, selected Engine, project pin, and contract compatibility as separate facts.

### Codex Plugin

Pin the marketplace checkout to the exact release tag and install at user scope:

```bash
codex plugin marketplace add codeacme17/launchrally --ref v0.3.0
codex plugin add launchrally@launchrally
codex plugin list --json
```

The JSON list must contain the installed `launchrally@launchrally` Plugin. Then ask Codex to use LaunchRally in a repository. Its first compatibility check must run `rally --version --json --cwd .` and accept only a supported Launcher, Plugin, selected Engine, project pin, and contract combination. The Skill must stop for all missing prerequisites, permissions, and lifecycle approvals.

Update deliberately by replacing the installed Plugin and exact marketplace checkout:

```bash
codex plugin remove launchrally@launchrally
codex plugin marketplace remove launchrally
codex plugin marketplace add codeacme17/launchrally --ref v0.3.0
codex plugin add launchrally@launchrally
```

Remove only the Plugin and catalog entry with:

```bash
codex plugin remove launchrally@launchrally
codex plugin marketplace remove launchrally
```

### Claude Plugin

The `0.3.0` marketplace catalog pins `@launchrally/claude-plugin@0.3.0`. Add it and install at explicit user scope:

```bash
claude plugin marketplace add codeacme17/launchrally --scope user
claude plugin install launchrally@launchrally --scope user
claude plugin list --json
```

The JSON list must contain the installed and enabled `launchrally@launchrally` Plugin. Then ask Claude Code to use LaunchRally. Its first compatibility check must run `rally --version --json --cwd .` and accept only the same supported Launcher, Plugin, selected Engine, project pin, and contract combination as Codex.

Refresh and update deliberately:

```bash
claude plugin marketplace update launchrally
claude plugin update launchrally@launchrally --scope user
```

Remove it from user scope:

```bash
claude plugin uninstall launchrally@launchrally --scope user
claude plugin marketplace remove launchrally
```

Plugin removal preserves project-owned `.launchrally` data, the Project Toolchain, Manifest, Reports, Evidence, and immutable history. It also leaves the global Launcher installed.

## Explicit Launcher lifecycle

Reinstall the exact current Launcher to update or repair the user-managed PATH entry:

```bash
npm install --global @launchrally/cli@0.3.0
rally --version --json
```

An explicit downgrade to the historical release is:

```bash
npm install --global @launchrally/cli@0.2.2
rally --version --json
```

Published pre-v1 Launchers, including the historical direct `0.2.2` binary and earlier releases, predate the interception guarantee. The older command is documented only as an explicit Launcher downgrade, not as a safe way to bypass project authority.

Remove the global Launcher independently:

```bash
npm uninstall --global @launchrally/cli
```

Launcher removal preserves every repository's `.launchrally` data, Project Toolchain pin, Manifest, Reports, Evidence, and immutable history. Reinstall an exact supported Launcher before using those repositories again.

## Explicit Project Toolchain lifecycle

These commands act only on the repository selected by `--cwd`. Each mutation shows typed effects and requires its own permission or confirmation when applicable:

```bash
rally toolchain status --json --cwd .
rally toolchain restore --cwd .
rally toolchain migrate --to 0.3.0 --cwd .
rally toolchain migrate --to 0.2.2 --cwd .
rally toolchain clean --cwd .
```

- `status` is read-only and reports Execution Authority.
- `restore` rebuilds the established exact pin, offline-first, without changing its version.
- `migrate` is the only operation that changes an established pin. Upgrade to `0.3.0` or downgrade to the allowlisted legacy `0.2.2` only after reviewing the exact preview. Migration preserves the Manifest and immutable Reports/Evidence/history, marks the prior current Report non-current with `execution_authority_changed`, and requires a fresh full Verify.
- `clean` removes only ignored rebuildable materialization and temporary lifecycle state. It preserves the pin, authority descriptor, Manifest, Reports, Evidence, and history.

Never use Init as a migration mechanism. A fresh clone with committed metadata uses `status`, then explicit `restore` if materialization is missing.

## Project data retention and deletion

Uninstall and clean do not delete project-owned data. Back up anything you need before full project-data deletion; this is a separate manual and destructive action that removes the Project Toolchain, Manifest, Reports, Evidence, and immutable history.

From the confirmed repository root, use the command for your shell:

```bash
rm -rf .launchrally
```

```powershell
Remove-Item -Recurse -Force .launchrally
```

Neither command removes an external Report saved outside `.launchrally`. Review the target path before running either command.

## Troubleshooting

### `command not found: rally` or a missing PATH entry

Expose the active prefix only in the current shell, then verify the Launcher. On macOS or Linux (POSIX shell):

```bash
export PATH="$(npm prefix --global)/bin:$PATH"
rally --version --json
```

In PowerShell:

```powershell
$env:Path = "$(npm prefix --global);$env:Path"
rally --version --json
```

At an interactive `cmd.exe` prompt:

```batch
for /f "delims=" %i in ('npm prefix --global') do set "PATH=%i;%PATH%"
rally --version --json
```

These commands do not persist a profile change. If verification succeeds, configure that same directory through your own shell or operating-system policy. Do not invoke a Project Toolchain Engine directly as a workaround.

### npm prefix permission errors

A prefix permission failure means the active global prefix is not user-writable. Prefer a Node version manager. If you deliberately choose npm's per-user prefix fallback, run the matching commands yourself; the prefix setting persists in your npm user configuration while the PATH change affects only the current shell.

On macOS or Linux (POSIX shell):

```bash
npm config set prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
npm install --global @launchrally/cli@0.3.0
rally --version --json
```

In PowerShell:

```powershell
npm config set prefix "$env:LOCALAPPDATA\npm"
$env:Path = "$env:LOCALAPPDATA\npm;$env:Path"
npm install --global @launchrally/cli@0.3.0
rally --version --json
```

At an interactive `cmd.exe` prompt:

```batch
npm config set prefix "%LOCALAPPDATA%\npm"
set "PATH=%LOCALAPPDATA%\npm;%PATH%"
npm install --global @launchrally/cli@0.3.0
rally --version --json
```

LaunchRally never performs this configuration and does not recommend elevated npm installation.

### Node version-manager changes

A Node version manager may keep separate global prefixes for each Node version. After switching Node versions, confirm `node --version` and `npm prefix --global`, reinstall `@launchrally/cli@0.3.0` under the active user-writable prefix when necessary, and re-run structured verification.

### Project mismatch or lifecycle state

Run `rally toolchain status --json --cwd .` in the intended repository. `needs_toolchain_restore` requires explicit `rally toolchain restore --cwd .`; `needs_toolchain_migration` requires the exact approved migrate command; `invalid_toolchain` requires inspection and correction of the owned metadata. None of these states may fall back to the Launcher Engine.

### Unavailable materialization, offline cache, or registry denial

Init and restore try the npm offline cache first. A cache miss produces one bounded `npm_registry_read` request for the exact package and official registry with lifecycle scripts disabled. A registry denial leaves the project pin and adopted state unchanged.

In an environment authorized to read the registry, populate and verify npm's cache for the exact Engine required by the typed permission. For a `0.2.2` pin:

```bash
npm cache add @launchrally/cli@0.2.2
npm cache verify
```

For a `0.3.0` pin:

```bash
npm cache add @launchrally/cli@0.3.0
npm cache verify
```

Make that authorized npm cache available through your organization's normal cache-transfer mechanism, then retry the original operation without changing its version:

```bash
rally toolchain restore --cwd .
```

For an uninitialized repository, retry the exact `rally init --plain --cwd . --report ./launchrally-audit-report.json` command instead. Otherwise approve the disclosed bounded registry read. Never copy an unvalidated Engine into the toolchain.

### Invalid toolchains and interrupted migration

Do not edit package, lock, descriptor, or materialization files independently and do not run a direct Engine. Use `rally toolchain status --json --cwd .`; preserve the typed reason and next action. `clean` may discard rebuildable materialization and abandoned preview state, while restore must reproduce the exact established pin. Transaction recovery fails closed rather than exposing mixed versions.

### Legacy 0.2.2 projects

A legacy 0.2.2 project retains its exact pin. With a supported v1 Launcher, inspect status and explicitly restore missing materialization through the allowlisted compatibility adapter. Migration to `0.3.0` is optional and never automatic:

```bash
rally toolchain status --json --cwd .
rally toolchain restore --cwd .
rally toolchain migrate --to 0.3.0 --cwd .
```

### No installed Launcher

For an interactive or Agent journey, repeat the exact installation and structured verification at the top of this guide. For a deliberate no-install trial or CI run, use the complete npm-exec sequence above; do not follow an ephemeral Audit with a bare `rally` command.

## Verifying a source release

From a release checkout with Node.js 22 or newer:

```bash
npm ci --ignore-scripts
npm run build
npm run validate:release
npm run test:artifacts
npm test
```

Release validation rejects version drift, dependency ranges, lifecycle install hooks, stale Skill copies, and unexpected tarball files. Publishing is performed only by the protected release workflow for the matching exact `v0.3.0` tag. Maintainers use the [Experimental release runbook](../maintainers/release-runbook.md) for external control checks and public smoke evidence.
