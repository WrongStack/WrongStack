import { describe, expect, it } from 'vitest';
import {
  chronicleGraph,
  chronicleQuery,
  evidenceText,
  initialChronicleFilters,
} from '../src/chronicle-model';

describe('Chronicle project evidence', () => {
  it('builds bounded canonical UTC filters and refuses reversed ranges', () => {
    const filters = {
      ...initialChronicleFilters(),
      text: '  boundary ',
      eventType: 'file.changed',
      outcome: 'success',
      from: '2026-10-26T09:00',
      to: '2026-10-26T10:00',
    };
    expect(chronicleQuery(filters)).toEqual({
      text: 'boundary',
      eventTypes: ['file.changed'],
      outcomes: ['success'],
      from: '2026-10-26T09:00:00.000Z',
      to: '2026-10-26T10:00:00.000Z',
      order: 'desc',
      limit: 100,
    });
    expect(() => chronicleQuery({ ...filters, to: '2026-10-25T10:00' })).toThrow('end time');
    expect(() =>
      chronicleQuery(
        { ...filters, to: '2026-10-25T10:00' },
        { invalidDate: 'bad date', endBeforeStart: 'end first' },
      ),
    ).toThrow('end first');
  });
  it('shows only stored graph relationships and preserves their confidence', () => {
    const graph = chronicleGraph({
      nodes: [
        { eventId: 'a', eventType: 'tool.started', attributes: { summary: 'Inspect file' } },
        { eventId: 'b', eventType: 'file.read', scope: { agentId: 'reviewer' } },
      ],
      edges: [
        { from: 'a', to: 'b', kind: 'parent_span', confidence: 'explicit' },
        { from: 'a', to: 'absent', kind: 'trace', confidence: 'inferred' },
      ],
    });
    expect(graph.nodes.map((node) => node.label)).toEqual(['Inspect file', 'file · read']);
    expect(graph.edges).toEqual([
      { source: 'a', target: 'b', label: 'parent span · explicit', weight: 1 },
    ]);
    expect(evidenceText({ reason: 'Revision changed', lines: [2, 3] })).toBe(
      'reason: Revision changed\nlines: 2\n3',
    );
  });
});
