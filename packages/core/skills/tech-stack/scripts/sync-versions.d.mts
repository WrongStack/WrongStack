/** npm packages whose versions are snapshotted in stable-registry-check.json. */
export declare const REGISTRY_SNAPSHOT_PACKAGES: string[];
export declare const EXTENDED_NPM_PACKAGES: string[];
export declare const PYPI_PACKAGES: string[];

/** Latest upstream toolchain/runtime versions keyed by ecosystem (e.g. nodeCurrent, go, rust). */
export type EcosystemVersions = Partial<Record<string, string>>;

/** npm lookup results keyed by package name; only `version` is read when rewriting prose. */
export type NpmVersionMap = Record<string, { version?: string; latestTag?: string } | undefined>;

/** PyPI versions keyed by project name. */
export type PypiVersionMap = Record<string, string | undefined>;

/** Newest stable and newest LTS version (without `v`) from nodejs.org/dist/index.json; prereleases skipped. */
export declare function selectNodeReleases(list: unknown): {
  current: string | undefined;
  lts: string | undefined;
};

export declare function collectEcosystemVersions(): Promise<EcosystemVersions>;

/** `x.y.z` -> `x.y.(z+1)`; anything else is returned unchanged. */
export declare function bumpPatchVersion(versionStr: string): string;

/** `[pattern, replacement]` pairs that rewrite dated version references in skill prose. */
export declare function buildReplacementPairs(
  npmMap?: NpmVersionMap,
  pypiMap?: PypiVersionMap,
  eco?: EcosystemVersions,
  todayIso?: string,
): Array<[RegExp, string]>;
