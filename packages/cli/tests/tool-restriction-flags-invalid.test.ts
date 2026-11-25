import { describe, expect, it } from 'vitest';
import { resolveToolRestriction } from '../src/boot/tool-restriction-flags.js';

describe('resolveToolRestriction invalid flag values', () => {
  it('rejects boolean false and comma-only strings instead of silently misconfiguring tools', () => {
    expect(() => resolveToolRestriction({ 'only-tools': ' , , ' })).toThrow();
    expect(() => resolveToolRestriction({ 'only-tools': false })).toThrow();
    expect(resolveToolRestriction({ 'only-tools': 'read,edit' })?.only).toEqual(['read', 'edit']);
  });
});
