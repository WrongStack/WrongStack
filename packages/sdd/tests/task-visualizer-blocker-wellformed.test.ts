import { describe, expect, it } from 'vitest';
import { renderTaskGraph } from '../src/task-visualizer.js';
import type { TaskGraph, TaskNode } from '@wrongstack/contracts/types/task-graph';

const ROCKET = '\u{1F680}';

function node(id: string, title: string): TaskNode {
  return {
    id,
    title,
    description: '',
    type: 'feature',
    priority: 'high',
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
  };
}

function graph(titleA: string): TaskGraph {
  return {
    id: 'g',
    specId: 's',
    title: 't',
    nodes: new Map([
      ['a', node('a', titleA)],
      ['b', node('b', 'Task b')],
    ]),
    edges: [{ id: 'e', from: 'a', to: 'b', type: 'depends_on' }],
    rootNodes: ['a'],
    createdAt: 1,
    updatedAt: 1,
  };
}

/**
 * F2640: the blocked-by label renders `title.slice(0, 12)`. A dependency title
 * whose 12th unit is the high half of an astral character leaves a lone
 * surrogate in the rendered graph (the other title cuts use `truncate`, which
 * walks back).
 */
describe('task visualizer blocker label keeps valid UTF-16 (F2640)', () => {
  it('never ends the label on half of a surrogate pair', () => {
    const out = renderTaskGraph(graph(`${'x'.repeat(11)}${ROCKET}`));

    expect(out.isWellFormed()).toBe(true);
    expect(out).toContain('x'.repeat(11));
  });

  it('keeps an emoji that ends exactly at the label cap', () => {
    const out = renderTaskGraph(graph(`${'x'.repeat(10)}${ROCKET}`));

    expect(out).toContain(`${'x'.repeat(10)}${ROCKET}`);
  });

  it('renders ordinary titles unchanged (control)', () => {
    const out = renderTaskGraph(graph('Task a'));

    expect(out.isWellFormed()).toBe(true);
    expect(out).toContain('Task a');
  });
});
