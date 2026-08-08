# Repository Guidelines

## Project Structure & Module Organization

LaunchRally is an ESM npm workspace. Under `packages/`, `core` contains audit and verification logic, `contracts` owns schemas and constants, and `cli` provides the `rally` executable. `skills/launchrally/` is the canonical Agent Skill; `adapters/codex/` and `adapters/claude/` contain generated copies. Keep tests in `test/` as `*.test.js`, with fixtures and helpers in its named subdirectories. Documentation belongs in `docs/`; release metadata and validation scripts live in `release/` and `scripts/`.

## Build, Test, and Development Commands

- `npm ci --ignore-scripts`: install dependencies safely (Node.js 20.12 or newer).
- `npm run build`: synchronize the canonical skill into adapter packages.
- `npm run rally -- audit --json --cwd .`: run the source-checkout CLI against this repository.
- `npm test`: verify generated skill copies, then run the complete `node:test` suite.
- `npm run validate:acceptance`: check acceptance coverage and traceability.
- `npm run validate:p0` and `npm run validate:release`: enforce P0 and release gates.
- `npm run test:artifacts`: validate packaged release artifacts.

Run `npm run validate` for the normal test-plus-acceptance gate. Before a release-oriented PR, run every command listed in `CONTRIBUTING.md`.

## Coding Style & Naming Conventions

Follow `.editorconfig`: UTF-8, LF endings, final newline, two-space indentation, and no trailing whitespace except where Markdown requires it. Use ESM imports, semicolons, double quotes, trailing commas in multiline structures, and explicit `.js` extensions. Name files and schema directories in kebab-case (`provider-guidance.js`); use camelCase for functions and SCREAMING_SNAKE_CASE for constants. There is no separate formatter or linter, so match nearby code.

## Testing Guidelines

Use `node:test` with `node:assert/strict`. Write behavior-focused test names and keep tests deterministic and serial where scripts require it. Add or update tests at every changed public behavior or safety boundary. No numeric coverage threshold is configured; acceptance traceability is the enforced coverage gate.

## Commit & Pull Request Guidelines

History uses Conventional Commit subjects such as `feat: complete human mode audit wizard (#56)` and `fix: support exact Node 20.12 runtime`. Keep commits scoped and imperative. Open feature and fix PRs against `dev`; only release promotion PRs target `main`. Include a concise rationale, linked issue, validation commands/results, and screenshots or terminal output for user-visible CLI changes.

## Security & Generated Files

Preserve local-first permission boundaries and never commit credentials, private repository data, reports, evidence, deployment identifiers, or personal data. Report vulnerabilities through `SECURITY.md`. Edit the canonical skill first, run `npm run build`, and commit synchronized adapter copies.
