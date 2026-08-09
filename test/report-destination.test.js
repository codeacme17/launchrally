import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inspectReportDestination,
  isLaunchRallyDestination,
} from "../packages/cli/bin/report-destination.js";

test("Report destinations distinguish new files, collisions, and unusable paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-destination-"));
  const newFile = path.join(directory, "new.json");
  const existingFile = path.join(directory, "existing.json");
  const directoryTarget = path.join(directory, "folder");
  const symlinkTarget = path.join(directory, "link.json");
  await writeFile(existingFile, "existing");
  await mkdir(directoryTarget);
  await symlink(existingFile, symlinkTarget);

  assert.deepEqual(await inspectReportDestination(newFile), {
    valid: true,
    collision: false,
  });
  assert.deepEqual(await inspectReportDestination(existingFile), {
    valid: true,
    collision: true,
  });
  assert.deepEqual(await inspectReportDestination(path.join(directory, "missing", "file.json")), {
    valid: false,
    reason: "parent_unavailable",
  });
  assert.deepEqual(await inspectReportDestination(directoryTarget), {
    valid: false,
    reason: "destination_not_file",
  });
  assert.deepEqual(await inspectReportDestination(symlinkTarget), {
    valid: false,
    reason: "destination_not_file",
  });
  assert.deepEqual(await inspectReportDestination(`${newFile}\0invalid`), {
    valid: false,
    reason: "invalid_path",
  });
});

test("Report destination checks reject an already-aborted operation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchrally-destination-abort-"));
  const destination = path.join(directory, "report.json");
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    inspectReportDestination(destination, { signal: controller.signal }),
    (error) => error?.name === "AbortError",
  );
  await assert.rejects(
    isLaunchRallyDestination(directory, destination, { signal: controller.signal }),
    (error) => error?.name === "AbortError",
  );
});

test("Audit reserves every .launchrally destination for separately confirmed Init", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "launchrally-reserved-"));
  const reservedReports = path.join(cwd, ".launchrally", "reports");
  const alias = path.join(cwd, "reports");
  const externalReports = path.join(cwd, "external-reports");
  const outboundAlias = path.join(cwd, ".launchrally", "outbound");
  await mkdir(reservedReports, { recursive: true });
  await mkdir(externalReports);
  await symlink(reservedReports, alias);
  await symlink(externalReports, outboundAlias);

  assert.equal(await isLaunchRallyDestination(cwd, path.join(cwd, ".launchrally")), true);
  assert.equal(
    await isLaunchRallyDestination(
      cwd,
      path.join(cwd, ".launchrally", "reports", "audit.json"),
    ),
    true,
  );
  assert.equal(await isLaunchRallyDestination(cwd, path.join(alias, "audit.json")), true);
  assert.equal(
    await isLaunchRallyDestination(cwd, path.join(outboundAlias, "audit.json")),
    true,
  );
  assert.equal(
    await isLaunchRallyDestination(
      cwd,
      path.join(cwd, ".LAUNCHRALLY", "report.json"),
      { platform: "darwin" },
    ),
    true,
  );
  assert.equal(await isLaunchRallyDestination(cwd, path.join(cwd, "report.json")), false);
  assert.equal(
    await isLaunchRallyDestination(cwd, path.resolve(cwd, "..", "report.json")),
    false,
  );
});
