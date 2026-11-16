// @vitest-environment jsdom
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { renderHook, waitFor } from '@testing-library/react';
import type { TokenCounter } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppProps } from '../src/app-props.js';
import type { State } from '../src/app-state.js';
import { useStatusbarViewModel } from '../src/hooks/use-statusbar-view-model.js';

const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('useStatusbarViewModel BOM resilience (F508)', () => {
  it('parses plan and task JSON files with UTF-8 BOM', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'f508-'));
    temps.push(dir);
    const planPath = path.join(dir, 'plan.json');
    const taskPath = path.join(dir, 'tasks.json');
    await fs.writeFile(
      planPath,
      `\uFEFF${JSON.stringify({ items: [{ status: 'open' }] })}`,
      'utf8',
    );
    await fs.writeFile(
      taskPath,
      `\uFEFF${JSON.stringify({ tasks: [{ status: 'completed' }] })}`,
      'utf8',
    );

    const { result, unmount } = renderHook(() =>
      useStatusbarViewModel({
        agent: {
          ctx: {
            provider: { capabilities: { maxContext: 200_000 } },
            meta: { 'plan.path': planPath, 'task.path': taskPath },
          },
        } as unknown as AppProps['agent'],
        tokenCounter: {
          account: () => undefined,
          setSessionId: () => undefined,
          currentRequestTokens: () => ({ input: 0, cacheRead: 0, cacheWrite: 0 }),
          setCurrentRequestTokens: () => undefined,
          total: () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }),
          estimateCost: () => ({ input: 0, output: 0, total: 0, currency: 'USD' }),
          cacheStats: () => ({ hitRatio: 0, readTokens: 0, writeTokens: 0, savedUsd: 0 }),
          reset: () => undefined,
        } as unknown as TokenCounter,
        activeMaxContext: 200_000,
        effectiveMaxContext: 200_000,
        liveProvider: 'openai',
        liveModel: 'gpt-4o-mini',
        liveTodos: [],
        state: {
          contextPanelOpen: false,
          contextChipVersion: 0,
          fleet: {},
          leader: {
            iterations: 0,
            toolCalls: 0,
            recentTools: [],
            startedAt: Date.now(),
            lastEventAt: Date.now(),
            currentTool: null,
            ctxPct: 0,
            ctxTokens: 0,
          },
          status: 'idle',
        } as unknown as State,
        hiddenItems: [],
      }),
    );

    await waitFor(() => {
      expect(result.current.planCounts).toEqual({ open: 1, inProgress: 0, done: 0 });
      expect(result.current.taskCounts).toEqual({
        pending: 0,
        inProgress: 0,
        completed: 1,
        blocked: 0,
        failed: 0,
      });
    });

    unmount();
  });
});
