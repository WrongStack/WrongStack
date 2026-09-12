import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getSessionSubagentModelPlan,
  resetSessionSubagentModelPlan,
  restoreSessionSubagentModelPlan,
} from '@wrongstack/core/coordination';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import type { SessionWriter } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSubagentModelsPanelHost } from '../src/subagent-models/panel-service.js';

const SESSION_ID = 'subagent-model-panel-journal';

let tempDir: string;
let store: DefaultSessionStore;
let writer: SessionWriter | undefined;

afterEach(async () => {
  await writer?.close().catch(() => {});
  resetSessionSubagentModelPlan(SESSION_ID);
  await fs.rm(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-subagent-panel-'));
  store = new DefaultSessionStore({ dir: tempDir });
  resetSessionSubagentModelPlan(SESSION_ID);
});

describe('subagent-models panel host', () => {
  it('journals a selected lane and restores it into a fresh panel host after reload', async () => {
    writer = await store.create({ id: SESSION_ID, model: 'claude-opus-5', provider: 'anthropic' });
    const liveContext = {
      meta: {} as Record<string, unknown>,
      session: writer,
    };
    const liveHost = createSubagentModelsPanelHost({
      getContext: () => liveContext as never,
      getSessionTarget: () => ({ provider: 'anthropic', model: 'claude-opus-5' }),
    });

    expect(await liveHost.setLane(0, { provider: 'openai', model: 'gpt-5' })).toBeNull();
    expect(liveHost.snapshot().lanes[0]?.target).toBe('openai/gpt-5');

    await writer.close();
    writer = undefined;
    const persisted = await store.load(SESSION_ID);
    expect(persisted.events).toContainEqual(
      expect.objectContaining({
        type: 'subagent_model_plan',
        plan: expect.objectContaining({
          slots: expect.arrayContaining([{ provider: 'openai', model: 'gpt-5' }]),
        }),
      }),
    );

    // A process/session reload starts with no live model-plan registry.
    resetSessionSubagentModelPlan(SESSION_ID);
    expect(getSessionSubagentModelPlan(SESSION_ID)).toBeUndefined();

    const resumed = await store.resume(SESSION_ID);
    writer = resumed.writer;
    const reloadedContext = {
      meta: {} as Record<string, unknown>,
      session: resumed.writer,
    };
    restoreSessionSubagentModelPlan(reloadedContext as never, resumed.data.events);
    const reloadedHost = createSubagentModelsPanelHost({
      getContext: () => reloadedContext as never,
      getSessionTarget: () => ({ provider: 'anthropic', model: 'claude-opus-5' }),
    });

    expect(reloadedHost.snapshot().lanes[0]?.target).toBe('openai/gpt-5');
  });
});
