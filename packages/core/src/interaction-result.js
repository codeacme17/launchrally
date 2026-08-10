import { CLI_INTERACTION_CONTRACT } from "@launchrally/contracts";

export function manifestSourceReportIdentity(reportId) {
  return {
    report_id: reportId,
    role: "manifest_source",
  };
}

export function currentReportIdentity(reportId) {
  return {
    report_id: reportId,
    role: "current",
  };
}

export function createNeedsRefreshResult(operation, sourceReportId, message) {
  return {
    contract: CLI_INTERACTION_CONTRACT,
    status: "needs_refresh",
    operation,
    reason: "current_report_required",
    source_report_id: sourceReportId,
    request: {
      type: "refresh",
      operation: "verify",
      scope: "full",
    },
    message,
  };
}
