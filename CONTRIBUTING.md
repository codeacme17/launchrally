# Contributing to LaunchRally

LaunchRally is a Stable open-source project under Apache-2.0. P0 is Product Complete and publicly released. LaunchRally is P0 Validated and the Quality Floor is satisfied. By submitting a contribution, you agree that it is licensed under Apache-2.0 and that you have the right to submit it.

## Choose a feedback path

- Use [GitHub Discussions](https://github.com/codeacme17/launchrally/discussions) for questions, voluntary field reports, represented framework or deployment contexts, and P1 requests.
- Use [GitHub Issues](https://github.com/codeacme17/launchrally/issues) for reproducible defects and scoped feature work.
- Follow [SECURITY.md](SECURITY.md) instead of opening a public issue for a suspected vulnerability.

Do not include credentials, private repository contents, Report or Evidence files, private deployment identifiers, or personal data. A useful field report can name the general framework and deployment context, the affected journey stage, and a minimal synthetic reproduction.

## Pull requests

Open feature and fix pull requests against `dev`. Promotion to `main` happens through a `dev` to `main` release pull request.

Before opening a pull request:

```bash
npm ci --ignore-scripts
npm run build
npm test
npm run validate:acceptance
npm run validate:p0
npm run validate:release
npm run test:artifacts
```

Generated Plugin Skill copies must remain synchronized with the canonical Skill. Update tests at public behavior seams and preserve the local-first permission boundaries.

Validation Log changes must append aggregate non-identifying entries without editing reviewed history. Use the per-field taxonomy documented in the validation guide; extend it in the same pull request when a new aggregate category is needed, and never substitute raw field-report text. P1 discovery, design, and authority-expanding implementation are allowed while the committed qualitative decision remains P0 Validated and the Quality Floor remains satisfied.
