import { createHash } from 'node:crypto';
import type { Config, ConfigStore, SecretVault } from '@wrongstack/contracts/types';
import {
  jevActivitySnapshot,
  jevSettingsSnapshot,
  saveJevSettings,
  testJevConnection,
} from '@wrongstack/core/typesafe';
import type { JevCheckReport } from '@wrongstack/runtime/jev-checks';
import type { WebSocket } from 'ws';
import type { WSClientMessage, WSServerMessage } from './types.js';

export interface JevRouteContext {
  store: ConfigStore | undefined;
  file: string;
  vault: SecretVault | undefined;
  send: (ws: WebSocket, message: WSServerMessage) => void;
  check?: ((config: Readonly<Config>) => Promise<JevCheckReport>) | undefined;
}

interface CheckState {
  key: string;
  running?: Promise<JevCheckReport> | undefined;
  report?: JevCheckReport | undefined;
}
const checks = new WeakMap<ConfigStore, CheckState>();
const accountKey = (config: Readonly<Config>) =>
  createHash('sha256')
    .update(JSON.stringify(config.typesafe ?? {}))
    .digest('hex');

export async function handleJevRoute(
  ctx: JevRouteContext,
  ws: WebSocket,
  msg: WSClientMessage,
): Promise<boolean> {
  if (!['jev.get', 'jev.set', 'jev.test', 'jev.check'].includes(msg.type)) return false;
  const p = msg.payload as { requestId?: unknown; patch?: unknown } | undefined;
  const requestId = typeof p?.requestId === 'string' ? p.requestId.slice(0, 100) : undefined;
  if (!ctx.store) {
    ctx.send(ws, {
      type: 'jev.state',
      payload: { requestId, error: 'Jev settings unavailable on this host' },
    });
    return true;
  }
  let error: string | undefined;
  let message: string | undefined;
  try {
    if (msg.type === 'jev.set') {
      await saveJevSettings(ctx.store, ctx.file, ctx.vault, p?.patch);
      message =
        ctx.store.get().typesafe?.enabled === true
          ? 'Saved. Restart existing sessions to install newly enabled Jev consumers.'
          : 'Saved. All Jev requests disabled; the saved key and feature choices are preserved.';
    }
    if (msg.type === 'jev.test') message = await testJevConnection(ctx.store.get());
    if (msg.type === 'jev.check') {
      const config = ctx.store.get();
      if (config.typesafe?.enabled !== true) throw new Error('Jev is disabled');
      const key = accountKey(config);
      let state = checks.get(ctx.store);
      if (state?.running && state.key !== key)
        throw new Error('A previous account check is still running');
      if (!state || state.key !== key) {
        state = { key };
        checks.set(ctx.store, state);
      }
      if (!state.running) {
        const target = state;
        target.report = undefined;
        target.running = (
          ctx.check
            ? ctx.check(config)
            : import('@wrongstack/runtime/jev-checks').then(({ checkJevJudgments }) =>
                checkJevJudgments(config),
              )
        )
          .then((report) => {
            target.report = report;
            return report;
          })
          .finally(() => {
            target.running = undefined;
          });
      }
      await state.running;
    }
  } catch {
    // Provider errors may echo request content or headers. Never put them on the wire.
    error =
      msg.type === 'jev.test' || msg.type === 'jev.check'
        ? 'Connection test failed. Check account settings and the activity log.'
        : 'Could not save Jev settings. Check field values, custom endpoint and profile file permissions.';
  }
  const checked = checks.get(ctx.store);
  ctx.send(ws, {
    type: 'jev.state',
    payload: {
      requestId,
      settings: jevSettingsSnapshot(ctx.store.get()),
      activity: jevActivitySnapshot(),
      checks:
        checked?.key === accountKey(ctx.store.get())
          ? { running: Boolean(checked.running), report: checked.report }
          : { running: false },
      error,
      message,
    },
  });
  return true;
}
