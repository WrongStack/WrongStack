export interface BunLock {
  packages: Record<string, [string, string, Record<string, unknown>, ...unknown[]]>;
  patchedDependencies: Record<string, string>;
  overrides: Record<string, unknown>;
  workspaces: Record<string, unknown>;
}
export function readBunLock(file: string): BunLock;
