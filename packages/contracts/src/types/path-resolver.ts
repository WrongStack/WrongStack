export interface PathResolver {
  readonly projectRoot: string;
  readonly cwd: string;
  resolve(input: string): string;
  isInsideRoot(absPath: string): boolean;
  ensureInsideRoot(absPath: string): string;
  detectProjectRoot(start: string): string;
}
