import type { Message } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import {
  commitRequestLayout,
  type RequestLayoutInput,
  recordRequestLayout,
  recordRequestLayoutUsage,
} from '@wrongstack/core/utils';
import { describe, expect, it } from 'vitest';
import { buildContextCommand } from '../src/slash-commands/context.js';

const plain = (s: string | undefined): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '');

function fakeCtx(messages: Message[]): Context {
  return {
    messages,
    tools: [],
    todos: [],
    readFiles: new Set<string>(),
    fileMtimes: new Map<string, number>(),
    systemPrompt: [{ type: 'text', text: 'sys' }],
    model: 'opus',
    cwd: '/wd',
    projectRoot: '/wd',
    meta: {},
    contextEvidence: { recentUserTurns: [] },
    memoryEvidence: [],
    provider: { id: 'anthropic', capabilities: { cacheControl: 'native' } },
  } as never as Context;
}

function layout(history: Message[]): RequestLayoutInput {
  return {
    providerId: 'anthropic',
    model: 'opus',
    cacheControl: 'native',
    tools: [],
    system: [{ type: 'text', text: 'stable system prompt '.repeat(30) }],
    history,
    messages: history,
    tail: [{ source: 'ledger', block: { type: 'text', text: '[completed_work] x' } }],
    durableMessages: history,
  };
}

describe('/context residency', () => {
  it('says no request was sent yet on a fresh context', async () => {
    const cmd = buildContextCommand({ renderer: { write() {} } } as never);
    const res = await cmd.run('residency', fakeCtx([]));
    expect(plain(res?.message)).toContain('no request sent yet');
  });

  it('maps the last request into cache lanes, verdict, breakers and retention', async () => {
    const h1: Message[] = [{ role: 'user', content: 'first question' }];
    const ctx = fakeCtx(h1);
    const r1 = {};
    recordRequestLayout(r1, layout(h1));
    commitRequestLayout(ctx, r1, 1_000);
    const h2: Message[] = [
      { role: 'system', content: '[context_state]\ncompacted' },
      { role: 'user', content: 'after compaction' },
    ];
    ctx.messages.splice(0, ctx.messages.length, ...h2);
    const r2 = {};
    recordRequestLayout(r2, layout(h2));
    commitRequestLayout(ctx, r2, 2_000);
    recordRequestLayoutUsage(r2, { input: 40, output: 3, cacheRead: 120, cacheWrite: 30 });

    const cmd = buildContextCommand({ renderer: { write() {} } } as never);
    const text = plain((await cmd.run('residency', ctx))?.message);
    expect(text).toContain('system prompt (stable)');
    expect(text).toMatch(/system prompt \(stable\)\s+[\d,]+\s+cached/);
    expect(text).toMatch(/live context · this request\s+[\d,]+\s+not cached/);
    expect(text).toContain('ledger');
    expect(text).toContain('broke:     history');
    expect(text).toContain('read 120, write 30, fresh 40');
    expect(text).toContain('History retention');
    expect(text).toContain('compaction digests');

    const summary = plain((await cmd.run('', ctx))?.message);
    expect(summary).toContain('last request:');
    expect(summary).toContain('provider read 120 of 190');
  });
});
