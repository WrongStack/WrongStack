/** A file path as the project shows it: relative to its root when inside it. */
export function projectPath(file: string, projectRoot: string): string {
  const normalized = file.replace(/^\\\\\?\\/, '').replaceAll('\\', '/');
  const root = projectRoot
    .replace(/^\\\\\?\\/, '')
    .replaceAll('\\', '/')
    .replace(/\/$/, '');
  return normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ? normalized.slice(root.length + 1)
    : normalized;
}
