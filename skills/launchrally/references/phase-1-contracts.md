# Phase 1 contract foundation

Phase 1 records use the exact schema version declared in each object. Validate them through `@launchrally/contracts`; do not reconstruct a record from terminal prose or accept an unknown major or enum value.

The contract foundation defines Product Intent Profile, Provider Knowledge, Capability Catalog and Graph, Integration Contract, Architecture Blueprint and Record, Architecture Package, Task Graph, Executor Descriptor, Handoff Package, Execution Receipt, active-verification request and result, Architecture Status, and typed `architect` and `handoff` interactions.

Preserve these distinctions:

- Agent inference is not confirmed Product Intent.
- Requirement, decision, implementation, and Evidence states are orthogonal.
- Architecture Status is independent from Launch Assessment.
- An installed or discovered Executor has no authority until an exact Handoff Package receives explicit user confirmation.
- An Execution Receipt is a claim with `machine_evidence: false`; fresh qualifying Verify is required.
- Evidence and active verification are environment-bound.
- Raw source, Provider output, stdout, stderr, response bodies, secrets, credentials, business payloads, and real-user data must not enter persisted Phase 1 records.
- Local Semantic Analysis is a fresh permission above Local Safe Scan and applies only to explicitly selected supported product materials; denial or incomplete coverage remains visible.
- The Capability Catalog covers all 13 launch domains. Derived obligations remain candidates until explicit confirmation, and Catalog changes invalidate only outputs that declare the changed capability or the whole Catalog as a dependency.
- Provider Knowledge is versioned independently from the Capability Catalog, remains advisory and non-Evidence, and is bound to exact source provenance, trust tier, review/expiry dates, and digest.

The CLI implements typed `rally architect` Blueprint review and independent decision confirmation. The schemas do not yet implement external execution, `rally handoff`, or active verification. Until the CLI advertises and returns those exact typed contracts, do not synthesize them, invoke an Executor, or infer new authority from these record definitions.
