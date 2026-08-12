# Permissions

- Starting an Audit authorizes only the documented Local Safe Scan.
- Confirming an Audit Brief confirms scope; it grants no public or Provider permission.
- Public network Checks require their own decision for the disclosed target list.
- Authenticated Core Journey reads require a separate decision for the versioned plan. Approval covers only its exact GET targets, authentication classes, expected status codes, and normalized result fields.
- Provider reads require one decision per Provider and exact metadata scope. Present every entry in `scope.commands`; approval covers only that disclosed sequence.
- Preserve prior decisions when resuming. A decided boundary cannot change within the interaction.
- A denial produces an explicit Verification Gap; it never ends the entire Audit.
- Keep authentication material inside the user's existing host or official Provider session. Collect only the CLI-disclosed normalized fields; never request, copy, print, pass, or persist cookies, headers, tokens, storage values, login credentials, response bodies, or account identifiers.
- Clerk reads application and instance environment metadata with `clerk apps list --json`.
- Neon reads JSON project, branch, and database metadata with the existing linked-project or single-project `neonctl` context and analytics disabled.
- Resend reads bounded JSON domain and sent-email status metadata with telemetry disabled; retain no address, subject, message ID, DNS record, or credential.
- Sentry reads project columns and raw release versions with the existing `sentry-cli` organization/project context and update checks disabled.
- Treat a missing tool or session, unsupported account context, malformed or oversized response, timeout, or Provider error as the returned Verification Gap. Never substitute local configuration or user statements for Machine Evidence.
- A Provider tool rediscovery may inspect only the returned exact-version verification command. Successful rediscovery creates a new pending Provider-read boundary; prior approval remains spent. Missing authentication remains separate and never starts login.
- Provider guidance reads local Decision Cards and performs no network access. Confirming a selection authorizes only the previewed local Manifest intent update.
- Phase 0 never authorizes Provider writes, deployment, DNS changes, production environment writes, or production migrations.
