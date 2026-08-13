# Phase 1 acceptance traceability

`release/p1-acceptance.json` is the repository-visible mapping for independent
Phase 1 requirements. It supplements the stable P0 acceptance contract and
does not change P0 release status.

| ID | Requirement | Executable evidence | Tracking | Status |
| --- | --- | --- | --- | --- |
| P1-AUTH-01 | Authenticated Core Journey success and failure qualify as normative Machine Evidence only under the exact provenance and freshness boundary; unavailable authentication remains a Gap | Phase 1 contract, Core policy, CLI interaction, and Codex/Claude Skill parity tests | #135 | Complete |
| P1-COMPAT-01 | Initialized Phase 0 projects stay usable until an additive transactional Phase 1 migration is explicitly confirmed | Architect interaction, Core migration, CLI, denial, and interruption tests | #136 | Complete |
| P1-HOST-01 | Codex and Claude resume Architecture and Handoff state from exact validated local artifacts | Host Resume Artifact contract, both adapters, and cross-host tests | #136 | Complete |
