import { describe, expect, it } from 'vitest';
import { errorFromThrown } from '../src/server/project-server-validation.js';

describe('errorFromThrown null-prototype guard (F2232)', () => {
  it('formats null-prototype thrown objects without throwing TypeError', () => {
    const res = errorFromThrown(Object.create(null));
    expect(res.code).toBe('INTERNAL_ERROR');
    expect(res.message.length).toBeGreaterThan(0);
  });
});
