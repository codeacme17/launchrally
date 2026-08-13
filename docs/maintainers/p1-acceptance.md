# Phase 1 acceptance traceability

`release/p1-acceptance.json` is the repository-visible mapping for independent
Phase 1 requirements. It supplements the stable P0 acceptance contract and
does not change P0 release status.

| ID | Requirement | Executable evidence | Tracking | Status |
| --- | --- | --- | --- | --- |
| P1-AUTH-01 | Authenticated Core Journey success and failure qualify as normative Machine Evidence only under the exact provenance and freshness boundary; unavailable authentication remains a Gap | Phase 1 contract, Core policy, CLI interaction, and Codex/Claude Skill parity tests | #135 | Complete |
| P1-COMPAT-01 | Initialized Phase 0 projects stay usable until an additive transactional Phase 1 migration is explicitly confirmed | Architect interaction, Core migration, CLI, denial, and interruption tests | #136 | Complete |
| P1-ARCH-DESKTOP-01 | Desktop shared-backend architecture is typed while desktop distribution readiness remains explicitly excluded | Desktop Shared Backend contract, Core, CLI, and Architecture tests | #136 | Complete |
| P1-HOST-01 | Codex and Claude resume Architecture and Handoff state from exact validated local artifacts | Host Resume Artifact contract, both adapters, and cross-host tests | #136 | Complete |
| P1-COVERAGE-01 | Five product shapes and eight integration families retain Provider-neutral semantics across reviewed managed and generic fallback fixtures | Reference Integration Pack contract, coverage matrix, exact Executor descriptors, fixture and tamper tests | #137 | Complete |
| P1-DOCS-01 | Agent and Human users can follow the complete authority-aware Phase 1 journey with shell-portable commands from exact packed Skills | Public guide, canonical Skill route, packed POSIX/PowerShell argument-vector tests, and generated-copy validation | #138 | Complete |
