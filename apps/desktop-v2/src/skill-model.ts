export function skillInstructions(document: string): string {
  const normalized = document.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n')) return document;
  const end = normalized.indexOf('\n---', 4);
  return end < 0 ? document : normalized.slice(end + 4).replace(/^\n/, '');
}
export function skillSource(source: unknown): string {
  return (
    (
      {
        project: 'This project',
        user: 'WrongStack profile',
        bundled: 'Bundled',
        foreign: 'Other agent',
        'claude-project': 'Claude project',
        'claude-user': 'Claude user',
        extra: 'Additional directory',
      } as Record<string, string>
    )[String(source)] ?? String(source ?? 'Unknown source')
  );
}
export function skillWritable(source: unknown, scope: 'project' | 'profile'): boolean {
  return source === (scope === 'project' ? 'project' : 'user');
}
export function downloadSkillFile(content: BlobPart, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function skillSourceLink(source: unknown): string {
  const value = String(source ?? '');
  const github = /^github:([\w.-]+\/[\w.-]+)$/.exec(value);
  return github ? `https://github.com/${github[1]}` : /^https?:\/\//.test(value) ? value : '';
}
export function skillUpdateSummary(
  result: Record<string, unknown>,
  words = (updated: number, unchanged: number, failed: number) =>
    `${updated} updated · ${unchanged} unchanged · ${failed} failed.`,
): string {
  const updated = Array.isArray(result['updated']) ? result['updated'].length : 0;
  const unchanged = Array.isArray(result['unchanged']) ? result['unchanged'].length : 0;
  const failed = Array.isArray(result['errors']) ? result['errors'].length : 0;
  return words(updated, unchanged, failed);
}
