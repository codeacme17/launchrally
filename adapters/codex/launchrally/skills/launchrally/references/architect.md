# Architecture decision flow

Use `rally architect` only with a structurally valid current full Report, a confirmed Product Intent Profile, the matching Capability Catalog, and the matching Capability Graph. Prior Init is not required. Treat `stale_input` as a stop condition that requires a fresh Audit or Verify.

Present the complete whole-product Blueprint before requesting any decision confirmation. Keep hard constraints separate from preferences. A hard-constraint conflict is excluded and can never be recommended. Describe recommendations as fit under the confirmed constraints, never as a universal best Provider or as the output of an opaque score.

Preserve the Blueprint's integration compatibility, operational burden, cost drivers and assumptions, data flow and residency, failure domains, Provider concentration, lock-in and exit, duplication, migration cost, Unknowns, trade-offs, assumptions, and reevaluation triggers. A null currency estimate means no current official pricing was reviewed; never invent an exact bill.

Existing implementations default to retain. Replacement requires a positive rationale. After Blueprint confirmation, present each decision independently and submit only the builder's exact `confirm` or `reject` response. Partial completion is resumable and does not imply acceptance of pending or rejected decisions.

The flow is read-only. It grants no repository write, Provider write, deployment, or external Executor authority.
