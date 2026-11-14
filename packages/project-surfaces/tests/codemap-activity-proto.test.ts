import { describe, expect, it } from 'vitest';
import { extractActivitiesFromMessage } from '../src/atlas/codemap-activity-extract.js';

describe('extractActivitiesFromMessage prototype-key guard (F289)', () => {
  it('ignores Object.prototype keys when resolving tool activity type', () => {
    const protoRes = extractActivitiesFromMessage({
      type: 'tool.started',
      payload: { name: 'toString', input: { path: 'src/a.ts' } },
    });
    expect(protoRes).toHaveLength(1);
    expect(protoRes[0]?.type).toBe('edit');

    const normalRes = extractActivitiesFromMessage({
      type: 'tool.started',
      payload: { name: 'read_file', input: { path: 'src/b.ts' } },
    });
    expect(normalRes).toHaveLength(1);
    expect(normalRes[0]?.type).toBe('read');
  });
});
