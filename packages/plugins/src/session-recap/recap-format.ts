export function formatDuration(startedAt: string | null, lastActivityAt: string | null): string {
  if (!startedAt) return '0s';
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return '0s';
  const end = lastActivityAt ? Date.parse(lastActivityAt) : Date.now();
  if (!Number.isFinite(end)) return '0s';
  const ms = Math.max(0, end - start);
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m${remSec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h${remMin}m`;
}

export function topN<T>(map: Map<string, T>, n: number): Array<[string, T]> {
  return [...map.entries()]
    .sort((a, b) => {
      // Sort by numeric value when possible
      const av = a[1] as unknown;
      const bv = b[1] as unknown;
      if (typeof av === 'number' && typeof bv === 'number') return bv - av;
      return 0;
    })
    .slice(0, n);
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n\n[truncated ${s.length - max} chars]` : s;
}
