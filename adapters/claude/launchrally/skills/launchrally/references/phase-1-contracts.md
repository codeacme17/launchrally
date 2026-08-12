# Phase 1 contract foundation

Phase 1 records use the exact schema version declared in each object. Validate them through `@launchrally/contracts`; do not reconstruct a record from terminal prose or accept an unknown major or enum value.

The contract foundation defines Product Intent Profile, Capability Catalog and Graph, Integration Contract, Architecture Blueprint and Record, Architecture Package, Task Graph, Executor Descriptor, Handoff Package, Execution Receipt, active-verification request and result, Architecture Status, and typed `architect` and `handoff` interactions.

Preserve these distinctions:

- Agent inference is not confirmed Product Intent.
- Requirement, decision, implementation, and Evidence states are orthogonal.
- Architecture Status is independent from Launch Assessment.
- An installed or discovered Executor has no authority until an exact Handoff Package receives explicit user confirmation.
- An Execution Receipt is a claim with `machine_evidence: false`; fresh qualifying Verify is required.
- Evidence and active verification are environment-bound.
- Raw source, Provider output, stdout, stderr, response bodies, secrets, credentials, business payloads, and real-user data must not enter persisted Phase 1 records.

These schemas do not implement `rally architect`, external execution, `rally handoff`, or active verification. Until the CLI advertises and returns their exact typed contracts, do not synthesize those operations, invoke an Executor, or infer new authority from these record definitions.
