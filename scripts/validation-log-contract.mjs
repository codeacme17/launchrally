import {
  assertAppendOnlyLog,
  walkValidationValue,
} from "./validation-log-shared.mjs";

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

const PERMITTED_SOURCES = new Set([
  "clean_environment_checks",
  "opt_in_maintainer_summary",
  "public_aggregate_package_trends",
  "voluntary_github_feedback",
]);

const AGGREGATE_TAXONOMY = Object.freeze({
  adoptionSignals: new Set(["validation_started"]),
  adoptionNotes: new Set(["clean_release_verified_field_evidence_pending"]),
  feedbackCategories: new Set([
    "documentation",
    "false_confidence",
    "installation",
    "journey_completion",
    "permission_comprehension",
    "plugin_integration",
  ]),
  frameworks: new Set(["astro", "custom_web", "fastapi", "react_go"]),
  deployments: new Set([
    "container",
    "edge_monorepo",
    "hosted_web",
    "self_hosted",
    "split_stack",
  ]),
  valuePatterns: new Set(["exact_public_install"]),
  valueSignals: new Set(["confirmed_in_clean_environment"]),
  valueNotes: new Set(["exact_cli_and_plugin_journeys_passed"]),
  defectPatterns: new Set([
    "evidence_integrity",
    "false_confidence",
    "permission_boundary",
    "recovery",
  ]),
  defectSignals: new Set(["repeated", "resolved", "unresolved"]),
  defectNotes: new Set([
    "repeated_defect_confirmed",
    "repeated_defect_fix_verified",
    "repeated_defect_under_review",
  ]),
  p1Needs: new Set([
    "authenticated_journey_verification",
    "hosted_history",
    "managed_collaboration",
    "permissioned_provider_mutation",
  ]),
  decisions: new Set([
    "start_telemetry_free_validation",
    "validate_p0_and_allow_p1_authority",
  ]),
  decisionOutcomes: new Set(["collecting", "validated"]),
  decisionRationales: new Set([
    "consistent_directional_evidence",
    "publication_is_not_field_validation",
  ]),
  regressionCategories: new Set([
    "evidence_integrity",
    "false_confidence",
    "permission_boundary",
    "recovery",
    "release_packaging",
  ]),
  regressionSummariesByCategory: new Map([
    ["evidence_integrity", new Map([
      ["open", new Set(["evidence_integrity_regression_under_review"])],
      ["verified_fixed", new Set(["evidence_integrity_fix_verified"])],
    ])],
    ["false_confidence", new Map([
      ["open", new Set(["false_confidence_regression_under_review"])],
      ["verified_fixed", new Set(["false_confidence_fix_verified"])],
    ])],
    ["permission_boundary", new Map([
      ["open", new Set(["permission_boundary_regression_under_review"])],
      ["verified_fixed", new Set(["permission_boundary_fix_verified"])],
    ])],
    ["recovery", new Map([
      ["open", new Set(["recovery_regression_under_review"])],
      ["verified_fixed", new Set(["recovery_fix_verified"])],
    ])],
    ["release_packaging", new Map([
      ["open", new Set(["release_packaging_regression_under_review"])],
      ["verified_fixed", new Set(["release_packaging_fix_verified"])],
    ])],
  ]),
  validationRationales: new Set([
    "clean_release_verification_is_not_field_validation",
    "consistent_directional_evidence",
    "directional_field_evidence_not_established",
    "quality_floor_regression_suspends_completion",
  ]),
  representedContextSummaries: new Set([
    "representative_clean_contexts_only",
    "represented_contexts_established",
  ]),
  repeatedPatternSummaries: new Set([
    "clean_release_value_pattern_only",
    "repeated_patterns_established",
  ]),
  recurringP1Summaries: new Set([
    "no_recurring_p1_need_established",
    "recurring_p1_needs_reviewed",
  ]),
  resultingDecisionSummaries: new Set([
    "continue_validation_and_block_p1_authority",
    "explicit_p0_validation_decision",
  ]),
});

const FORBIDDEN_ANALYTICS_KEYS = new Set([
  "email",
  "evidence_contents",
  "ip_address",
  "report_contents",
  "repository_name",
  "repository_url",
  "user_id",
  "username",
]);

function assertExactKeys(value, keys, owner) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())
  ) {
    fail("p0_validation_entry_incomplete", owner);
  }
}

function assertTaxonomyValue(value, permitted, owner) {
  if (typeof value !== "string" || !permitted.has(value)) {
    fail("p0_identifying_data_forbidden", `${owner} is outside the reviewed taxonomy`);
  }
}

function assertTaxonomyArray(values, permitted, owner) {
  if (!Array.isArray(values)) fail("p0_validation_entry_incomplete", owner);
  for (const value of values) assertTaxonomyValue(value, permitted, owner);
}

export function assertAppendOnlyValidationLog(current, baseline) {
  assertAppendOnlyLog(current, baseline, (detail) => {
    fail("p0_validation_history_changed", detail);
  });
}

export function assertNonIdentifyingValidationLog(value) {
  walkValidationValue(value, {
    key(key) {
      if (
        FORBIDDEN_ANALYTICS_KEYS.has(key)
        || (
          key !== "evidence_summary"
          && /(?:^|_)(?:email|evidence|ip|message|raw|report|repository|support_text|user|username)(?:_|$)/u.test(key)
        )
      ) {
        fail("p0_user_analytics_forbidden", `Validation Log contains prohibited field ${key}`);
      }
    },
    string(nested) {
      if (
        /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/u.test(nested)
        || /(?:https?:\/\/|ssh:\/\/|git@|\bgithub\.com\/)/iu.test(nested)
      ) {
        fail("p0_identifying_data_forbidden", "Validation Log contains an identifying value");
      }
    },
  });
}

export function assertNoHardValidationQuota(value) {
  walkValidationValue(value, {
    key(key) {
      if (/(?:quota|threshold|adoption_target|required_(?:count|installs)|minimum_downloads)/u.test(key)) {
        fail("p0_hard_quota_forbidden", `Validation Log contains quota field ${key}`);
      }
    },
    string(nested) {
      if (
        /\b(?:at\s+least|minimum(?:\s+of)?|after|once)\s+\d[\d,]*\s+(?:downloads?|installs?|users?|repositories?|days?|weeks?|months?)\b/iu.test(nested)
        || /\b(?:validated\s+when\s+)?(?:downloads?|installs?|users?|repositories?)\s+(?:reach|reaches|exceed|exceeds)\s+\d[\d,]*\b/iu.test(nested)
        || /\b\d[\d,]*\s+(?:downloads?|installs?|users?|repositories?)\s+(?:required|minimum|target|threshold)\b/iu.test(nested)
      ) {
        fail("p0_hard_quota_forbidden", "Validation Log contains a numeric validation threshold");
      }
    },
  });
}

export function assertPermittedValidationSources(log) {
  for (const entry of log.entries) {
    for (const source of entry.aggregate_adoption_trends?.sources ?? []) {
      if (!PERMITTED_SOURCES.has(source)) {
        fail("p0_validation_source_forbidden", source);
      }
    }
  }
}

export function assertCompleteValidationEntries(log) {
  for (const [index, entry] of log.entries.entries()) {
    const baseComplete = (
      typeof entry.period === "string"
      && entry.period.length > 0
      && typeof entry.aggregate_adoption_trends === "object"
      && Array.isArray(entry.aggregate_adoption_trends?.sources)
      && Array.isArray(entry.voluntary_feedback_categories)
      && Array.isArray(entry.represented_contexts?.frameworks)
      && Array.isArray(entry.represented_contexts?.deployments)
      && Array.isArray(entry.recurring_p1_requests)
      && Array.isArray(entry.product_decisions)
    );
    const directionalComplete = index === 0 || (
      Array.isArray(entry.repeated_value_patterns)
      && Array.isArray(entry.repeated_defect_patterns)
      && ["satisfied", "suspended"].includes(entry.quality_floor?.status)
      && Array.isArray(entry.quality_floor?.regressions)
      && ["not_validated", "validated"].includes(entry.validation_decision?.status)
      && typeof entry.validation_decision?.rationale === "string"
      && entry.validation_decision?.evidence_summary
      && entry.p1_gate?.discovery === "allowed"
      && ["allowed", "blocked"].includes(
        entry.p1_gate?.authority_expanding_implementation,
      )
    );
    if (!baseComplete || !directionalComplete) {
      fail("p0_validation_entry_incomplete", `entry ${index}`);
    }
  }
}

export function assertReviewedAggregateTaxonomy(log) {
  for (const [index, entry] of log.entries.entries()) {
    if (index === 0) continue;
    const owner = `entry ${index}`;
    assertExactKeys(entry, [
      "aggregate_adoption_trends",
      "p1_gate",
      "period",
      "product_decisions",
      "quality_floor",
      "recurring_p1_requests",
      "repeated_defect_patterns",
      "repeated_value_patterns",
      "represented_contexts",
      "validation_decision",
      "voluntary_feedback_categories",
    ], owner);
    if (!/^\d{4}-\d{2}-\d{2}-\d{2}$/u.test(entry.period)) {
      fail("p0_validation_entry_incomplete", `${owner}.period`);
    }
    assertExactKeys(
      entry.aggregate_adoption_trends,
      ["notes", "signal", "sources"],
      `${owner}.aggregate_adoption_trends`,
    );
    assertTaxonomyValue(
      entry.aggregate_adoption_trends.signal,
      AGGREGATE_TAXONOMY.adoptionSignals,
      `${owner}.aggregate_adoption_trends.signal`,
    );
    assertTaxonomyValue(
      entry.aggregate_adoption_trends.notes,
      AGGREGATE_TAXONOMY.adoptionNotes,
      `${owner}.aggregate_adoption_trends.notes`,
    );
    assertTaxonomyArray(
      entry.voluntary_feedback_categories,
      AGGREGATE_TAXONOMY.feedbackCategories,
      `${owner}.voluntary_feedback_categories`,
    );
    assertExactKeys(
      entry.represented_contexts,
      ["deployments", "frameworks"],
      `${owner}.represented_contexts`,
    );
    assertTaxonomyArray(
      entry.represented_contexts.frameworks,
      AGGREGATE_TAXONOMY.frameworks,
      `${owner}.represented_contexts.frameworks`,
    );
    assertTaxonomyArray(
      entry.represented_contexts.deployments,
      AGGREGATE_TAXONOMY.deployments,
      `${owner}.represented_contexts.deployments`,
    );
    for (const [patternIndex, pattern] of entry.repeated_value_patterns.entries()) {
      const patternOwner = `${owner}.repeated_value_patterns.${patternIndex}`;
      assertExactKeys(pattern, ["notes", "pattern", "signal"], patternOwner);
      assertTaxonomyValue(pattern.pattern, AGGREGATE_TAXONOMY.valuePatterns, patternOwner);
      assertTaxonomyValue(pattern.signal, AGGREGATE_TAXONOMY.valueSignals, patternOwner);
      assertTaxonomyValue(pattern.notes, AGGREGATE_TAXONOMY.valueNotes, patternOwner);
    }
    for (const [patternIndex, pattern] of entry.repeated_defect_patterns.entries()) {
      const patternOwner = `${owner}.repeated_defect_patterns.${patternIndex}`;
      assertExactKeys(pattern, ["notes", "pattern", "signal"], patternOwner);
      assertTaxonomyValue(pattern.pattern, AGGREGATE_TAXONOMY.defectPatterns, patternOwner);
      assertTaxonomyValue(pattern.signal, AGGREGATE_TAXONOMY.defectSignals, patternOwner);
      assertTaxonomyValue(pattern.notes, AGGREGATE_TAXONOMY.defectNotes, patternOwner);
    }
    assertTaxonomyArray(
      entry.recurring_p1_requests,
      AGGREGATE_TAXONOMY.p1Needs,
      `${owner}.recurring_p1_requests`,
    );
    for (const [decisionIndex, decision] of entry.product_decisions.entries()) {
      const decisionOwner = `${owner}.product_decisions.${decisionIndex}`;
      assertExactKeys(decision, ["decision", "outcome", "rationale"], decisionOwner);
      assertTaxonomyValue(decision.decision, AGGREGATE_TAXONOMY.decisions, decisionOwner);
      assertTaxonomyValue(decision.outcome, AGGREGATE_TAXONOMY.decisionOutcomes, decisionOwner);
      assertTaxonomyValue(decision.rationale, AGGREGATE_TAXONOMY.decisionRationales, decisionOwner);
    }
    assertExactKeys(entry.quality_floor, ["regressions", "status"], `${owner}.quality_floor`);
    for (const [regressionIndex, regression] of entry.quality_floor.regressions.entries()) {
      const regressionOwner = `${owner}.quality_floor.regressions.${regressionIndex}`;
      assertExactKeys(regression, ["category", "id", "status", "summary"], regressionOwner);
      if (!/^qf-\d{4}-\d{2}-\d{2}-\d{2}$/u.test(regression.id)) {
        fail("p0_validation_entry_incomplete", `${regressionOwner}.id`);
      }
      assertTaxonomyValue(
        regression.category,
        AGGREGATE_TAXONOMY.regressionCategories,
        `${regressionOwner}.category`,
      );
      assertTaxonomyValue(
        regression.summary,
        AGGREGATE_TAXONOMY.regressionSummariesByCategory.get(regression.category)
          ?.get(regression.status) ?? new Set(),
        `${regressionOwner}.summary`,
      );
    }
    assertExactKeys(
      entry.validation_decision,
      ["evidence_summary", "rationale", "status"],
      `${owner}.validation_decision`,
    );
    assertTaxonomyValue(
      entry.validation_decision.rationale,
      AGGREGATE_TAXONOMY.validationRationales,
      `${owner}.validation_decision.rationale`,
    );
    assertExactKeys(entry.validation_decision.evidence_summary, [
      "recurring_p1_needs",
      "repeated_patterns",
      "represented_contexts",
      "resulting_decisions",
    ], `${owner}.validation_decision.evidence_summary`);
    const summary = entry.validation_decision.evidence_summary;
    assertTaxonomyValue(
      summary.represented_contexts,
      AGGREGATE_TAXONOMY.representedContextSummaries,
      `${owner}.validation_decision.evidence_summary.represented_contexts`,
    );
    assertTaxonomyValue(
      summary.repeated_patterns,
      AGGREGATE_TAXONOMY.repeatedPatternSummaries,
      `${owner}.validation_decision.evidence_summary.repeated_patterns`,
    );
    assertTaxonomyValue(
      summary.recurring_p1_needs,
      AGGREGATE_TAXONOMY.recurringP1Summaries,
      `${owner}.validation_decision.evidence_summary.recurring_p1_needs`,
    );
    assertTaxonomyValue(
      summary.resulting_decisions,
      AGGREGATE_TAXONOMY.resultingDecisionSummaries,
      `${owner}.validation_decision.evidence_summary.resulting_decisions`,
    );
    assertExactKeys(
      entry.p1_gate,
      ["authority_expanding_implementation", "discovery"],
      `${owner}.p1_gate`,
    );
  }
}

export function assertValidationAuthorityState(log) {
  const unresolvedRegressions = new Map();
  const knownRegressions = new Map();
  for (const [index, entry] of log.entries.entries()) {
    if (!entry.quality_floor) continue;
    const regressions = entry.quality_floor.regressions;
    if (!Array.isArray(regressions)) {
      fail("p0_validation_entry_incomplete", `entry ${index}`);
    }
    if (entry.quality_floor.status === "suspended" && regressions.length === 0) {
      fail("p0_quality_floor_suspended", "a suspended Quality Floor requires a regression");
    }
    if (entry.quality_floor.status === "satisfied") {
      for (const [id, category] of unresolvedRegressions) {
        if (!regressions.some((regression) => (
          regression?.id === id
          && regression?.category === category
          && regression?.status === "verified_fixed"
        ))) {
          fail(
            "p0_quality_floor_fix_missing",
            `Quality Floor regression ${id} lacks a verified fix`,
          );
        }
      }
    }
    for (const regression of regressions) {
      if (
        typeof regression?.id !== "string"
        || typeof regression?.category !== "string"
        || !["open", "verified_fixed"].includes(regression?.status)
        || typeof regression?.summary !== "string"
        || regression.summary.trim().length === 0
      ) {
        fail("p0_validation_entry_incomplete", `entry ${index}`);
      }
      if (regression.status === "open") {
        if (knownRegressions.has(regression.id)) {
          fail("p0_validation_entry_incomplete", `reused regression ${regression.id}`);
        }
        knownRegressions.set(regression.id, regression.category);
        unresolvedRegressions.set(regression.id, regression.category);
      }
      if (regression.status === "verified_fixed") {
        if (
          knownRegressions.get(regression.id) !== regression.category
          || unresolvedRegressions.get(regression.id) !== regression.category
        ) {
          fail("p0_quality_floor_fix_missing", `unknown regression ${regression.id}`);
        }
        unresolvedRegressions.delete(regression.id);
      }
    }
    if (entry.quality_floor.status === "satisfied" && unresolvedRegressions.size > 0) {
      fail("p0_quality_floor_fix_missing", "a satisfied Quality Floor has an open regression");
    }
  }
  const latest = log.entries.at(-1);
  if (
    latest?.quality_floor?.status === "suspended"
    && (
      latest.validation_decision?.status !== "not_validated"
      || latest.p1_gate?.authority_expanding_implementation !== "blocked"
    )
  ) {
    fail(
      "p0_quality_floor_suspended",
      "Quality Floor regressions suspend validation claims and P1 authority",
    );
  }
  if (
    latest?.p1_gate?.authority_expanding_implementation === "allowed"
    && latest.validation_decision?.status !== "validated"
  ) {
    fail(
      "p0_p1_authority_blocked",
      "authority-expanding P1 implementation requires P0 Validated",
    );
  }
  if (latest?.validation_decision?.status === "validated") {
    const summary = latest.validation_decision.evidence_summary;
    const summaryKeys = [
      "recurring_p1_needs",
      "repeated_patterns",
      "represented_contexts",
      "resulting_decisions",
    ];
    const validSummary = summaryKeys.every((key) => (
      typeof summary?.[key] === "string" && summary[key].trim().length > 0
    )) && JSON.stringify(Object.keys(summary ?? {}).sort()) === JSON.stringify(summaryKeys);
    if (
      latest.quality_floor?.status !== "satisfied"
      || typeof latest.validation_decision.rationale !== "string"
      || latest.validation_decision.rationale.trim().length === 0
      || !validSummary
    ) {
      fail(
        "p0_validation_decision_incomplete",
        "P0 Validated requires a qualitative basis and a satisfied Quality Floor",
      );
    }
  }
  return {
    product_status: latest.quality_floor?.status === "suspended"
      ? "suspended"
      : "complete",
    validation_status: latest.quality_floor?.status === "suspended"
      ? "suspended"
      : latest.validation_decision?.status === "validated"
        ? "validated"
        : "collecting",
    p0_validated: latest.validation_decision?.status === "validated",
    quality_floor_status: latest.quality_floor?.status,
    p1_discovery: latest.p1_gate?.discovery,
    p1_authority: latest.p1_gate?.authority_expanding_implementation,
  };
}
