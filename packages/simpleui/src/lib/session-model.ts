import type { SimpleSessionSummary } from '../types.js';

export function parseSessionSummaries(value: unknown): SimpleSessionSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Record<string, unknown>;
    if (typeof item['id'] !== 'string') return [];
    return [
      {
        id: item['id'],
        title: typeof item['title'] === 'string' ? item['title'] : '',
        name: typeof item['name'] === 'string' ? item['name'] : undefined,
        startedAt: typeof item['startedAt'] === 'string' ? item['startedAt'] : '',
        model: typeof item['model'] === 'string' ? item['model'] : '',
        provider: typeof item['provider'] === 'string' ? item['provider'] : '',
        isCurrent: item['isCurrent'] === true,
      },
    ];
  });
}

export function sessionDisplayName(
  session: SimpleSessionSummary | undefined,
  fallbackId = '',
): string {
  const explicit = session?.name?.trim();
  if (explicit) return explicit;
  const title = session?.title.trim();
  if (title) return title;
  const id = session?.id || fallbackId;
  const leaf = id.replace(/\\/g, '/').split('/').pop() ?? id;
  return leaf ? `Session ${leaf.slice(0, 8)}` : 'Current session';
}

export function relativeSessionTime(startedAt: string, now = Date.now()): string {
  const timestamp = Date.parse(startedAt);
  if (!Number.isFinite(timestamp)) return '';
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
