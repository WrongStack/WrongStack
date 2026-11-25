import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HqNotifier } from '../src/notifier.js';

describe('HqNotifier malformed notification link handling (F1854)', () => {
  it('omits the link and still delivers when note.path cannot form a valid URL', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-notifier-link-'));
    try {
      const bodies: Record<string, unknown>[] = [];
      const notifier = new HqNotifier(tmpDir, {
        fetch: async (_url, init) => {
          bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return { ok: true, status: 200 };
        },
        now: () => Date.parse('2026-11-25T12:00:00.000Z'),
      });
      await notifier.updateSettings({ publicUrl: 'https://hq.example.com/app' });
      await notifier.addChannel({
        name: 'ops',
        type: 'webhook',
        url: 'https://hooks.example.com/notify',
        enabled: true,
        kinds: ['alert'],
        minSeverity: 'info',
      });

      notifier.notify({
        kind: 'alert',
        severity: 'warn',
        title: 'Valid',
        body: 'Valid path',
        dedupeKey: 'v1',
        path: '/fleet/alerts',
      });
      notifier.notify({
        kind: 'alert',
        severity: 'warn',
        title: 'Malformed',
        body: 'Malformed path',
        dedupeKey: 'b1',
        path: 'http://[invalid',
      });
      await notifier.drain();

      expect(bodies).toHaveLength(2);
      expect(bodies[0]?.link).toBe('https://hq.example.com/app/fleet/alerts');
      expect(bodies[1]?.link).toBeUndefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
