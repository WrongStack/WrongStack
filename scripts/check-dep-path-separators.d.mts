export function findBackslashSpecsInManifest(
  file: string,
  manifest: Record<string, unknown>,
): string[];

export function parseWorkspacePackages(yamlText: string): string[];

export function parseOverrideSpecs(yamlText: string): Array<{ name: string; spec: string }>;

export function expandWorkspaceMembers(root: string, entries: string[]): string[];

export function collectFindings(root: string): string[];
