import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function readPackageVersion(
  load: () => { version?: unknown } = () => require('../package.json') as { version?: unknown },
): string {
  try {
    const packageJson = load();
    if (typeof packageJson.version === 'string' && packageJson.version.length > 0) {
      return packageJson.version;
    }
  } catch {
    // Source-only or embedded builds may not ship package metadata.
  }
  return 'dev';
}

export const ACP_PACKAGE_VERSION = readPackageVersion();

/** Direct-module test seam; not re-exported by the package barrel. */
export const versionCoverage = { readPackageVersion };
