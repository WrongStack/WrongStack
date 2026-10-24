/**
 * On breakpoint wires the `[live_context]` tail (plan, glossary, continuity,
 * gates, memory evidence) rides the trailing user message, and request
 * middleware runs after it is attached. That text is steering context the host
 * wrote, not something the user said: skill routing must not be keyed off it.
 */

import type { Config } from '@wrongstack/contracts/types/config/root';
import { authoredText } from '@wrongstack/contracts/types/live-context';
import type { Message } from '@wrongstack/contracts/types/messages';
import type { Request } from '@wrongstack/contracts/types/provider';
import type { SkillLoader, SkillManifest } from '@wrongstack/contracts/types/skill';
import { describe, expect, it, vi } from 'vitest';
import { createSkillMentionMiddleware } from '../../src/skills/mention-middleware.js';
import { createLocalSkillSuggestionSetup } from '../../src/skills/suggest/local.js';
import { LOCAL_SKILL_RULES } from '../../src/skills/suggest/local-rules.js';

const catalog: SkillManifest[] = LOCAL_SKILL_RULES.map((rule) => ({
  name: rule.name,
  source: 'bundled',
  description: rule.name,
  path: `/bundle/${rule.name}/SKILL.md`,
  version: '1.0.0',
}));

const PLAN_TAIL = [
  { type: 'text' as const, text: '[live_context]' },
  { type: 'text' as const, text: '[plan]\n1. Build the Next.js route for /api/orders\n[/plan]' },
];

async function suggestionFor(messages: Message[]): Promise<string | undefined> {
  const loader = { list: async () => catalog } as unknown as SkillLoader;
  const config = { features: { skills: true } } as Config;
  const setup = createLocalSkillSuggestionSetup({
    config,
    skillLoader: loader,
    getAvailableToolNames: () => ['skill'],
  });
  let seen: Request | undefined;
  await setup!.handler({ model: 'm', messages, system: [] }, async (request) => {
    seen = request;
    return {} as never;
  });
  return seen?.system?.find((block) => block.text.startsWith('<local_skill_recommendation>'))?.text;
}

describe('live-context tail is not user text', () => {
  it('local suggestion ignores task words that only appear in the live tail', async () => {
    const advice = await suggestionFor([
      { role: 'user', content: [{ type: 'text', text: 'thanks, that is all' }, ...PLAN_TAIL] },
    ]);
    expect(advice).toBeUndefined();
  });

  it('local suggestion keeps the turn request through a tool loop on a breakpoint wire', async () => {
    const advice = await suggestionFor([
      { role: 'user', content: 'Build a Next.js route for orders' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
          { type: 'text', text: '[live_context]' },
          { type: 'text', text: '[nextsteps_gate]\nopen todos = 0.\n[/nextsteps_gate]' },
        ],
      },
    ]);
    expect(advice).toContain('nextjs-modern');
  });

  it('ignores the tool-coach note the host folded into the user message', async () => {
    // Live repro (2026-10-11): "Read notes.txt, append a line…" got a
    // wrongstack-kanban recommendation because the coach note listed the
    // kanban tool ("Manage project Kanban boards…") inside the user message.
    const coach = [
      '[TOOL COACH — advisory guidance based on the tools enabled in this session]',
      'Tools that may help with this task:',
      '- kanban: "Manage project Kanban boards, cards, assignments, and acceptance evidence."',
      ']',
    ].join('\n');
    const advice = await suggestionFor([
      {
        role: 'user',
        content: [
          { type: 'text', text: "Read notes.txt, append a line 'second line', then read it." },
          { type: 'text', text: coach },
        ],
        origin: 'user_input',
        authoredLength: 1,
      },
    ]);
    expect(advice).toBeUndefined();
  });

  it('host notes folded beside tool results are not the request', () => {
    expect(
      authoredText({
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
          { type: 'text', text: '[TOOL COACH — edit failed]\nRe-read before editing.' },
        ],
      }),
    ).toBe('');
    expect(authoredText({ content: 'plain request' })).toBe('plain request');
    expect(
      authoredText({
        content: [
          { type: 'text', text: 'the ask' },
          { type: 'text', text: '[TOOL COACH — …]' },
          { type: 'text', text: '[live_context]' },
        ],
        authoredLength: 1,
      }),
    ).toBe('the ask');
  });

  it('skill mentions quoted in the live tail are not a fresh selection', async () => {
    const loader = {
      invalidateCache: vi.fn(),
      list: vi.fn(async () => [{ name: 'code-review' }]),
    } as unknown as SkillLoader;
    const request: Request = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what changed?' },
            { type: 'text', text: '[live_context]' },
            { type: 'text', text: '[conversation_continuity]\n- run $code-review on it' },
          ],
        },
      ],
      system: [],
    };
    let seen: Request = request;
    await createSkillMentionMiddleware(loader).handler(request, async (next) => {
      seen = next;
      return {} as never;
    });
    expect(seen.system).toHaveLength(0);
  });
});
