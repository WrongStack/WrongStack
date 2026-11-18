/** Public helpers shared by desktop packaging and its contract tests. */
export declare const ENGINE_TARGETS: {
  readonly 'bun-windows-x64': 'x86_64-pc-windows-msvc';
  readonly 'bun-windows-arm64': 'aarch64-pc-windows-msvc';
  readonly 'bun-linux-x64': 'x86_64-unknown-linux-gnu';
  readonly 'bun-linux-arm64': 'aarch64-unknown-linux-gnu';
  readonly 'bun-darwin-x64': 'x86_64-apple-darwin';
  readonly 'bun-darwin-arm64': 'aarch64-apple-darwin';
};
export declare function engineTargetForTriple(triple: string): keyof typeof ENGINE_TARGETS;
export declare function hostTriple(): string;
export declare function engineSidecarPath(triple: string, dir?: string): string;
export declare function createEngineEntry(source: string): string;
export declare function buildEngine(options?: { skipBuild?: boolean; triple?: string }): string;
