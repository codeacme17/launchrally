import { readFile } from "node:fs/promises";
import path from "node:path";

export const STABLE_PACKAGE_NAMES = [
  "@launchrally/contracts",
  "@launchrally/core",
  "@launchrally/cli",
  "@launchrally/codex-plugin",
  "@launchrally/claude-plugin",
];

export const STABLE_E2E_JOURNEYS = [
  "approved_permission",
  "claude_plugin",
  "codex_plugin",
  "denied_permission",
  "direct_cli",
];

export function isStableVersionTag(tag, version) {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version ?? "")
    && tag === `v${version}`;
}

export function hasExactStablePackages(release) {
  const actual = (release?.packages ?? []).map(({ name }) => name).sort();
  return JSON.stringify(actual) === JSON.stringify([...STABLE_PACKAGE_NAMES].sort());
}

export async function invalidStablePromotionEvidence({ promotion, root }) {
  const invalid = [];
  for (const journey of STABLE_E2E_JOURNEYS) {
    const evidencePath = promotion?.maintainer_e2e_evidence?.[journey];
    if (
      typeof evidencePath !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(evidencePath)
      || path.posix.normalize(evidencePath) !== evidencePath
      || evidencePath.split("/").includes("..")
    ) {
      invalid.push(journey);
      continue;
    }
    try {
      await readFile(path.join(root, evidencePath), "utf8");
    } catch {
      invalid.push(journey);
    }
  }
  return invalid;
}

export function stablePromotionBlockers({
  acceptance,
  contract,
  release,
  tag,
  version,
}) {
  const promotion = contract?.stable_promotion;
  const blockers = [];
  if (contract?.product_status !== "complete") blockers.push("product_status");
  if (contract?.release_status !== "stable") blockers.push("release_status");
  if (contract?.validation_status !== "validated") blockers.push("validation_status");
  if (contract?.p0_validated !== true) blockers.push("p0_validated");
  if (contract?.quality_floor_status !== "satisfied") blockers.push("quality_floor_status");
  if (promotion?.status !== "approved") blockers.push("stable_promotion.status");
  if (promotion?.maintainer_e2e_status !== "complete") {
    blockers.push("stable_promotion.maintainer_e2e_status");
  }
  const evidenceJourneys = Object.keys(promotion?.maintainer_e2e_evidence ?? {}).sort();
  const hasEvidence = JSON.stringify(evidenceJourneys) === JSON.stringify(STABLE_E2E_JOURNEYS)
    && evidenceJourneys.every((journey) => (
      typeof promotion.maintainer_e2e_evidence[journey] === "string"
      && promotion.maintainer_e2e_evidence[journey].length > 0
    ));
  if (!hasEvidence) blockers.push("stable_promotion.maintainer_e2e_evidence");
  if (!isStableVersionTag(tag, version) || promotion?.approved_tag !== tag) {
    blockers.push("stable_promotion.approved_tag");
  }
  if (release && !hasExactStablePackages(release)) blockers.push("release.packages");
  if (acceptance) {
    if (
      acceptance.product_status !== contract?.product_status
      || acceptance.release_status !== contract?.release_status
    ) {
      blockers.push("acceptance.status");
    }
    if (
      !Array.isArray(acceptance.requirements)
      || acceptance.requirements.some(({ status }) => status !== "complete")
    ) {
      blockers.push("acceptance.requirements");
    }
  }
  return blockers;
}
