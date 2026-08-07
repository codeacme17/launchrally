# Coverage Acceptance Matrix

LaunchRally's coverage fixtures are test representatives, not a support allowlist. They prove that the framework-neutral Baseline accepts varied repository shapes and reports the depth it can actually support. No framework or deployment Provider is an entry requirement.

## Representative ecosystems

| Fixture | Ecosystem and topology | Deployment shape | Expected specialized support |
| --- | --- | --- | --- |
| `fixtures/coverage/typescript-astro` | TypeScript meta-framework | Hosted Web | No required Profile or Provider Adapter |
| `fixtures/coverage/python-fastapi` | Python server framework | Container/PaaS | No required Profile or Provider Adapter |
| `fixtures/coverage/split-react-go` | Split React frontend and Go backend | Hosted Web | No required Profile or Provider Adapter |
| `fixtures/coverage/pnpm-edge-monorepo` | pnpm multi-app monorepo | Edge/Serverless | No required Profile or Provider Adapter |
| `fixtures/coverage/custom-self-hosted` | Custom framework without a Deep Support Profile | Self-hosted/custom | No Profile or Provider Adapter |

The machine-readable source is `fixtures/coverage/matrix.json`. Adding a representative expands acceptance coverage; it does not declare that other identities are unsupported.

## Run the public demos

Start Agent Mode against any representative:

```bash
node packages/cli/bin/rally.js audit --json --cwd fixtures/coverage/typescript-astro
node packages/cli/bin/rally.js audit --json --cwd fixtures/coverage/python-fastapi
node packages/cli/bin/rally.js audit --json --cwd fixtures/coverage/split-react-go
node packages/cli/bin/rally.js audit --json --cwd fixtures/coverage/pnpm-edge-monorepo
node packages/cli/bin/rally.js audit --json --cwd fixtures/coverage/custom-self-hosted
```

Each first response requests typed release intent. Confirm the inferred project facts and permission plan through the returned structured states. The complete path requires no LaunchRally account or private service.

Natural-language Skill examples are equally ecosystem-neutral:

- “Audit this TypeScript meta-framework repository for launch readiness.”
- “Check this Python server and container deployment.”
- “Assess this split frontend/backend project.”
- “Audit all apps in this monorepo for an Edge release.”
- “Run the Baseline on this custom self-hosted framework.”

## Interpret reduced depth

The Baseline always reports the same versioned Check Catalog and policy semantics. When a repository has no matching Deep Support Profile, or its declared Provider has no read-only Adapter, LaunchRally preserves the journey and returns explicit Unverified Checks and Verification Gaps. It does not infer Passed, `Launch Ready`, or Unsupported Project from an unknown identity.

The automated matrix completes direct CLI Audit, Init, Plan, and full Verify for all five representatives. Native Skill journeys complete the same flow for the TypeScript and Python representatives with both approved public reads and denied partial permission. Every Init uses the isolated committed `.launchrally/toolchain` npm files and leaves application manifests and lockfiles unchanged. Quality-floor assertions require secret-safe output, no activity beyond granted permissions, provenance-backed Evidence for every Passed result, and an Assessment other than `Launch Ready` whenever Evidence remains insufficient.
