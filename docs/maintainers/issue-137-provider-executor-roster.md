# Issue 137 Provider and Executor roster research

Review date: 2026-08-14

This note records the researched initial reference roster for
[#137](https://github.com/codeacme17/launchrally/issues/137). It is an input to
implementation, not a support claim. The roster was selected from the generic
Capability and Integration contracts by behavioral diversity, safe evidence
depth, and maintenance cost. Provider event and command names remain inside
Cards, Packs, Adapters, and Executor tool declarations.

## Decision

Ship 13 unique Providers across eight integration families and exactly two
Agent Executors. Some Providers appear in more than one family; each family
still has two materially different managed implementations.

| Integration family | Managed reference implementations | Why materially different |
| --- | --- | --- |
| Identity to application data | Clerk; Supabase Auth | Dedicated identity control plane versus identity embedded in an open-source backend platform. Clerk application reads omit secret keys by default, while Supabase Auth stores identities in the `auth` schema. [Clerk Platform API](https://clerk.com/docs/reference/platform-api/tag/applications) [Supabase Auth architecture](https://supabase.com/docs/guides/auth/architecture) |
| Payment to entitlement | Stripe Billing and Entitlements; Paddle Billing | A payment-platform entitlement feature versus a merchant-of-record billing lifecycle. Stripe publishes versioned API behavior and a first-party Entitlements model; Paddle documents subscription provisioning through ordered webhook state changes. [Stripe API versioning](https://docs.stripe.com/api/versioning) [Stripe Entitlements](https://docs.stripe.com/billing/entitlements) [Paddle webhooks](https://developer.paddle.com/webhooks/) |
| Source to CI/CD to deployment | GitHub Actions to Vercel; GitHub Actions to Cloudflare Workers | The same source/CI boundary feeds a project deployment platform and an edge runtime deployment model. GitHub environments can gate jobs and secrets; Vercel and Wrangler expose distinct deployment state and commands. [GitHub deployment control](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments) [Vercel CLI](https://vercel.com/docs/cli) [Wrangler deployments](https://developers.cloudflare.com/workers/wrangler/commands/workers/) |
| Storage to metadata/access | Cloudflare R2; Supabase Storage | S3-compatible object storage versus storage whose authorization is integrated with Postgres Row Level Security. [R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/) [Supabase Storage access control](https://supabase.com/docs/guides/storage/security/access-control) |
| Email to domain/delivery | Resend; Twilio SendGrid | A compact developer email API/CLI versus a mature email platform with authenticated-domain and aggregate-statistics APIs. [Resend CLI](https://resend.com/docs/cli) [SendGrid authenticated domains](https://www.twilio.com/docs/sendgrid/api-reference/domain-authentication/list-all-authenticated-domains) [SendGrid global statistics](https://www.twilio.com/docs/sendgrid/api-reference/stats/retrieve-global-email-statistics) |
| Release to observability | Sentry; Honeycomb | Error/release tracking versus marker-based observability over telemetry datasets. [Sentry Releases API](https://docs.sentry.io/api/releases/) [Honeycomb markers API](https://docs.honeycomb.io/api/markers/list-all-markers) |
| Backup to restore | Neon; Supabase Database | Branch/snapshot-oriented Postgres recovery versus managed daily backups and point-in-time recovery with documented downtime and plan boundaries. [Neon API](https://api-docs.neon.tech/reference/getting-started-with-neon-api) [Supabase backups](https://supabase.com/docs/guides/platform/backups) |
| Queue/background work | Cloudflare Queues; Amazon SQS | A Workers-integrated queue with batching, retries, delays, and dead-letter queues versus a region-scoped independent queue service with a stable API version. [Cloudflare Queues](https://developers.cloudflare.com/queues/) [Amazon SQS API](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ListQueues.html) |

The exact unique Provider set is Clerk, Supabase, Stripe, Paddle, GitHub,
Vercel, Cloudflare, Resend, Twilio SendGrid, Sentry, Honeycomb, Neon, and
Amazon SQS.

Datadog was considered for the second observability fixture, but the official
CI-provider deployment visibility path is still documented as Preview.
Honeycomb's stable marker API is the lower-maintenance initial reference.
[Datadog CI-provider deployments](https://docs.datadoghq.com/continuous_delivery/deployments/ciproviders/)

## Product-shape coverage

| Product shape | Reference composition | Boundary |
| --- | --- | --- |
| Content/marketing Web | GitHub Actions with Vercel or Cloudflare Workers; Resend or SendGrid | No identity, billing, database, or queue requirement is inferred merely from the shape. |
| Subscription SaaS | Clerk or Supabase Auth; Stripe or Paddle; Neon or Supabase Database | Provider events normalize into generic identity, billing, entitlement, and data semantics. |
| Media/productivity with async processing | R2 or Supabase Storage; Cloudflare Queues or SQS; an email and observability fixture | Object payloads and queue messages stay outside retained evidence. |
| Custom/self-hosted Web | Generic `custom`, `self_hosted`, or `unknown` binding plus local/manual evidence | No managed Provider is invented and no deep Adapter is implied. |
| Desktop with shared backend | Reuse the SaaS/backend packs for declared shared-backend capabilities | Signing, notarization, store review, distribution, and updater readiness remain excluded. |

## Safe read and write depth

The initial read Adapters should retain only the fields below. Raw Provider
responses are transient, and no retained fixture may include credentials,
secrets, personal data, production payloads, or repository identity.

| Family | Safe retained read | Permitted bounded write | Prohibited or discarded |
| --- | --- | --- | --- |
| Identity | Application/tenant identity; environment or instance type; non-secret configuration state | Synthetic user create/login/delete only as an explicit non-production active test | Users, profile/claim values, sessions, PII, impersonation links, secret/publishable keys, key rotation. Clerk application reads must keep `include_secret_keys=false`. [Clerk Platform API](https://clerk.com/docs/reference/platform-api/tag/applications) |
| Payment/entitlement | Product and price identifiers/status; webhook configuration shape and subscribed event names; entitlement-feature mapping | Catalog, webhook, and entitlement-configuration writes in a separately confirmed non-production batch; synthetic checkout/void active test | Customers, subscriptions, transactions, invoices, payment methods, notification secrets, financial payloads; charges, refunds, cancellations, and customer mutation. Paddle's webhook events drive app provisioning but remain Pack-local names. [Stripe Entitlements](https://docs.stripe.com/billing/entitlements) [Paddle webhook lifecycle](https://developer.paddle.com/webhooks/about/how-webhooks-work/) |
| Source/CI/deployment | Workflow/run/environment/deployment identifiers, state, commit digest, and timestamps | Source-file change, environment configuration, CI dispatch, and deployment each require separate authority and effects | Secret values, source content as Provider evidence, production promotion without explicit authority. GitHub environments delay secret access until protection rules pass. [GitHub deployment control](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments) |
| Storage | Bucket identity, location/class, public/private state, policy existence, and bounded aggregate counts | Bucket/policy configuration; one isolated synthetic-object round trip followed by deletion | Object keys, filenames, payloads, signed URLs, access keys, broad listing. AWS documents that `HEAD` retrieves metadata without an object body; use the same evidence depth for compatible stores. [Amazon S3 HeadObject](https://docs.aws.amazon.com/cli/latest/reference/s3api/head-object.html) |
| Email | Domain identity, verification and sending/receiving capability state, aggregate delivery counters | Synthetic send only to a generated test sink | Recipients, sender addresses, subjects, message IDs, bodies, attachments, DNS record values, API keys. Resend exposes safe domain state; avoid its message fields. [Resend list domains](https://resend.com/docs/api-reference/domains/list-domains) |
| Observability | Project identity, release version/state, and deployment-marker metadata | Create one release/deployment marker bound to the synthetic fixture | Issues, events, logs, traces, stack frames, request bodies, user context, arbitrary telemetry queries. Sentry mutations require broader scopes than reads, so the descriptor must keep marker writes separate. [Sentry permissions](https://docs.sentry.io/api/permissions/) |
| Backup/restore | Backup/snapshot/branch identity, availability, retention window, and operation state | Restore only as a separately confirmed `production_data` effect with exact environment, target, and point in time | Backup contents, credentials, blind retries, implicit overwrite. Supabase warns that restore causes downtime and that database backups exclude Storage objects. [Supabase backups](https://supabase.com/docs/guides/platform/backups) |
| Queue | Queue identity or URL, region, configuration, DLQ binding, and aggregate metrics | Queue/DLQ configuration; send/receive/delete only on an isolated synthetic queue | Message bodies, production receive, retained message identifiers, production purge. Cloudflare documents retries/delays/DLQs; SQS list is metadata-only. [Cloudflare Queues](https://developers.cloudflare.com/queues/) [SQS ListQueues](https://docs.aws.amazon.com/cli/latest/reference/sqs/list-queues.html) |

Every deep operation must have complete, partial, denied, stale, successful,
failed, and cleanup-failed outcomes. An unsupported sub-operation is a
transparent typed Gap; it does not make the entire Provider or product shape
unsupported.

## Command and API pins

Exact command versions are discovery facts, not permission to install or
update tools. The repository's existing authorities were reviewed on
2026-08-12, but several upstream versions changed before this roster review.
Implementation should deliberately refresh the authority, fixtures, and
digests together; it must not silently float versions.

Exact pins reviewed on 2026-08-14 are:

| Tool or API | Exact pin | Official provenance |
| --- | --- | --- |
| Clerk CLI | `3.1.0` | [Official documentation](https://clerk.com/docs/cli) [Official npm registry](https://www.npmjs.com/package/clerk) |
| Wrangler | `4.122.0` | [Official installation documentation](https://developers.cloudflare.com/workers/wrangler/install-and-update/) [Official npm registry](https://www.npmjs.com/package/wrangler) |
| Neon CLI | `3.2.0` | [Official documentation](https://neon.com/cli) [Official npm registry](https://www.npmjs.com/package/neonctl) |
| Resend CLI | `2.12.0` | [Official documentation](https://resend.com/docs/cli) [Official npm registry](https://www.npmjs.com/package/resend-cli) |
| Sentry CLI | `3.6.2` | [Official documentation](https://docs.sentry.io/cli/) [Official npm registry](https://www.npmjs.com/package/@sentry/cli) |
| Vercel CLI | `58.11.0` | [Official documentation](https://vercel.com/docs/cli) [Official npm registry](https://www.npmjs.com/package/vercel) |
| Supabase CLI | `2.114.0`, published 2026-08-12 | [Official release](https://github.com/supabase/cli/releases/tag/v2.114.0) |
| Stripe CLI | `1.45.2`, published 2026-08-10 | [Official release](https://github.com/stripe/stripe-cli/releases/tag/v1.45.2) |
| GitHub CLI | `2.97.0`, published 2026-07-31 | [Official release](https://github.com/cli/cli/releases/tag/v2.97.0) |
| AWS CLI | `2.36.4` documentation line | [Official SQS command reference](https://docs.aws.amazon.com/cli/latest/reference/sqs/list-queues.html) |
| Stripe API | `2026-07-29.dahlia` | [Official API versioning](https://docs.stripe.com/api/versioning) |
| GitHub REST API | `2026-03-10` | [Official environments reference](https://docs.github.com/en/rest/deployments/environments?apiVersion=2026-03-10) |
| Paddle API | `1` | [Official API versioning](https://developer.paddle.com/api-reference/about/versioning/) |
| Amazon SQS API | `2012-11-05` | [Official API common parameters](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/CommonParameters.html) |

Paddle, SendGrid, and Honeycomb should begin as versioned HTTP Adapters/Packs,
not as additional CLI dependencies. Their official API documentation is the
maintained command authority.

## Executor roster

Ship exactly two reviewed Agent Executor Descriptors:

| Executor | Exact tool version | Provenance and review boundary | Initial authority |
| --- | --- | --- | --- |
| Codex CLI | `0.147.0` | Published 2026-08-07. [Official release](https://github.com/openai/codex/releases/tag/rust-v0.147.0) [Official package](https://www.npmjs.com/package/@openai/codex) | Local-source work and explicitly enumerated tool calls/effects from a confirmed Handoff; never infer Provider, deployment, secret, or production-data authority. |
| Claude Code | `2.1.231` | Published 2026-08-13. [Official release](https://github.com/anthropics/claude-code/releases/tag/v2.1.231) [Official CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage) | Same generic task/effect boundary. Use structured output and allow/disallow tool controls; never use permission bypass. |

Provider CLIs are exact tools that an Executor may disclose; they are not
additional Executors. Custom/self-hosted/manual fallback is not an Executor
Descriptor because the current contract requires exact versioned tools.
Missing, unreviewed, denied, expired, and capability-mismatched Executors stay
typed Handoff outcomes.

## Fixture boundaries

Create deterministic synthetic fixtures at the generic semantic boundary,
then project Provider-specific inputs into them:

1. One canonical fixture per family with stable fixture, correlation,
   environment, source-capability, target-capability, and evidence IDs.
2. Two Provider input variants per critical family that normalize to the same
   generic Integration Contract and expected observations. Provider event
   names, API paths, command tokens, and raw fields exist only in the Pack.
3. Generic `unknown`, `custom`, `self_hosted`, and `retain_existing` variants
   with no deep Provider assumptions.
4. Executor variants for available/reviewed, missing, denied, expired,
   version-mismatched, capability-mismatched, cancellation, and partial
   failure paths.
5. Tamper fixtures for Card/Pack/Descriptor digest, provenance URL, review
   date, version, allowed effects, prohibited effects, requested fields,
   normalized evidence, and receipt binding.
6. Active-test fixtures use non-production targets, unique synthetic markers,
   bounded observation windows, deterministic cleanup, and explicit
   cleanup-failed results. Do not retain raw Provider output or payloads.

Special negative assertions are required for known source hazards:

- Clerk responses containing secret keys must discard them.
- Paddle notification settings containing `endpoint_secret_key` must discard
  it.
- Resend/SendGrid responses containing recipients, subjects, message IDs, or
  content must discard them.
- Supabase database-backup success must not imply Storage-object recovery;
  assurance stays facet-specific.
- Queue fixtures containing a message body must be rejected before evidence
  creation.
- Unknown combinations preserve supported neighboring facets instead of
  collapsing the whole Provider or product to unsupported.

## Maintenance policy

- Give every Card, Pack, Adapter, Descriptor, and installation authority an
  official source set, exact semantic or command version, `reviewed_at`, and
  `expires_at` no later than 90 days after review.
- Re-review before expiry and whenever a pinned command fails, a normalized
  response changes, an API version becomes sunset, or an official source
  materially changes.
- Run all fixtures offline in normal CI. Live Provider checks are optional,
  non-gating maintainer work and may record only non-sensitive conclusions.
- A newer upstream version does not silently replace the exact reviewed pin.
  Refresh provenance, negative fixtures, tamper digest, and behavior tests
  together.
