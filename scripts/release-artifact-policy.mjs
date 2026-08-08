export function assertNoConsumerInstallScripts(lockfile) {
  for (const [packagePath, entry] of Object.entries(lockfile?.packages ?? {})) {
    if (packagePath && entry?.hasInstallScript === true) {
      throw new Error(`consumer_install_lifecycle_script: ${packagePath}`);
    }
  }
}
