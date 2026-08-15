import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { computeReferenceIntegrationPackDigest } from "../packages/contracts/src/index.js";
import { referenceExecutorDescriptors } from "../packages/core/src/reference-executors.js";

const reviewedAt = "2026-08-14";
const expiresAt = "2026-11-12T00:00:00.000Z";
const allShapes = [
  "content_marketing_web",
  "subscription_saas",
  "media_productivity_async",
  "custom_self_hosted_web",
  "desktop_shared_backend",
];
const outcomes = [
  "complete", "partial", "denied", "unknown", "stale", "successful", "failed",
  "cleanup_failed",
];
const sources = {
  launchrally: ["LaunchRally generic contract", "https://github.com/codeacme17/launchrally/tree/dev/packages/contracts"],
  clerk: ["Clerk Platform API", "https://clerk.com/docs/reference/platform-api/tag/applications"],
  supabaseAuth: ["Supabase Auth architecture", "https://supabase.com/docs/guides/auth/architecture"],
  stripe: ["Stripe API versioning", "https://docs.stripe.com/api/versioning"],
  paddle: ["Paddle API versioning", "https://developer.paddle.com/api-reference/about/versioning/"],
  github: ["GitHub deployment control", "https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments"],
  vercel: ["Vercel CLI", "https://vercel.com/docs/cli"],
  cloudflareWorkers: ["Wrangler deployments", "https://developers.cloudflare.com/workers/wrangler/commands/workers/"],
  r2: ["Cloudflare R2 S3 API", "https://developers.cloudflare.com/r2/api/s3/api/"],
  supabaseStorage: ["Supabase Storage access control", "https://supabase.com/docs/guides/storage/security/access-control"],
  resend: ["Resend CLI", "https://resend.com/docs/cli"],
  sendgrid: ["SendGrid authenticated domains", "https://www.twilio.com/docs/sendgrid/api-reference/domain-authentication/list-all-authenticated-domains"],
  sentry: ["Sentry Releases API", "https://docs.sentry.io/api/releases/"],
  honeycomb: ["Honeycomb markers API", "https://docs.honeycomb.io/api/markers/list-all-markers"],
  neon: ["Neon API", "https://api-docs.neon.tech/reference/getting-started-with-neon-api"],
  supabaseBackup: ["Supabase backups", "https://supabase.com/docs/guides/platform/backups"],
  cloudflareQueues: ["Cloudflare Queues", "https://developers.cloudflare.com/queues/"],
  sqs: ["Amazon SQS API", "https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ListQueues.html"],
};
const specifications = [
  {
    file: "identity-to-application-data.json",
    family: "identity_to_application_data",
    shapes: ["subscription_saas", "custom_self_hosted_web", "desktop_shared_backend"],
    recipes: ["recipe_test_user"],
    managed: [
      { id: "clerk", name: "Clerk", version: "clerk-cli/3.1.0", adapter: "clerk-read/v1", shape: "application_instance", signals: ["configured", "linked"], sources: [sources.clerk] },
      { id: "supabase_auth", name: "Supabase Auth", version: "supabase-cli/2.114.0", adapter: null, shape: "managed_auth_schema", signals: ["configured", "policy_present"], sources: [sources.supabaseAuth] },
    ],
  },
  {
    file: "payment-to-entitlement.json",
    family: "payment_to_entitlement",
    shapes: ["subscription_saas", "desktop_shared_backend"],
    recipes: ["recipe_test_checkout"],
    managed: [
      { id: "stripe", name: "Stripe", version: "stripe-api/2026-07-29.dahlia", adapter: null, shape: "entitlement_feature_mapping", signals: ["configured", "linked"], sources: [sources.stripe] },
      { id: "paddle", name: "Paddle", version: "paddle-api/1", adapter: null, shape: "subscription_webhook_sequence", signals: ["configured", "routed"], sources: [sources.paddle] },
    ],
  },
  {
    file: "source-to-ci-cd-to-deployment.json",
    family: "source_to_ci_cd_to_deployment",
    shapes: allShapes,
    recipes: ["recipe_test_ci_dispatch"],
    managed: [
      { id: "github_actions_vercel", name: "GitHub Actions + Vercel", version: "github-rest/2026-03-10+vercel-cli/58.11.0", adapter: "vercel-read/v1", shape: "project_deployment", signals: ["configured", "linked"], sources: [sources.github, sources.vercel] },
      { id: "github_actions_cloudflare", name: "GitHub Actions + Cloudflare Workers", version: "github-rest/2026-03-10+wrangler/4.122.0", adapter: "cloudflare-read/v1", shape: "worker_version_deployment", signals: ["configured", "routed"], sources: [sources.github, sources.cloudflareWorkers] },
    ],
  },
  {
    file: "storage-to-metadata-access.json",
    family: "storage_to_metadata_access",
    shapes: ["subscription_saas", "media_productivity_async", "custom_self_hosted_web", "desktop_shared_backend"],
    recipes: ["recipe_test_object_upload"],
    managed: [
      { id: "cloudflare_r2", name: "Cloudflare R2", version: "s3-api/2006-03-01", adapter: null, shape: "bucket_policy", signals: ["configured", "policy_present"], sources: [sources.r2] },
      { id: "supabase_storage", name: "Supabase Storage", version: "supabase-cli/2.114.0", adapter: null, shape: "row_level_storage_policy", signals: ["configured", "policy_present", "linked"], sources: [sources.supabaseStorage] },
    ],
  },
  {
    file: "email-to-domain-delivery.json",
    family: "email_to_domain_delivery",
    shapes: ["content_marketing_web", "subscription_saas", "media_productivity_async"],
    recipes: ["recipe_test_email"],
    managed: [
      { id: "resend", name: "Resend", version: "resend-cli/2.12.0", adapter: "resend-read/v1", shape: "sending_domain", signals: ["configured", "verified"], sources: [sources.resend] },
      { id: "twilio_sendgrid", name: "Twilio SendGrid", version: "sendgrid-api/v3", adapter: null, shape: "authenticated_domain", signals: ["configured", "verified", "enabled"], sources: [sources.sendgrid] },
    ],
  },
  {
    file: "release-to-observability.json",
    family: "release_to_observability",
    shapes: allShapes,
    recipes: [],
    managed: [
      { id: "sentry", name: "Sentry", version: "sentry-cli/3.6.2", adapter: "sentry-read/v1", shape: "release_record", signals: ["configured", "observable"], sources: [sources.sentry] },
      { id: "honeycomb", name: "Honeycomb", version: "honeycomb-api/v1", adapter: null, shape: "deployment_marker", signals: ["linked", "observable"], sources: [sources.honeycomb] },
    ],
  },
  {
    file: "backup-to-restore.json",
    family: "backup_to_restore",
    shapes: ["subscription_saas", "custom_self_hosted_web", "desktop_shared_backend"],
    recipes: [],
    managed: [
      { id: "neon_restore", name: "Neon restore", version: "neon-api/v2", adapter: null, shape: "snapshot_branch", signals: ["configured", "recoverable"], sources: [sources.neon] },
      { id: "supabase_database_backup", name: "Supabase Database backups", version: "supabase-cli/2.114.0", adapter: null, shape: "managed_backup_window", signals: ["enabled", "recoverable"], sources: [sources.supabaseBackup] },
    ],
  },
  {
    file: "queue-background-work.json",
    family: "queue_background_work",
    shapes: ["subscription_saas", "media_productivity_async", "custom_self_hosted_web", "desktop_shared_backend"],
    recipes: [],
    managed: [
      { id: "cloudflare_queues", name: "Cloudflare Queues", version: "wrangler/4.122.0", adapter: null, shape: "batched_queue_consumer", signals: ["configured", "retry_configured"], sources: [sources.cloudflareQueues] },
      { id: "aws_sqs", name: "Amazon SQS", version: "sqs-api/2012-11-05", adapter: null, shape: "regional_dead_letter_queue", signals: ["configured", "dead_letter_configured"], sources: [sources.sqs] },
    ],
  },
];

const executorReferences = referenceExecutorDescriptors.map((descriptor) => ({
  id: descriptor.descriptor_id,
  schema_version: descriptor.schema_version,
  digest: descriptor.trust.digest,
}));

function officialSources(entries) {
  return entries.map(([title, url]) => ({ title, url, reviewed_at: reviewedAt }));
}

function implementation(source) {
  return {
    implementation_id: source.id,
    name: source.name,
    kind: "managed",
    interface_version: source.version,
    support_depth: source.adapter ? "read_only" : "generic_contract",
    read_adapter: source.adapter,
    executor_descriptors: structuredClone(executorReferences),
    normalization_shape: source.shape,
    normalization_fixture: {
      fixture_id: `normalize_${source.id}`,
      synthetic_input: { shape: source.shape, signals: [...source.signals] },
      required_signals: [...source.signals],
      expected_observation: {
        configuration_state: "configured",
        verification_state: "unverified",
      },
    },
    official_sources: officialSources(source.sources),
  };
}

const fallback = (family) => [
  ["retained", "Retain existing implementation", "retained", "existing-contract/v1", "generic_contract"],
  ["custom", "Custom implementation", "custom", "generic-contract/v1", "generic_contract"],
  ["self_hosted", "Self-hosted implementation", "self_hosted", "generic-contract/v1", "generic_contract"],
  ["unknown", "Unknown implementation", "unknown", "unknown/v1", "transparent_gap"],
].map(([suffix, name, kind, version, supportDepth]) => ({
  implementation_id: `${family}_${suffix}`,
  name,
  kind,
  interface_version: version,
  support_depth: supportDepth,
  read_adapter: null,
  executor_descriptors: [],
  normalization_shape: null,
  normalization_fixture: null,
  official_sources: officialSources([sources.launchrally]),
}));

const outputDirectory = path.resolve("packages/core/reference-integration-packs/v1");
await mkdir(outputDirectory, { recursive: true });
for (const spec of specifications) {
  const pack = {
    schema_version: "launchrally.dev/reference-integration-pack/v1",
    pack_id: `pack_${spec.family}`,
    pack_version: "1.0.0",
    family: spec.family,
    product_shapes: [...spec.shapes],
    capability_contract: {
      contract_version: "launchrally.dev/capability-catalog/v1",
      provider_fields: false,
    },
    integration_contract: {
      contract_version: "launchrally.dev/integration-contract/v1",
      provider_fields: false,
    },
    effects: {
      allowed: ["provider_configuration_read", "source_write"],
      prohibited: [
        "credential_persistence",
        "deployment_write",
        "production_data_write",
        "provider_configuration_write",
      ],
    },
    test_recipe_ids: [...spec.recipes],
    implementations: [
      ...spec.managed.map(implementation),
      ...fallback(spec.family),
    ],
    fixture_outcomes: outcomes.map((outcome) => ({
      fixture_id: `fixture_${spec.family}_${outcome}`,
      outcome,
    })),
    review: {
      reviewed_at: `${reviewedAt}T00:00:00.000Z`,
      expires_at: expiresAt,
      tamper_validation: true,
    },
  };
  pack.pack_digest = computeReferenceIntegrationPackDigest(pack);
  await writeFile(path.join(outputDirectory, spec.file), `${JSON.stringify(pack, null, 2)}\n`);
}
