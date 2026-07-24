import type { TaskNode } from '@wrongstack/core/types/task-graph.js';
import { describe, expect, it } from 'vitest';
import { makeLlmSubtaskGenerator, makePlanningDecomposer } from '../src/decompose-task.js';

const task = (): TaskNode => ({
  id: 't1',
  title: 'Build the whole feature',
  description: 'Everything at once',
  type: 'feature',
  priority: 'high',
  status: 'failed',
  createdAt: 0,
  updatedAt: 0,
});

const info = () => ({ task: task(), error: 'boom' });

describe('makeLlmSubtaskGenerator', () => {
  it('parses a ```json fenced array into validated specs', async () => {
    const gen = makeLlmSubtaskGenerator({
      run: async () =>
        'Sure:\n```json\n[{"title":"A","description":"da","type":"bugfix","priority":"high"},{"title":"B","description":"db"}]\n```',
    });
    const out = await gen(info());
    expect(out).toEqual([
      { title: 'A', description: 'da', type: 'bugfix', priority: 'high' },
      { title: 'B', description: 'db', type: undefined, priority: undefined },
    ]);
  });

  it('parses a bare JSON array (no fence)', async () => {
    const gen = makeLlmSubtaskGenerator({
      run: async () =>
        'noise [{"title":"A","description":"da"},{"title":"B","description":"db"}] trailing',
    });
    expect((await gen(info())).map((s) => s.title)).toEqual(['A', 'B']);
  });

  it('drops malformed entries and rejects unknown enums', async () => {
    const gen = makeLlmSubtaskGenerator({
      run: async () =>
        '[{"title":"A","description":"da","type":"nonsense","priority":"urgent"},{"title":"","description":"x"},{"title":"C","description":"dc"}]',
    });
    const out = await gen(info());
    // A kept (bad type/priority cleared), empty-title dropped, C kept → 2 valid.
    expect(out).toEqual([
      { title: 'A', description: 'da', type: undefined, priority: undefined },
      { title: 'C', description: 'dc', type: undefined, priority: undefined },
    ]);
  });

  it('returns [] when fewer than minSubtasks valid items (no self-split)', async () => {
    const gen = makeLlmSubtaskGenerator({
      run: async () => '[{"title":"Only one","description":"d"}]',
    });
    expect(await gen(info())).toEqual([]);
  });

  it('caps at maxSubtasks', async () => {
    const items = Array.from({ length: 9 }, (_, i) => `{"title":"T${i}","description":"d${i}"}`);
    const gen = makeLlmSubtaskGenerator({
      run: async () => `[${items.join(',')}]`,
      maxSubtasks: 3,
    });
    expect((await gen(info())).length).toBe(3);
  });

  it('returns [] on parse failure or runner throw', async () => {
    expect(await makeLlmSubtaskGenerator({ run: async () => 'no json here' })(info())).toEqual([]);
    expect(await makeLlmSubtaskGenerator({ run: async () => '[not, valid, json' })(info())).toEqual(
      [],
    );
    expect(
      await makeLlmSubtaskGenerator({ run: async () => '[not, valid, json]' })(info()),
    ).toEqual([]);
    expect(
      await makeLlmSubtaskGenerator({
        run: async () => {
          throw new Error('llm down');
        },
      })(info()),
    ).toEqual([]);
  });

  it('covers empty errors, invalid fenced JSON, and non-object fields', async () => {
    expect(
      await makeLlmSubtaskGenerator({ run: async () => '```json\n[invalid]\n```' })({
        task: task(),
        error: '',
      }),
    ).toEqual([]);
    const gen = makeLlmSubtaskGenerator({
      run: async () =>
        '[null,"junk",{"title":7,"description":"d"},{"title":"A","description":7},{"title":"B","description":"b"},{"title":"C","description":"c"}]',
    });
    expect((await gen(info())).map((item) => item.title)).toEqual(['B', 'C']);
    expect(
      await makeLlmSubtaskGenerator({
        run: async () => undefined as unknown as string,
      })(info()),
    ).toEqual([]);
  });
});

describe('makePlanningDecomposer', () => {
  const planInfo = () => ({
    title: 'Big planning task',
    description: 'Too much at once',
    reasons: ['estimated 40h exceeds 4h ceiling', 'no success criteria'],
  });

  it('parses specs and passes successCriterion through', async () => {
    const prompts: string[] = [];
    const decompose = makePlanningDecomposer({
      run: async (prompt) => {
        prompts.push(prompt);
        return '[{"title":"A","description":"da","successCriterion":"$ pnpm test a"},{"title":"B","description":"db"}]';
      },
    });
    const out = await decompose(planInfo());
    expect(out.map((s) => s.title)).toEqual(['A', 'B']);
    expect(out[0]?.successCriterion).toBe('$ pnpm test a');
    expect(out[1]?.successCriterion).toBeUndefined();
    // The prompt embeds the atomicity reasons.
    expect(prompts[0]).toContain('estimated 40h exceeds 4h ceiling');
  });

  it('returns [] on junk output or runner throw', async () => {
    expect(await makePlanningDecomposer({ run: async () => 'no json here' })(planInfo())).toEqual(
      [],
    );
    expect(
      await makePlanningDecomposer({
        run: async () => {
          throw new Error('boom');
        },
      })(planInfo()),
    ).toEqual([]);
  });

  it('clamps to maxSubtasks and requires the minimum', async () => {
    const many = JSON.stringify(
      Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, description: `d${i}` })),
    );
    const decompose = makePlanningDecomposer({ run: async () => many, maxSubtasks: 3 });
    expect((await decompose(planInfo())).length).toBe(3);

    const single = '[{"title":"only","description":"one"}]';
    expect(await makePlanningDecomposer({ run: async () => single })(planInfo())).toEqual([]);
  });

  it('renders unspecified reasons and drops blank success criteria', async () => {
    const decompose = makePlanningDecomposer({
      run: async () =>
        '[{"title":"A","description":"a","successCriterion":"   "},{"title":"B","description":"b","successCriterion":7}]',
    });
    const out = await decompose({ title: 'Big', description: 'large', reasons: [] });
    expect(out).toHaveLength(2);
    expect(out.every((item) => item.successCriterion === undefined)).toBe(true);
  });
});
