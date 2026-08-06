# Permissions

- Starting an Audit authorizes only the documented Local Safe Scan.
- Confirming an Audit Brief confirms scope; it grants no public or Provider permission.
- Public network Checks require their own decision for the disclosed target list.
- Provider reads require one decision per Provider and exact metadata scope.
- Preserve prior decisions when resuming. A decided boundary cannot change within the interaction.
- A denial produces an explicit Verification Gap; it never ends the entire Audit.
- Never request or persist secret values. Use the user's existing official Provider CLI or API session when that integration is implemented.
- Phase 0 never authorizes Provider writes, deployment, DNS changes, production environment writes, or production migrations.
