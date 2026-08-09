# Contributing to LaunchRally

LaunchRally is an Experimental open-source project under Apache-2.0. The P0 Product Complete claim is suspended while the Quality Floor regression is reviewed, and the Experimental release remains public. Aggregate directional-signal collection continues under the Telemetry-Free Validation learning process, but the machine validation authority state is suspended while the Quality Floor regression is open; LaunchRally is not P0 Validated. By submitting a contribution, you agree that it is licensed under Apache-2.0 and that you have the right to submit it.

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

Validation Log changes must append aggregate non-identifying entries without editing reviewed history. Use the per-field taxonomy documented in the validation guide; extend it in the same pull request when a new aggregate category is needed, and never substitute raw field-report text. P1 discovery and design are welcome; authority-expanding P1 implementation remains blocked until the committed qualitative decision is P0 Validated and the Quality Floor is satisfied.
