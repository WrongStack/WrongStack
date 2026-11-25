import { describe, expect, it } from 'vitest';
import {
  buildCanvasGuidedTour,
  type CodeMapGraphResponse,
  sliceCanvasExecutionFlow,
} from '../src/atlas/codemap-model';

const graph = {
  nodes: [
    { id: 'a', label: 'A', kind: 'file', file: 'a.ts', rank: 1 },
    { id: 'b', label: 'B', kind: 'file', file: 'b.ts', rank: 0.8 },
    { id: 'c', label: 'C', kind: 'file', file: 'c.ts', rank: 0.5 },
  ],
  edges: [
    { source: 'a', target: 'b', refType: 'import', weight: 2 },
    { source: 'b', target: 'c', refType: 'import', weight: 1 },
  ],
} as unknown as CodeMapGraphResponse;

describe('codemap-model maxSteps sanitization', () => {
  it('falls back to defaults when maxSteps is NaN or non-finite', () => {
    expect(buildCanvasGuidedTour(graph, Number.NaN)).toHaveLength(3);
    expect(buildCanvasGuidedTour(graph, 0)).toHaveLength(1);
    expect(sliceCanvasExecutionFlow(graph, 'a', Number.NaN)?.nodes).toHaveLength(3);
    expect(sliceCanvasExecutionFlow(graph, 'a', 2)?.nodes).toHaveLength(2);
  });
});
