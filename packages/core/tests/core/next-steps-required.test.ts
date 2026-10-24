/**
 * `autonomy.nextSteps: 'required'` — the side request that fills in a missing
 * `<nextsteps>` block, and the completion marker that ends a run instead.
 */

import { TOKENS } from '@wrongstack/contracts/kernel/tokens';
import type { Provider, Request, Response } from '@wrongstack/contracts/types/provider';
import { describe, expect, it, vi } from 'vitest';
import { buildLiveNextStepsGateBlock } from '../../src/core/agent-response.js';
import type { TodoItem } from '../../src/core/context.js';
import {
  maybeRequireNextSteps,
  NEXT_STEPS_REQUIRED_PROMPT,
  readNextStepsMode,
} from '../../src/core/next-steps-required.js';
import {
  hasNextStepsCompleteMarker,
  NEXT_STEPS_COMPLETE_MARKER,
  parseNextSteps,
  stripNextStepsBlock,
} from '../../src/utils/next-steps.js';

const text = (t: string, stopReason: Response['stopReason'] = 'end_turn'): Response => ({
  model: 'm',
  content: [{ type: 'text', text: t }],
  stopReason,
  usage: { input: 0, output: 0 },
});

function setup(
  opts: {
    mode?: 'optional' | 'required' | undefined;
    metaMode?: string | undefined;
    todos?: TodoItem[];
    agentId?: string;
    reply?: string | Error;
  } = {},
) {
  const meta: Record<string, unknown> = {};
  if (opts.metaMode !== undefined) meta['nextStepsMode'] = opts.metaMode;
  const config = { autonomy: opts.mode ? { nextSteps: opts.mode } : {} };
  const container = {
    safeResolve: (token: unknown) =>
      token === TOKENS.ConfigStore ? { get: () => config } : undefined,
  };
  const account = vi.fn();
  const ctx = {
    agentId: opts.agentId ?? 'leader',
    todos: opts.todos ?? [],
    meta,
    signal: new AbortController().signal,
    tokenCounter: { account },
  };
  const warn = vi.fn();
  const a = { container, ctx, logger: { warn, debug: vi.fn() } } as never;
  const complete = vi.fn(async (_req: Request) => {
    if (opts.reply instanceof Error) throw opts.reply;
    return text(opts.reply ?? '');
  });
  const provider = { id: 'p', complete } as unknown as Provider;
  const req: Request = {
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'do the task' }] }],
  } as Request;
  return { a, ctx, provider, req, complete, account, warn };
}

describe('completion marker parsing', () => {
  it('is detected outside fences and stripped from the rendered body', () => {
    const body = `Done, tests pass.\n${NEXT_STEPS_COMPLETE_MARKER}\n`;
    expect(hasNextStepsCompleteMarker(body)).toBe(true);
    expect(parseNextSteps(body).stripped).toBe('Done, tests pass.');
    expect(stripNextStepsBlock(body)).toBe('Done, tests pass.');
  });

  it('leaves a fenced example alone', () => {
    const body = `Example:\n\`\`\`\n${NEXT_STEPS_COMPLETE_MARKER}\n\`\`\``;
    expect(hasNextStepsCompleteMarker(body)).toBe(false);
    expect(parseNextSteps(body).stripped).toBe(body);
  });

  it('is stripped alongside a real block', () => {
    const body = `All set.\n${NEXT_STEPS_COMPLETE_MARKER}\n<nextsteps>\n1. Run the tests\n</nextsteps>`;
    const parsed = parseNextSteps(body);
    expect(parsed.texts).toEqual(['Run the tests']);
    expect(parsed.stripped).toBe('All set.');
  });
});

describe('required gate block', () => {
  it('demands a block or the marker when no todos are open', () => {
    const block = buildLiveNextStepsGateBlock({ agentId: 'leader', todos: [] }, 'required');
    expect(block?.text).toContain('Next-steps mode = required');
    expect(block?.text).toContain('MUST end with exactly one of');
    expect(block?.text).toContain(NEXT_STEPS_COMPLETE_MARKER);
    expect(block?.text).not.toContain('<nextsteps> is optional');
  });

  it('still defers to open todos', () => {
    const block = buildLiveNextStepsGateBlock(
      { agentId: 'leader', todos: [{ id: 'a', status: 'pending', content: 'x' }] },
      'required',
    );
    expect(block?.text).toContain('MUST omit <nextsteps> entirely');
  });
});

describe('readNextStepsMode', () => {
  it('prefers the session override, then config, then the default', () => {
    expect(readNextStepsMode(setup({ mode: 'required' }).a)).toBe('required');
    expect(readNextStepsMode(setup({ mode: 'required', metaMode: 'optional' }).a)).toBe('optional');
    expect(readNextStepsMode(setup({ metaMode: 'required' }).a)).toBe('required');
    // Unset or unknown → the default, 'required'; only an explicit 'optional' opts out.
    expect(readNextStepsMode(setup({ metaMode: 'bogus' }).a)).toBe('required');
    expect(readNextStepsMode(setup().a)).toBe('required');
    expect(readNextStepsMode(setup({ mode: 'optional' }).a)).toBe('optional');
    // A bare kernel with no config store never opts into the side request.
    const bare = { container: { safeResolve: () => undefined }, ctx: { meta: {} } } as never;
    expect(readNextStepsMode(bare)).toBe('optional');
  });
});

describe('maybeRequireNextSteps', () => {
  it('asks once and appends the suggested block when the turn ended with neither', async () => {
    const s = setup({
      mode: 'required',
      reply: '<nextsteps>\n1. Add a regression test for the parser auto="true"\n</nextsteps>',
    });
    const out = await maybeRequireNextSteps(s.a, text('Fixed the parser.'), s.req, s.provider);

    expect(s.complete).toHaveBeenCalledTimes(1);
    const sent = s.complete.mock.calls[0]![0];
    // Same prefix + the answer + the instruction: the provider cache covers the rest.
    expect(sent.messages.slice(0, 1)).toEqual(s.req.messages);
    expect(sent.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Fixed the parser.' }],
    });
    expect(JSON.stringify(sent.messages[2])).toContain('[nextsteps_required]');
    expect(NEXT_STEPS_REQUIRED_PROMPT).toContain(NEXT_STEPS_COMPLETE_MARKER);

    const outText = (out.content[0] as { text: string }).text;
    expect(outText.startsWith('Fixed the parser.')).toBe(true);
    const parsed = parseNextSteps(outText);
    expect(parsed.texts).toEqual(['Add a regression test for the parser']);
    expect(parsed.autoTexts).toEqual(['Add a regression test for the parser']);
    expect(s.account).toHaveBeenCalledTimes(1);
  });

  it('ends the run when the side request declares completion', async () => {
    const s = setup({ mode: 'required', reply: NEXT_STEPS_COMPLETE_MARKER });
    const res = text('Everything is done.');
    expect(await maybeRequireNextSteps(s.a, res, s.req, s.provider)).toBe(res);
  });

  it('keeps the turn as written when the side request fails', async () => {
    const s = setup({ mode: 'required', reply: new Error('boom') });
    const res = text('Done.');
    expect(await maybeRequireNextSteps(s.a, res, s.req, s.provider)).toBe(res);
    expect(s.warn).toHaveBeenCalled();
  });

  it.each([
    ['optional mode', { mode: 'optional' as const }, text('Done.')],
    [
      'a written block',
      { mode: 'required' as const },
      text('Done.\n<nextsteps>\n1. Go\n</nextsteps>'),
    ],
    ['the marker', { mode: 'required' as const }, text(`Done.\n${NEXT_STEPS_COMPLETE_MARKER}`)],
    ['a tool call', { mode: 'required' as const }, text('Working', 'tool_use')],
    ['a truncation', { mode: 'required' as const }, text('Partial', 'max_tokens')],
    ['a subagent', { mode: 'required' as const, agentId: 'researcher' }, text('Done.')],
    [
      'open todos',
      {
        mode: 'required' as const,
        todos: [{ id: 'a', status: 'in_progress' as const, content: 'x' }],
      },
      text('Done.'),
    ],
  ])('does nothing for %s', async (_name, opts, res) => {
    const s = setup({ ...opts, reply: '<nextsteps>\n1. Go\n</nextsteps>' });
    expect(await maybeRequireNextSteps(s.a, res, s.req, s.provider)).toBe(res);
    expect(s.complete).not.toHaveBeenCalled();
  });
});
