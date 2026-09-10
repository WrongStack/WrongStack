import type { DesktopOpenSessionEntry } from '../../shared/types.js';

/** Bound the remote renderer's live-tab declaration to the WebUI's four slots. */
export function sanitizeOpenSessions(value: unknown): DesktopOpenSessionEntry[] {
  if (!Array.isArray(value)) return [];
  const sessions: DesktopOpenSessionEntry[] = [];
  const ids = new Set<string>();
  const slots = new Set<number>();
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const id = raw['id'];
    const title = raw['title'];
    const slot = raw['slot'];
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      id.length > 512 ||
      typeof title !== 'string' ||
      !Number.isInteger(slot) ||
      (slot as number) < 0 ||
      (slot as number) > 3 ||
      typeof raw['active'] !== 'boolean' ||
      typeof raw['running'] !== 'boolean' ||
      ids.has(id) ||
      slots.has(slot as number)
    ) {
      continue;
    }
    ids.add(id);
    slots.add(slot as number);
    sessions.push({
      id,
      title: title.trim().slice(0, 200) || id.slice(0, 8),
      slot: slot as number,
      active: raw['active'],
      running: raw['running'],
    });
    if (sessions.length === 4) break;
  }
  return sessions.sort((a, b) => a.slot - b.slot);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
