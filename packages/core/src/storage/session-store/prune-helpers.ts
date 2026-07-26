import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

export async function readActiveSessionId(storeDir: string): Promise<string | null> {
  try {
    const raw = await fsp.readFile(path.join(storeDir, 'active.json'), 'utf8');
    const active = JSON.parse(raw) as { sessionId?: string | undefined };
    return active.sessionId ?? null;
  } catch {
    return null;
  }
}

export function isPrunableSessionJsonl(name: string): boolean {
  return (
    name.endsWith('.jsonl') &&
    name !== '_index.jsonl' &&
    name !== '_mailbox.jsonl' &&
    !name.endsWith('.replay.jsonl') &&
    !name.endsWith('.audit.jsonl')
  );
}
