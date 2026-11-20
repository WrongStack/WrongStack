/**
 * #448: a spare engine takes a default model saved after it booted, until a
 * conversation claims it. The spare becomes that conversation as-is, so it
 * started on whatever default was saved at boot ("Connect a provider" when
 * there was none).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  opts: undefined as undefined | { followSavedDefault?: () => boolean },
  started: Promise.withResolvers<void>(),
  claim: Promise.withResolvers<{ fork: boolean }>(),
}));
vi.mock('@wrongstack/core/utils', () => ({ hardenWin32ExecutableSearch: () => {} }));
vi.mock('@wrongstack/webui-server', () => ({
  startWebUI: async (opts: typeof backend.opts) => {
    backend.opts = opts;
    backend.started.resolve();
  },
}));
vi.mock('../engine/stop-request', () => ({ stopGracefully: vi.fn(), watchStopRequest: vi.fn() }));
vi.mock('../engine/spare-claim', () => ({
  spareMaxAge: () => 60_000,
  waitForSpareClaim: () => backend.claim.promise,
}));

const dir = mkdtempSync(path.join(tmpdir(), 'spare-follow-'));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

it('follows the saved default only until a conversation claims the spare', async () => {
  const ready = path.join(dir, 'ready.json');
  vi.stubGlobal(
    'process',
    Object.assign(Object.create(process), { argv: ['bun', 'engine', '--port', '14201'] }),
  );
  vi.stubEnv('WEBUI_TOKEN', 'spare-follow-fixture');
  vi.stubEnv('WRONGSTACK_DESKTOP_EMPTY_DIST', 'fixture');
  vi.stubEnv('WRONGSTACK_DESKTOP_SPARE_CLAIM', path.join(dir, 'claim.json'));
  vi.stubEnv('WRONGSTACK_DESKTOP_RESTORE_READY', ready);
  vi.stubEnv('WRONGSTACK_DESKTOP_HOST_PID', undefined);
  vi.stubEnv('WRONGSTACK_DESKTOP_STOP_FILE', undefined);

  const engine = import('../engine/main');
  await backend.started.promise;
  expect(backend.opts?.followSavedDefault?.()).toBe(true);

  backend.claim.resolve({ fork: false });
  await engine;

  expect(JSON.parse(readFileSync(ready, 'utf8'))).toEqual({ sessionId: 'new' });
  expect(backend.opts?.followSavedDefault?.()).toBe(false);
});
