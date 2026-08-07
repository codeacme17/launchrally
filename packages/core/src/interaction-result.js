import { CLI_INTERACTION_CONTRACT } from "@launchrally/contracts";

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
