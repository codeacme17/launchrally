# Permissions

- Starting an Audit authorizes only the documented Local Safe Scan.
- Public network Checks require approval of the disclosed target plan for that Audit.
- Provider reads require separate approval for each Provider and exact metadata scope.
- A denial produces an explicit Verification Gap; it never ends the entire Audit.
- Never request or persist secret values. Use the user's existing official Provider CLI or API session when that integration is implemented.
- Phase 0 never authorizes Provider writes, deployment, DNS changes, production environment writes, or production migrations.
