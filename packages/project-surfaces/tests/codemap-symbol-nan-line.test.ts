import { describe, expect, it } from 'vitest';
import { resolveSymbolForActivity } from '../src/atlas/CodeMapActivityHelpers';
import type { FileActivity } from '../src/atlas/codemap-activity-store';
import type { GraphNodeData } from '../src/atlas/codemap-model';

describe('resolveSymbolForActivity (F2183)', () => {
  it('sanitizes NaN symbol lines so sorting picks the nearest preceding symbol', () => {
    const sym = resolveSymbolForActivity(
      {
        filePath: 'src/a.ts',
        line: 25,
        summary: '',
        type: 'edit',
        timestamp: 1,
      } as unknown as FileActivity,
      [
        {
          id: 's10',
          kind: 'symbol',
          file: 'src/a.ts',
          line: 10,
          label: 'fn10',
        } as unknown as GraphNodeData,
        {
          id: 'snan',
          kind: 'symbol',
          file: 'src/a.ts',
          line: Number.NaN,
          label: 'fnNan',
        } as unknown as GraphNodeData,
        {
          id: 's20',
          kind: 'symbol',
          file: 'src/a.ts',
          line: 20,
          label: 'fn20',
        } as unknown as GraphNodeData,
      ],
    );
    expect(sym?.id).toBe('s20');
  });
});
