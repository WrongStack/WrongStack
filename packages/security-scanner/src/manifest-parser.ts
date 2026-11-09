import type { DetectedDependency } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectDependencies(
  value: unknown,
  isDev: boolean,
  collected: Map<string, DetectedDependency>,
): void {
  if (!isRecord(value)) return;
  for (const [name, version] of Object.entries(value)) {
    if (typeof version !== 'string' || !name.trim() || !version.trim()) continue;
    collected.set(name, { name, version, isDev });
  }
}

export function parseNodeDependencies(content: string): DetectedDependency[] {
  try {
    // npm accepts a leading UTF-8 BOM (Windows editors write one); JSON.parse
    // does not, and the whole manifest read as zero dependencies.
    const manifest: unknown = JSON.parse(
      content.charCodeAt(0) === 0xfeff ? content.slice(1) : content,
    );
    if (!isRecord(manifest)) return [];
    const dependencies = new Map<string, DetectedDependency>();
    collectDependencies(manifest.devDependencies, true, dependencies);
    collectDependencies(manifest.optionalDependencies, false, dependencies);
    collectDependencies(manifest.peerDependencies, false, dependencies);
    collectDependencies(manifest.dependencies, false, dependencies);
    return [...dependencies.values()].sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}
