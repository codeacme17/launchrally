# Permissions

- Starting an Audit authorizes only the documented Local Safe Scan.
- Confirming an Audit Brief confirms scope; it grants no public or Provider permission.
- Public network Checks require their own decision for the disclosed target list.
- Provider reads require one decision per Provider and exact metadata scope. Present every entry in `scope.commands`; approval covers only that disclosed sequence.
- Preserve prior decisions when resuming. A decided boundary cannot change within the interaction.
- A denial produces an explicit Verification Gap; it never ends the entire Audit.
- Never request or persist secret values. Use the user's existing official Provider CLI or API session when that integration is implemented.
- Clerk reads application and instance environment metadata with `clerk apps list --json`.
- Neon reads JSON project, branch, and database metadata with the existing linked-project or single-project `neonctl` context and analytics disabled.
- Resend reads bounded JSON domain and sent-email status metadata with telemetry disabled; retain no address, subject, message ID, DNS record, or credential.
- Sentry reads project columns and raw release versions with the existing `sentry-cli` organization/project context and update checks disabled.
- Treat a missing tool or session, unsupported account context, malformed or oversized response, timeout, or Provider error as the returned Verification Gap. Never substitute local configuration or user statements for Machine Evidence.
- Provider guidance reads local Decision Cards and performs no network access. Confirming a selection authorizes only the previewed local Manifest intent update.
- Phase 0 never authorizes Provider writes, deployment, DNS changes, production environment writes, or production migrations.
