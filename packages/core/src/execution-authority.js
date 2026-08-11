import process from "node:process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  EXECUTION_AUTHORITY_CONTRACT,
  assertValidExecutionAuthorityDescriptor,
  assertValidExecutionAuthority,
  assertValidManifest,
  assertSupportedManifestVersion,
} from "@launchrally/contracts";

import { isExactToolchain } from "./initialization.js";
import { parseManifest } from "./manifest.js";

const ENGINE_PACKAGE = "@launchrally/cli";
const EXACT_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const MANIFEST_PATH = ".launchrally/manifest.yaml";
const TOOLCHAIN_PACKAGE_PATH = ".launchrally/toolchain/package.json";
const TOOLCHAIN_LOCK_PATH = ".launchrally/toolchain/package-lock.json";
const LEGACY_ADAPTERS = new Map([
  ["0.2.2", {
    contract: EXECUTION_AUTHORITY_CONTRACT,
    entrypoint: "bin/rally.js",
  }],
]);
export const EXECUTION_AUTHORITY_DESCRIPTOR_PATH =
  ".launchrally/toolchain/authority.json";

async function optionalStat(candidate) {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function repositoryBoundary(start) {
  let current = start;
  while (true) {
    if (await optionalStat(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

async function discoverLaunchRallyProject(selected) {
  const boundary = await repositoryBoundary(selected);
  let current = selected;
  while (true) {
    const launchRallyPath = path.join(current, ".launchrally");
    const stat = await optionalStat(launchRallyPath);
    if (stat) return { root: current, launchRallyPath, stat };
    if (current === boundary) return null;
    current = path.dirname(current);
  }
}

function invalidAuthority(launcherVersion, reason, engine = {}) {
  return {
    schema_version: EXECUTION_AUTHORITY_CONTRACT,
    state: "invalid_toolchain",
    source: "project_toolchain",
    launcher_version: launcherVersion,
    engine: {
      package: ENGINE_PACKAGE,
      version: engine.version ?? null,
      contract: engine.contract ?? null,
      compatibility: "incompatible",
    },
    materialization: { state: "invalid" },
    reason,
    next_action: { operation: "inspect_toolchain" },
  };
}

function projectAuthority({
  launcherVersion,
  state,
  version,
  compatibility,
  materialization,
  reason,
  nextAction,
  contract = EXECUTION_AUTHORITY_CONTRACT,
}) {
  return {
    schema_version: EXECUTION_AUTHORITY_CONTRACT,
    state,
    source: "project_toolchain",
    launcher_version: launcherVersion,
    engine: {
      package: ENGINE_PACKAGE,
      version,
      contract,
      compatibility,
    },
    materialization: { state: materialization },
    reason,
    next_action: { operation: nextAction },
  };
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function assertContainedDirectories(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      const error = new Error("Execution Authority refuses a non-directory project path.");
      error.code = "unsafe_project_path";
      throw error;
    }
    if (!isInside(root, await realpath(current))) {
      const error = new Error("Execution Authority refuses a directory outside the repository.");
      error.code = "unsafe_project_path";
      throw error;
    }
  }
}

function attachSelection(authority, selection) {
  Object.defineProperty(authority, "selection", {
    enumerable: false,
    value: Object.freeze(selection),
  });
  return authority;
}

async function readContainedFile(root, relativePath) {
  const candidate = path.join(root, relativePath);
  const stat = await lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    const error = new Error("Execution Authority refuses a non-regular project file.");
    error.code = "unsafe_project_path";
    throw error;
  }
  const canonical = await realpath(candidate);
  if (!isInside(root, canonical)) {
    const error = new Error("Execution Authority refuses a path outside the repository.");
    error.code = "unsafe_project_path";
    throw error;
  }
  let handle;
  try {
    handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      const error = new Error("Execution Authority detected a changed project file.");
      error.code = "unsafe_project_path";
      throw error;
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle?.close();
  }
}

async function readOptionalContainedFile(root, relativePath) {
  try {
    return await readContainedFile(root, relativePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function recognizableDescriptor(descriptor) {
  return descriptor
    && typeof descriptor === "object"
    && !Array.isArray(descriptor)
    && JSON.stringify(Object.keys(descriptor).sort()) === JSON.stringify(["contract", "engine"])
    && /^launchrally\.dev\/execution-authority\/v[0-9]+$/u.test(descriptor.contract)
    && descriptor.engine
    && typeof descriptor.engine === "object"
    && !Array.isArray(descriptor.engine)
    && JSON.stringify(Object.keys(descriptor.engine).sort())
      === JSON.stringify(["entrypoint", "package", "version"])
    && descriptor.engine.package === ENGINE_PACKAGE
    && EXACT_VERSION.test(descriptor.engine.version)
    && ["bin/engine.js", "bin/rally.js"].includes(descriptor.engine.entrypoint);
}

function descriptorCompatibility(descriptor) {
  if (descriptor.engine.entrypoint === "bin/engine.js") return "native";
  const adapter = LEGACY_ADAPTERS.get(descriptor.engine.version);
  return adapter?.contract === descriptor.contract
    && adapter.entrypoint === descriptor.engine.entrypoint
    ? "legacy_adapter"
    : null;
}

function sameObject(left, right) {
  return isDeepStrictEqual(left ?? {}, right ?? {});
}

async function inspectMaterialization(
  root,
  lock,
  descriptor,
  compatibility,
  toolchainRelative = ".launchrally/toolchain",
) {
  let incomplete = false;
  for (const [lockedPath, lockedPackage] of Object.entries(lock.packages)) {
    if (!lockedPath.startsWith("node_modules/")) continue;
    const name = lockedPath.slice("node_modules/".length);
    const packageDirectory = `${toolchainRelative}/${lockedPath}`;
    if (!await optionalStat(path.join(root, packageDirectory))) {
      incomplete = true;
      continue;
    }
    await assertContainedDirectories(root, packageDirectory);
    const packageContent = await readOptionalContainedFile(
      root,
      `${packageDirectory}/package.json`,
    );
    if (packageContent === null) {
      incomplete = true;
      continue;
    }
    let installedPackage;
    try {
      installedPackage = JSON.parse(packageContent);
    } catch {
      return { state: "invalid" };
    }
    if (
      installedPackage?.name !== name
      || installedPackage?.version !== lockedPackage.version
      || !sameObject(installedPackage.dependencies, lockedPackage.dependencies)
    ) return { state: "invalid" };
    if (name === ENGINE_PACKAGE) {
      const expectedEntrypoints = [
        descriptor.engine.entrypoint,
        `./${descriptor.engine.entrypoint}`,
      ];
      if (
        compatibility === "native"
        && (
          installedPackage?.launchrally?.execution_authority !== descriptor.contract
          || !expectedEntrypoints.includes(installedPackage?.launchrally?.engine)
        )
      ) return { state: "invalid" };
      if (
        compatibility === "legacy_adapter"
        && (
          !expectedEntrypoints.includes(installedPackage?.bin?.rally)
          || installedPackage?.launchrally?.engine !== undefined
        )
      ) return { state: "invalid" };
    }
  }
  if (incomplete) return { state: "incomplete" };

  const entrypointRelative =
    `${toolchainRelative}/node_modules/@launchrally/cli/${descriptor.engine.entrypoint}`;
  const entrypoint = await readOptionalContainedFile(root, entrypointRelative);
  if (entrypoint === null) return { state: "incomplete" };
  return {
    state: "ready",
    engineEntrypoint: await realpath(path.join(root, entrypointRelative)),
  };
}

export async function validateToolchainDirectory(toolchainPath) {
  const selected = path.resolve(toolchainPath);
  const root = await realpath(path.dirname(selected));
  const canonicalSelected = await realpath(selected);
  if (!isInside(root, canonicalSelected)) {
    return { valid: false, reason: "unsafe_project_path" };
  }
  const relative = path.relative(root, canonicalSelected).split(path.sep).join("/");
  await assertContainedDirectories(root, relative);
  const packageJson = await readContainedFile(root, `${relative}/package.json`);
  const lockfile = await readContainedFile(root, `${relative}/package-lock.json`);
  const parsedPackage = JSON.parse(packageJson);
  const descriptorContent = await readOptionalContainedFile(root, `${relative}/authority.json`);
  let descriptor;
  let compatibility;
  if (descriptorContent === null) {
    const version = parsedPackage?.devDependencies?.[ENGINE_PACKAGE];
    const adapter = LEGACY_ADAPTERS.get(version);
    if (!adapter) return { valid: false, reason: "unknown_legacy_toolchain" };
    descriptor = {
      contract: adapter.contract,
      engine: { package: ENGINE_PACKAGE, version, entrypoint: adapter.entrypoint },
    };
    compatibility = "legacy_adapter";
  } else {
    descriptor = JSON.parse(descriptorContent);
    assertValidExecutionAuthorityDescriptor(descriptor);
    compatibility = descriptorCompatibility(descriptor);
    if (compatibility === null) {
      return { valid: false, reason: "unsupported_legacy_descriptor" };
    }
  }
  if (!isExactToolchain({
    packageJson,
    lockfile,
    dependency: ENGINE_PACKAGE,
    version: descriptor.engine.version,
  })) return { valid: false, reason: "invalid_toolchain_lock" };
  const materialization = await inspectMaterialization(
    root,
    JSON.parse(lockfile),
    descriptor,
    compatibility,
    relative,
  );
  return materialization.state === "ready"
    ? { valid: true, version: descriptor.engine.version, compatibility }
    : { valid: false, reason: `materialization_${materialization.state}` };
}

async function inspectProject(project, launcherVersion, operationCwd) {
  if (!project.stat.isDirectory() || project.stat.isSymbolicLink()) {
    return invalidAuthority(launcherVersion, "unsafe_project_path");
  }
  if (
    await optionalStat(path.join(project.launchRallyPath, ".init-transaction"))
    || await optionalStat(path.join(project.launchRallyPath, ".toolchain-transaction"))
  ) {
    return invalidAuthority(launcherVersion, "transaction_recovery_required");
  }
  try {
    const manifest = parseManifest(await readContainedFile(project.root, MANIFEST_PATH));
    assertSupportedManifestVersion(manifest);
    assertValidManifest(manifest);

    await assertContainedDirectories(project.root, ".launchrally/toolchain");
    const packageJson = await readContainedFile(project.root, TOOLCHAIN_PACKAGE_PATH);
    const lockfile = await readContainedFile(project.root, TOOLCHAIN_LOCK_PATH);
    const parsedPackage = JSON.parse(packageJson);
    const descriptorContent = await readOptionalContainedFile(
      project.root,
      EXECUTION_AUTHORITY_DESCRIPTOR_PATH,
    );
    let descriptor;
    let compatibility;
    if (descriptorContent === null) {
      const version = parsedPackage?.devDependencies?.[ENGINE_PACKAGE];
      const adapter = LEGACY_ADAPTERS.get(version);
      if (!adapter) return invalidAuthority(launcherVersion, "unknown_legacy_toolchain", {
        version: typeof version === "string" ? version : null,
      });
      descriptor = {
        contract: adapter.contract,
        engine: { package: ENGINE_PACKAGE, version, entrypoint: adapter.entrypoint },
      };
      compatibility = "legacy_adapter";
    } else {
      descriptor = JSON.parse(descriptorContent);
      if (descriptor.contract === EXECUTION_AUTHORITY_CONTRACT) {
        assertValidExecutionAuthorityDescriptor(descriptor);
        compatibility = descriptorCompatibility(descriptor);
        if (compatibility === null) {
          return invalidAuthority(launcherVersion, "unsupported_legacy_descriptor", {
            version: descriptor.engine.version,
            contract: descriptor.contract,
          });
        }
      } else if (recognizableDescriptor(descriptor)) {
        compatibility = "migration_required";
      } else {
        return invalidAuthority(launcherVersion, "invalid_authority_descriptor");
      }
    }
    const version = descriptor.engine.version;
    if (!isExactToolchain({
      packageJson,
      lockfile,
      dependency: ENGINE_PACKAGE,
      version,
    })) return invalidAuthority(launcherVersion, "invalid_toolchain_lock", {
      version,
      contract: descriptor.contract,
    });
    if (compatibility === "migration_required") {
      return attachSelection(projectAuthority({
        launcherVersion,
        state: "needs_toolchain_migration",
        version,
        compatibility,
        materialization: "migration_required",
        reason: "unsupported_engine_contract",
        nextAction: "toolchain_migrate",
        contract: descriptor.contract,
      }), {
        operation_cwd: operationCwd,
        project_root: project.root,
        engine_entrypoint: null,
      });
    }

    const installed = await optionalStat(path.join(
      project.root,
      ".launchrally/toolchain/node_modules/@launchrally/cli",
    ));
    if (!installed) {
      return attachSelection(projectAuthority({
        launcherVersion,
        state: "needs_toolchain_restore",
        version,
        compatibility,
        materialization: "missing",
        reason: compatibility === "legacy_adapter"
          ? "legacy_materialization_missing"
          : "materialization_missing",
        nextAction: "toolchain_restore",
      }), {
        operation_cwd: operationCwd,
        project_root: project.root,
        engine_entrypoint: null,
      });
    }
    const materialization = await inspectMaterialization(
      project.root,
      JSON.parse(lockfile),
      descriptor,
      compatibility,
    );
    if (materialization.state === "incomplete") {
      return attachSelection(projectAuthority({
        launcherVersion,
        state: "needs_toolchain_restore",
        version,
        compatibility,
        materialization: "missing",
        reason: compatibility === "legacy_adapter"
          ? "legacy_materialization_incomplete"
          : "materialization_incomplete",
        nextAction: "toolchain_restore",
      }), {
        operation_cwd: operationCwd,
        project_root: project.root,
        engine_entrypoint: null,
      });
    }
    if (materialization.state === "invalid") {
      return invalidAuthority(launcherVersion, "invalid_engine_materialization", {
        version,
        contract: descriptor.contract,
      });
    }
    const engineEntrypoint = materialization.engineEntrypoint;
    if (!engineEntrypoint) return invalidAuthority(
      launcherVersion,
      "invalid_engine_materialization",
      {
        version,
        contract: descriptor.contract,
      },
    );
    return attachSelection(projectAuthority({
      launcherVersion,
      state: "ready",
      version,
      compatibility,
      materialization: "ready",
      reason: compatibility === "legacy_adapter"
        ? "legacy_project_engine_validated"
        : "project_engine_validated",
      nextAction: "none",
    }), {
      operation_cwd: operationCwd,
      project_root: project.root,
      engine_entrypoint: engineEntrypoint,
    });
  } catch (error) {
    if (error?.code === "unsafe_project_path") {
      return invalidAuthority(launcherVersion, error.code);
    }
    return invalidAuthority(launcherVersion, "partial_project_state");
  }
}

export async function resolveExecutionAuthority({
  cwd,
  launcher_version: launcherVersion,
  process_cwd: processCwd = process.cwd(),
}) {
  const selectedPath = path.resolve(cwd ?? processCwd);
  const selectedStat = await lstat(selectedPath);
  if (!selectedStat.isDirectory() || selectedStat.isSymbolicLink()) {
    const error = new Error("Execution Authority requires a real directory scope.");
    error.code = "invalid_authority_scope";
    throw error;
  }
  const selected = await realpath(selectedPath);
  const project = await discoverLaunchRallyProject(selected);
  if (project) {
    const authority = await inspectProject(project, launcherVersion, selectedPath);
    assertValidExecutionAuthority(authority);
    return authority;
  }
  const authority = attachSelection({
    schema_version: EXECUTION_AUTHORITY_CONTRACT,
    state: "ready",
    source: "launcher",
    launcher_version: launcherVersion,
    engine: {
      package: ENGINE_PACKAGE,
      version: launcherVersion,
      contract: EXECUTION_AUTHORITY_CONTRACT,
      compatibility: "native",
    },
    materialization: { state: "bundled" },
    reason: "launcher_selected",
    next_action: { operation: "none" },
  }, {
    operation_cwd: selectedPath,
    project_root: null,
    engine_entrypoint: null,
  });
  assertValidExecutionAuthority(authority);
  return authority;
}
