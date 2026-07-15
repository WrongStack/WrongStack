import { describe, expect, it } from 'vitest';
import { buildLiveNextStepsGateBlock } from '../../src/core/agent-response.js';
import type { TodoItem } from '../../src/core/context.js';

const todo = (
  id: string,
  status: TodoItem['status'],
  content = `todo ${id}`,
): TodoItem => ({ id, status, content });

describe('buildLiveNextStepsGateBlock', () => {
  it('requires nextsteps or an explicit no-further-steps explanation when no todos are open', () => {
    const block = buildLiveNextStepsGateBlock({
      agentId: 'leader',
      todos: [todo('done', 'completed')],
    });

    expect(block?.cache_control).toEqual({ type: 'ephemeral' });
    expect(block?.text).toContain('open todos = 0');
    expect(block?.text).toContain('MUST take exactly one branch');
    expect(block?.text).toContain('include a balanced <nextsteps> block');
    expect(block?.text).toContain('explicitly tell the user');
    expect(block?.text).toContain('Silently omitting both is invalid');
  });

  it('requires omission and exposes the current open todo snapshot', () => {
    const block = buildLiveNextStepsGateBlock({
      agentId: 'leader',
      todos: [
        todo('a', 'pending', 'write focused tests'),
        todo('b', 'completed', 'old work'),
        todo('c', 'in_progress', 'verify the implementation'),
      ],
    });

    expect(block?.text).toContain('open todos = 2');
    expect(block?.text).toContain('MUST omit <nextsteps> entirely');
    expect(block?.text).toContain('- [pending] write focused tests');
    expect(block?.text).toContain('- [in_progress] verify the implementation');
    expect(block?.text).not.toContain('old work');
  });

  it('does not inject the leader contract into subagents', () => {
    expect(buildLiveNextStepsGateBlock({
      agentId: 'researcher',
      todos: [],
    })).toBeUndefined();
  });

  it('switches branches from the mutated live todo state on the next request', () => {
    const context = {
      agentId: 'leader',
      todos: [todo('a', 'in_progress', 'finish current work')],
    };

    expect(buildLiveNextStepsGateBlock(context)?.text).toContain('open todos = 1');
    context.todos[0]!.status = 'completed';
    expect(buildLiveNextStepsGateBlock(context)?.text).toContain('open todos = 0');
  });

  it('bounds and normalizes the todo snapshot without changing the live count', () => {
    const todos = Array.from({ length: 12 }, (_, index) =>
      todo(String(index), 'pending', `todo   ${index}\nwith spacing`),
    );
    const block = buildLiveNextStepsGateBlock({ agentId: 'leader', todos });

    expect(block?.text).toContain('open todos = 12');
    expect(block?.text).toContain('- [pending] todo 0 with spacing');
    expect(block?.text).toContain('…and 2 more open todo(s)');
  });
});
