import { sha256 } from "./local-history.js";

export function createRecordReference(id, schemaVersion, value) {
  return { id, schema_version: schemaVersion, digest: sha256(value) };
}

export function createReportReference(report) {
  const digest = sha256(report);
  return {
    id: `report_${digest.slice(7, 27)}`,
    schema_version: report.schema_version,
    digest,
  };
}
