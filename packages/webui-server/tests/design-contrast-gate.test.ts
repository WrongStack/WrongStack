import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import {
  handleDesignMaterialize,
  handleDesignSet,
  handleDesignUse,
  type DesignContext,
} from '../src/server/design-handlers.js';

/**
 * The WS handlers run the same WCAG AA gate as the `design` tool
 * (`kitContrastIssues`): a contrast-breaking override must be reported in the
 * design.use / design.materialize payloads — never by refusing the action.
 */

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-contrast-'));
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
/** Near-white primary on minimal-clarity's oklch(99% 0 0) light bg: ~1.2:1. */
const BAD_OVERRIDE = 'oklch(95% 0.02 250)';

describe('WS design handlers — WCAG AA contrast gate', () => {
  it('design.use reports failing pairs in contrastIssues', async () => {
    const { ws, sent } = capturingWs();
    await handleDesignUse(ws, ctx(), {
      payload: {
        kit: 'minimal-clarity',
        stack: 'web',
        overrides: { 'light.primary': BAD_OVERRIDE },
      },
    });

    const reply = sent.find((m) => m.type === 'design.use');
    expect(reply?.payload.ok).toBe(true);
    const issues = reply?.payload.contrastIssues as Array<{
      theme: string;
      pair: string;
      ratio: number;
    }>;
    expect(issues).toBeDefined();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ theme: 'light', pair: 'primary/bg' });
    expect(issues[0]?.ratio).toBeLessThan(4.5);
  });

  it('design.use reports an empty (not missing) contrastIssues for a clean kit', async () => {
    const { ws, sent } = capturingWs();
    await handleDesignUse(ws, ctx(), { payload: { kit: 'minimal-clarity', stack: 'web' } });

    const reply = sent.find((m) => m.type === 'design.use');
    expect(reply?.payload.ok).toBe(true);
    expect(reply?.payload.contrastIssues).toEqual([]);
  });

  it('design.materialize still writes the theme file and carries the warning', async () => {
    // Pin a clean kit, then break AA through design.set — the override lives
    // in .design/active.json, exactly the path a gallery tab would take.
    const use = capturingWs();
    await handleDesignUse(use.ws, ctx(), { payload: { kit: 'minimal-clarity', stack: 'web' } });
    expect(use.sent.find((m) => m.type === 'design.use')?.payload.ok).toBe(true);

    const set = capturingWs();
    await handleDesignSet(set.ws, ctx(), {
      payload: { overrides: { 'light.primary': BAD_OVERRIDE } },
    });
    expect(set.sent.find((m) => m.type === 'design.set')?.payload.ok).toBe(true);

    const { ws, sent } = capturingWs();
    await handleDesignMaterialize(ws, ctx(), { payload: {} });
    const reply = sent.find((m) => m.type === 'design.materialize');
    // Warn, never block: the payload is ok AND the file landed on disk.
    expect(reply?.payload.ok).toBe(true);
    const issues = reply?.payload.contrastIssues as Array<{
      theme: string;
      pair: string;
      ratio: number;
    }>;
    expect(issues?.[0]).toMatchObject({ theme: 'light', pair: 'primary/bg' });
    expect(issues[0]?.ratio).toBeLessThan(4.5);
    const written = await fs.readFile(path.join(tmp, 'src', 'styles', 'design-tokens.css'), 'utf8');
    expect(written).toContain('--primary');
  });
});
