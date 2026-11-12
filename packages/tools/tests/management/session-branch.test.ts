import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import type { Provider } from '@wrongstack/contracts/types/provider';
import { Context } from '@wrongstack/core/agent';
import { DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import { clampSubagentCapabilities } from '@wrongstack/core/security';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSessionBranchTool,
  SESSION_BRANCH_TOOL_NAME,
} from '../../src/management/session-branch.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe('session_branch management tool', () => {
  it('forks, inspects, switches, and folds exploratory branches in the active session', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-branch-tool-'));
    const store = new DefaultSessionStore({ dir });
    cleanups.push(async () => {
      await store.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    });

    const writer = await store.create({ id: '', model: 'm', provider: 'p' });
    cleanups.push(async () => {
      await writer.close();
    });

    await writer.append({
      type: 'user_input',
      ts: '2026-11-12T11:00:00.000Z',
      content: 'Stabilize flaky database migration',
    });

    const ctx = new Context({
      systemPrompt: [],
      provider: {} as Provider,
      session: writer,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: dir,
      projectRoot: dir,
      model: 'm',
    });

    const events = new EventBus();
    const switchedEvents: Array<{ branchName: string }> = [];
    events.on('session.branch_switched', (payload) => {
      switchedEvents.push({ branchName: payload.branchName });
    });

    const tool = createSessionBranchTool({
      getSessionStore: () => store,
      getSessionsDir: () => dir,
      events,
    });
    expect(tool.name).toBe(SESSION_BRANCH_TOOL_NAME);

    const run = (input: Parameters<typeof tool.execute>[0]) =>
      tool.execute(input, ctx, { signal: new AbortController().signal });

    const createdOut = await run({
      action: 'branch',
      name: 'try-advisory-lock',
      label: 'Test pg_advisory_xact_lock',
    });
    expect(createdOut).toContain('Created and switched to session branch "try-advisory-lock"');
    expect(switchedEvents.at(-1)?.branchName).toBe('try-advisory-lock');

    await writer.append({
      type: 'user_input',
      ts: '2026-11-12T11:01:00.000Z',
      content: 'Advisory lock resolved concurrent migration deadlock in runner.ts',
    });

    const statusOut = await run({ action: 'status' });
    expect(statusOut).toContain('* try-advisory-lock');
    expect(statusOut).toContain('main');

    const foldedOut = await run({
      action: 'fold',
      focus: 'Deadlock resolution',
    });
    expect(foldedOut).toContain('Folded branch "try-advisory-lock" -> "main"');
    expect(
      ctx.messages.some((m) => String(m.content).includes('[Branch Fold-Back: try-advisory-lock]')),
    ).toBe(true);

    const switchedBack = await run({
      action: 'switch',
      target: 'try-advisory-lock',
      keepFiles: true,
    });
    expect(switchedBack).toContain('Switched session branch "main" -> "try-advisory-lock"');
  });

  it('validates required inputs and is excluded from the subagent capability ceiling', async () => {
    const tool = createSessionBranchTool({
      getSessionStore: () => undefined,
    });
    const { dropped } = clampSubagentCapabilities(tool.capabilities ?? []);
    expect(dropped).toEqual(tool.capabilities);

    await expect(
      tool.execute({ action: 'branch' }, {} as never, { signal: new AbortController().signal }),
    ).rejects.toThrow(/unavailable|name is required/);
  });
});
