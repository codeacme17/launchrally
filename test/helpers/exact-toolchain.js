import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function exactToolchainPackage(version = "0.1.0") {
  return {
    name: "launchrally-toolchain",
    private: true,
    version: "0.0.0",
    devDependencies: { "@launchrally/cli": version },
  };
}

export function exactToolchainLock(version = "0.1.0") {
  return {
    name: "launchrally-toolchain",
    version: "0.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "launchrally-toolchain",
        version: "0.0.0",
        devDependencies: { "@launchrally/cli": version },
      },
      "node_modules/@launchrally/cli": {
        version,
        resolved: `https://registry.npmjs.org/@launchrally/cli/-/cli-${version}.tgz`,
        integrity: "sha512-QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQQ==",
        dev: true,
        license: "Apache-2.0",
        dependencies: {
          "@launchrally/contracts": version,
          "@launchrally/core": version,
        },
        bin: { rally: "bin/rally.js" },
        engines: { node: ">=20" },
      },
      "node_modules/@launchrally/contracts": {
        version,
        resolved: `https://registry.npmjs.org/@launchrally/contracts/-/contracts-${version}.tgz`,
        integrity: "sha512-QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQg==",
        dev: true,
        license: "Apache-2.0",
      },
      "node_modules/@launchrally/core": {
        version,
        resolved: `https://registry.npmjs.org/@launchrally/core/-/core-${version}.tgz`,
        integrity: "sha512-Q0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQw==",
        dev: true,
        license: "Apache-2.0",
        dependencies: { "@launchrally/contracts": version },
      },
    },
  };
}

export function prepareExactToolchainChanges({ package_path: packagePath, lockfile, version }) {
  return [
    {
      path: packagePath,
      content: `${JSON.stringify(exactToolchainPackage(version), null, 2)}\n`,
    },
    {
      path: lockfile.path,
      content: `${JSON.stringify(exactToolchainLock(version), null, 2)}\n`,
    },
  ];
}

export async function writeExactToolchain(repository, version = "0.1.0") {
  const directory = path.join(repository, ".launchrally", "toolchain");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify(exactToolchainPackage(version), null, 2)}\n`,
  );
  await writeFile(
    path.join(directory, "package-lock.json"),
    `${JSON.stringify(exactToolchainLock(version), null, 2)}\n`,
  );
}
