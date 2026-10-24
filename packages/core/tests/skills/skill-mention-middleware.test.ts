import { isVolatileSystemBlock } from '@wrongstack/contracts/types/blocks';
import type { Request } from '@wrongstack/contracts/types/provider';
import type { SkillLoader } from '@wrongstack/contracts/types/skill';
import { describe, expect, it, vi } from 'vitest';
import { createSkillMentionMiddleware } from '../../src/skills/mention-middleware.js';

const loader = () =>
  ({
    invalidateCache: vi.fn(),
    list: vi.fn(async () => [{ name: 'code-review' }, { name: 'testing' }]),
  }) as unknown as SkillLoader;
async function apply(text: string, skills = loader(), previous?: string) {
  const request: Request = {
    model: 'm',
    messages: [
      ...(previous ? [{ role: 'user' as const, content: previous }] : []),
      { role: 'user', content: text },
    ],
    system: [{ type: 'text', text: 'base' }],
  };
  let output = request;
  await createSkillMentionMiddleware(skills).handler(request, async (next) => {
    output = next;
    return {} as never;
  });
  return output;
}

describe('explicit skill mentions', () => {
  it('does not mistake a dollar amount for a missing skill', async () => {
    expect((await apply('The budget is $100')).system).toHaveLength(1);
  });
  it('adds a volatile instruction for every selected skill without changing user text', async () => {
    const result = await apply('$code-review with $testing');
    expect(result.system?.at(-1)).toMatchObject({
      text: expect.stringContaining('Load each with the skill tool'),
    });
    expect(isVolatileSystemBlock(result.system!.at(-1)!)).toBe(true);
    expect(result.messages[0]?.content).toBe('$code-review with $testing');
  });
  it('does not carry a previous turn selection into a new task', async () => {
    expect((await apply('Hello', loader(), '$code-review')).system).toHaveLength(1);
  });
  it('reports an unavailable skill rather than inventing its instructions', async () => {
    expect((await apply('$missing')).system?.at(-1)).toMatchObject({
      text: expect.stringContaining('unavailable: missing'),
    });
  });
  it('ignores literal code without even querying the skill catalog', async () => {
    const skills = loader();
    expect((await apply('`$testing` and $HOME', skills)).system).toHaveLength(1);
    expect(skills.list).not.toHaveBeenCalled();
  });
});
