import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function exactToolchainPackage(version = "0.2.1") {
  return {
    name: "launchrally-toolchain",
    private: true,
    version: "0.0.0",
    devDependencies: { "@launchrally/cli": version },
    overrides: {
      "@clack/core": "1.4.3",
      "fast-string-truncated-width": "3.0.3",
      "fast-string-width": "3.0.2",
      "fast-wrap-ansi": "0.2.2",
      sisteransi: "1.0.5",
    },
  };
}

export function exactToolchainLock(version = "0.2.1") {
  const integrity = "sha512-QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQQ==";
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
          "@clack/core": "1.4.3",
          "@clack/prompts": "1.7.0",
          "@launchrally/contracts": version,
          "@launchrally/core": version,
        },
        bin: { rally: "bin/rally.js" },
        engines: { node: ">=20.12.0" },
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
      "node_modules/@clack/core": {
        version: "1.4.3",
        resolved: "https://registry.npmjs.org/@clack/core/-/core-1.4.3.tgz",
        integrity,
        dev: true,
        license: "MIT",
        dependencies: { "fast-wrap-ansi": "^0.2.0", sisteransi: "^1.0.5" },
        engines: { node: ">= 20.12.0" },
      },
      "node_modules/@clack/prompts": {
        version: "1.7.0",
        resolved: "https://registry.npmjs.org/@clack/prompts/-/prompts-1.7.0.tgz",
        integrity,
        dev: true,
        license: "MIT",
        dependencies: {
          "@clack/core": "1.4.3",
          "fast-string-width": "^3.0.2",
          "fast-wrap-ansi": "^0.2.0",
          sisteransi: "^1.0.5",
        },
        engines: { node: ">= 20.12.0" },
      },
      "node_modules/fast-string-truncated-width": {
        version: "3.0.3",
        resolved: "https://registry.npmjs.org/fast-string-truncated-width/-/fast-string-truncated-width-3.0.3.tgz",
        integrity,
        dev: true,
        license: "MIT",
      },
      "node_modules/fast-string-width": {
        version: "3.0.2",
        resolved: "https://registry.npmjs.org/fast-string-width/-/fast-string-width-3.0.2.tgz",
        integrity,
        dev: true,
        license: "MIT",
        dependencies: { "fast-string-truncated-width": "^3.0.2" },
      },
      "node_modules/fast-wrap-ansi": {
        version: "0.2.2",
        resolved: "https://registry.npmjs.org/fast-wrap-ansi/-/fast-wrap-ansi-0.2.2.tgz",
        integrity,
        dev: true,
        license: "MIT",
        dependencies: { "fast-string-width": "^3.0.2" },
      },
      "node_modules/sisteransi": {
        version: "1.0.5",
        resolved: "https://registry.npmjs.org/sisteransi/-/sisteransi-1.0.5.tgz",
        integrity,
        dev: true,
        license: "MIT",
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

export async function writeExactToolchain(repository, version = "0.2.1") {
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
