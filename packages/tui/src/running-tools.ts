/**
 * Render an at-a-glance "running: …" hint for the status bar. Shows the
 * oldest in-flight tool by name; if more than one, appends "(+N)".
 */
export function renderRunningTools(
  running: ReadonlyMap<string, { name: string; startedAt: number }>,
): string {
  if (running.size === 0) return '';
  let oldest: { name: string; startedAt: number } | null = null;
  for (const info of running.values()) {
    if (!oldest || info.startedAt < oldest.startedAt) oldest = info;
  }
  if (!oldest) return '';
  const elapsedSec = ((Date.now() - oldest.startedAt) / 1000).toFixed(1);
  const more = running.size > 1 ? ` (+${running.size - 1})` : '';
  return `running: ${oldest.name} ${elapsedSec}s${more}`;
}
