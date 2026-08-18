import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";

import { renderHumanVerify } from "../packages/cli/bin/human-verify.js";

const INVOCATION_CONTEXT = Object.freeze({
  schema_version: "launchrally.dev/invocation-context/v1",
  source: "user_path",
  launcher_version: "0.4.0",
});

function completedVerification() {
  return {
    status: "completed",
    operation: "verify",
    verification_scope: {
      mode: "full",
      whole_release: true,
      check_ids: ["web.baseline.build-command", "web.public.availability"],
    },
    assessment_scope: "whole_release",
    assessment: "no_go",
    manifest_drift: [],
    history: {
      source_report_id: "report_supplied_current",
      current_report_id: "report_current",
    },
    interaction: {
      source_report: {
        report_id: "report_source",
        role: "manifest_source",
      },
    },
    report: {
      results: {
        checks: [{
          check_id: "web.baseline.build-command",
          status: "failed",
          priority: "p0",
          summary: "The production build command is missing.",
        }],
        verification_gaps: [{
          check_id: "web.public.availability",
          status: "unverified",
          priority: "p0",
          reason: "Fresh public verification permission was denied.",
        }],
      },
    },
  };
}

test("Human full Verify exposes the validated current Report handoff to Plan", () => {
  const result = completedVerification();
  const options = {
    cwd: "/workspace/product",
    invocationContext: INVOCATION_CONTEXT,
    styled: false,
  };
  const plain = renderHumanVerify(result, options);
  const styled = renderHumanVerify(result, { ...options, styled: true });

  assert.match(plain, /^LaunchRally Full Verification$/mu);
  assert.match(plain, /^Manifest Source Report\nreport_source$/mu);
  assert.match(plain, /^Current Report\nreport_current$/mu);
  assert.match(
    plain,
    /^Current Report input\n\.launchrally\/reports\/report_current\/record\.json$/mu,
  );
  assert.match(plain, /^Failed Checks \(1\)$/mu);
  assert.match(plain, /\[P0\] web\.baseline\.build-command/u);
  assert.match(plain, /^Verification Gaps \(1\)$/mu);
  assert.match(plain, /Fresh public verification permission was denied\./u);
  assert.match(
    plain,
    /^Next command\nrally plan --cwd '\/workspace\/product' --report '\.launchrally\/reports\/report_current\/record\.json'$/mu,
  );
  assert.match(styled, /\u001B\[/u);
  assert.equal(stripVTControlCharacters(styled), plain);
});
