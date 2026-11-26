import { describe, expect, it } from 'vitest';
import { MemoryInjectorAgent } from '../../src/middleware/memory-injector-agent.js';

const ROCKET = '\u{1F680}';

const agent = new MemoryInjectorAgent();

const plan = (title: string) =>
  agent.plan({
    ctx: { meta: { kanban: { title } }, todos: [], lastRequestTokens: 0 } as never,
    trigger: 'tool_result',
    toolQuery: 'result of the tool',
    baseMaxHints: 3,
    baseMaxChars: 1_200,
    taskAware: true,
  });

/**
 * F2659: task-aware planning splices Kanban card text into the memory-search
 * query, cut at 400 UTF-16 units with a plain `slice`. A card whose astral
 * character straddles the cut puts a lone surrogate into the query.
 */
describe('memory injector query keeps valid UTF-16 (F2659)', () => {
  it('drops the orphaned half in a long Kanban title', () => {
    const { queryText } = plan(`${'k'.repeat(399)}${ROCKET}tail`);

    expect(queryText.isWellFormed()).toBe(true);
  });

  it('keeps a short title unchanged (control)', () => {
    const { queryText } = plan('plain kanban title');

    expect(queryText).toContain('plain kanban');
  });
});
