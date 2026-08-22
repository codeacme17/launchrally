import { terminalSafeText } from "./human-architect.js";

function packageId(bundle) {
  return terminalSafeText(bundle?.package?.package_id ?? "unavailable");
}

export function renderHumanArchitecturePackagePreview(result, bundle) {
  const preview = result.preview ?? result;
  const currentPointer = preview.files.find((file) => file.endsWith("/current.json"));
  const immutablePaths = preview.files.filter((file) => file !== currentPointer);
  return [
    "Immutable History Persistence Preview",
    `Package ID: ${packageId(bundle)}`,
    `Package revision: ${terminalSafeText(bundle.package.revision)}`,
    `Environment: ${terminalSafeText(bundle.package.environment)}`,
    `Mode: ${terminalSafeText(preview.mode)}`,
    `Bundle digest: ${terminalSafeText(preview.bundle_digest)}`,
    `Current pointer digest: ${terminalSafeText(preview.current_pointer_digest)}`,
    "Created immutable paths:",
    ...(immutablePaths.length > 0
      ? immutablePaths.map((file) => `  - ${terminalSafeText(file)}`)
      : ["  - None"]),
    `Current pointer path: ${terminalSafeText(currentPointer)}`,
    "Persistence is limited to these exact local-history paths. Application source, Provider state, staging, and commits are unchanged.",
    "Confirmation remains bound to this exact package, pointer, and file list; stale input fails closed.",
  ].join("\n");
}

export function renderHumanArchitecturePackageOutcome(result, bundle) {
  if (result.status === "completed") {
    if (result.mode === "output_only") {
      return [
        "Architecture Package Not Persisted",
        `Package ID: ${packageId(bundle)}`,
        "This project is not initialized. Supply --output <path> to write the reviewed package outside local history.",
      ].join("\n");
    }
    return [
      "Architecture Package Persistence Complete",
      `Package ID: ${packageId(bundle)}`,
      `Mode: ${terminalSafeText(result.mode)}`,
      `Persisted: ${result.persisted ? "yes" : "no"}`,
      ...(result.package_path
        ? [`Immutable package path: ${terminalSafeText(result.package_path)}`]
        : []),
      ...(result.files?.find((file) => file.endsWith("/current.json"))
        ? [`Current pointer: ${terminalSafeText(result.files.find((file) => file.endsWith("/current.json")))}`]
        : []),
      "No application source, Provider, production, staging, or version-control writes were authorized.",
    ].join("\n");
  }
  if (result.status === "denied") {
    return [
      "Architecture Package Persistence Declined",
      `Package ID: ${packageId(bundle)}`,
      "No Architecture Package history was written.",
    ].join("\n");
  }
  if (result.status === "cancelled") {
    return [
      "Architecture Package Persistence Cancelled",
      `Package ID: ${packageId(bundle)}`,
      "No Architecture Package history was written.",
    ].join("\n");
  }
  if (result.status === "stale_input") {
    return [
      "Architecture Package Preview Is Stale",
      `Package ID: ${packageId(bundle)}`,
      "The package, current pointer, or exact file list changed after preview. Review a new preview before confirming.",
    ].join("\n");
  }
  return [
    "Architecture Package Persistence Could Not Complete",
    `Package ID: ${packageId(bundle)}`,
    `Error: ${terminalSafeText(result.error)}`,
    ...(result.message ? [`Message: ${terminalSafeText(result.message)}`] : []),
  ].join("\n");
}

export async function runHumanArchitecturePackage({
  cwd,
  architecturePackage,
  launcherVersion,
  outputPath,
  persist,
  prompt,
}) {
  await prompt.start?.("architecture-package");
  let result = await persist(cwd, architecturePackage, {
    output_path: outputPath,
    launcher_version: launcherVersion,
  });
  if (result.status === "needs_confirmation") {
    const decision = await prompt.confirmArchitecturePackage(result, architecturePackage);
    if (decision !== "confirm") {
      result = {
        ...result,
        status: decision === "cancel" ? "cancelled" : "denied",
        persisted: false,
        resume_token: null,
        outcome: decision === "cancel"
          ? "architecture_package_persistence_cancelled"
          : "architecture_package_persistence_declined",
      };
    } else {
      result = await persist(cwd, architecturePackage, {
        confirmation: "confirm",
        launcher_version: launcherVersion,
        resume_token: result.resume_token,
      });
    }
  }
  await prompt.finishArchitecturePackage(result, architecturePackage);
  return result;
}
