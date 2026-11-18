/** Every `bun build --compile` target scripts/build-binaries.mjs knows. */
export declare const ALL_TARGETS: string[];

export interface BinaryBuildOptions {
  targets: string[];
  skipBuild: boolean;
}

/** Parse and validate standalone binary build arguments. */
export declare function parseBinaryBuildArgs(argv: string[]): BinaryBuildOptions;

/** Pack the selected workspace assets using the standalone extraction format. */
export declare function buildAssetPack(options?: {
  assets?: Record<string, string[]>;
  destination?: string;
}): string;

/** Release asset name for a build target, e.g. `wstack-windows-x64.exe`. */
export declare function outputName(target: string): string;

/** Shared compiler arguments used by release builds and renderer regressions. */
export declare function binaryCompileArgs(
  target: string,
  versions: { version: string; apiVersion: string; packId: string },
  entry: string,
  outfile: string,
): string[];
