/**
 * Normalize spellings of a churn-tracked file. Resolving relative against
 * absolute paths needs the session cwd, which tool events do not carry.
 */
function churnPathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  let key = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (key.startsWith('./')) key = key.slice(2);
  return platform === 'win32' ? key.toLowerCase() : key;
}

/** Prefer declared write targets (including patch diffs), then input paths. */
export function editedPaths(
  input: unknown,
  writeTargets: readonly string[] | undefined,
): Array<{ key: string; path: string }> {
  const out = new Map<string, string>();
  const add = (path: unknown) => {
    if (typeof path !== 'string' || path.length === 0) return;
    const key = churnPathKey(path);
    if (!out.has(key)) out.set(key, path);
  };
  for (const target of writeTargets ?? []) add(target);
  if (out.size === 0 && input && typeof input === 'object') {
    const r = input as Record<string, unknown>;
    add(r['file_path'] ?? r['path'] ?? r['filePath'] ?? r['file']);
  }
  return [...out].map(([key, path]) => ({ key, path }));
}
