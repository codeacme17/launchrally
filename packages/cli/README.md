# @launchrally/cli

The LaunchRally CLI audits and verifies whether an existing repository is ready for a production launch. It provides the `rally` command and keeps the first audit local-first, account-free, and output-only.

## Status

LaunchRally 0.2.1 is an **Experimental P0** release. P0 is Product Complete, not a stability claim or a P0 Validated decision. Review every disclosed permission and preview before continuing.

## First audit

Run the exact release without a global installation:

```sh
npm exec --package=@launchrally/cli@0.2.1 -- rally audit --json --cwd .
```

The initial audit reads safe, allowlisted facts from the repository you select. It does not require an account, add telemetry, change project files, stage or commit changes, provision infrastructure, or deploy. Any optional public or Provider read is disclosed separately for approval.

See the [Quickstart](https://github.com/codeacme17/launchrally/blob/main/docs/getting-started/quickstart.md) for the Audit → Plan/Remediate → Verify journey and the [privacy boundary](https://github.com/codeacme17/launchrally/blob/main/docs/concepts/privacy.md) for the complete read/write policy.

## Compatibility

The CLI requires Node.js 20.12.0 or newer and is verified on Node.js 20, 22, and 24. Use the package-manager command above so npm can show its normal confirmation; do not bypass that confirmation or use a global installation.

## Documentation

- [Install and release guide](https://github.com/codeacme17/launchrally/blob/main/docs/getting-started/install.md)
- [Quickstart](https://github.com/codeacme17/launchrally/blob/main/docs/getting-started/quickstart.md)
- [Data model](https://github.com/codeacme17/launchrally/blob/main/docs/concepts/data-model.md)
- [Privacy and permissions](https://github.com/codeacme17/launchrally/blob/main/docs/concepts/privacy.md)

## Project

[Repository](https://github.com/codeacme17/launchrally) · [Issues](https://github.com/codeacme17/launchrally/issues) · [Security](https://github.com/codeacme17/launchrally/security/policy)

Licensed under [Apache-2.0](https://github.com/codeacme17/launchrally/blob/main/LICENSE).
