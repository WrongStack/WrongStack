import { describe, expect, it } from 'vitest';
import { createChronicleContext } from '../src/context.js';

describe('createChronicleContext blank traceId guard (F2248)', () => {
  it('generates a UUID when traceId is blank and trims explicit traceIds', () => {
    const blank = createChronicleContext({}, '   ');
    expect(blank.correlation.traceId.trim().length).toBeGreaterThan(0);
    const explicit = createChronicleContext({}, ' trace-1 ');
    expect(explicit.correlation.traceId).toBe('trace-1');
  });
});
