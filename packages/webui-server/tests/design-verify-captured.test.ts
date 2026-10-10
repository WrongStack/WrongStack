import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import { saveCapturedTokens } from '@wrongstack/core/design';
import {
  handleDesignUse,
  handleDesignVerify,
  type DesignContext,
} from '../src/server/design-handlers.js';

/**
 * handleDesignVerify is capture-aware: it resolves the token basis with the
 * same precedence as the `design` tool (pinned kit > captured project tokens
 * > error) and LABELS the payload with which basis produced the report, so a
 * percentage from the gallery is never mistaken for a kit score.
 */

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-verify-cap-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

interface Sent {
  type: string;
  payload: Record<string, unknown>;
}

function capturingWs(): { ws: WebSocket; sent: Sent[] } {
  const sent: Sent[] = [];
  const ws = {
    readyState: 1,
    send: (data: string) => {
      sent.push(JSON.parse(data) as Sent);
    },
  } as unknown as WebSocket;
  return { ws, sent };
}

const ctx = (): DesignContext => ({ projectRoot: tmp });
const CAPTURE = {
  stack: 'web',
  files: ['src/index.css'],
  tokens: { light: { primary: '#ff0000' }, dark: { primary: '#ff0000' } },
};

describe('handleDesignVerify — captured tokens basis', () => {
  it('verifies against the capture with no kit pinned and labels the source', async () => {
    await saveCapturedTokens(tmp, CAPTURE);
    await fs.writeFile(path.join(tmp, 'app.css'), '.x { color: #123123; }\n');

    const { ws, sent } = capturingWs();
    await handleDesignVerify(ws, ctx());

    const reply = sent.find((m) => m.type === 'design.verify');
    expect(reply?.payload.ok).toBe(true);
    expect(reply?.payload.source).toBe('captured');
    expect(reply?.payload.kit).toBeNull();
    expect(reply?.payload.capturedFrom).toEqual(['src/index.css']);
    // The off-capture hex is flagged — the capture is a real basis.
    expect(reply?.payload.violationCount ?? 0).toBeGreaterThan(0);
  });

  it('reports a kit basis when a kit is pinned, even with a capture present', async () => {
    const use = capturingWs();
    await handleDesignUse(use.ws, ctx(), { payload: { kit: 'minimal-clarity', stack: 'web' } });
    expect(use.sent.find((m) => m.type === 'design.use')?.payload.ok).toBe(true);
    await saveCapturedTokens(tmp, CAPTURE); // kit wins, not the capture

    const { ws, sent } = capturingWs();
    await handleDesignVerify(ws, ctx());

    const reply = sent.find((m) => m.type === 'design.verify');
    expect(reply?.payload.ok).toBe(true);
    expect(reply?.payload.source).toBe('kit');
    expect(reply?.payload.kit).toBe('minimal-clarity');
    expect(reply?.payload.capturedFrom).toBeNull();
  });

  it('errors with actionable guidance when neither kit nor capture exists', async () => {
    const { ws, sent } = capturingWs();
    await handleDesignVerify(ws, ctx());

    const reply = sent.find((m) => m.type === 'design.verify');
    expect(reply?.payload.ok).toBe(false);
    expect(reply?.payload.error).toMatch(/No active kit or captured tokens/);
  });
});
