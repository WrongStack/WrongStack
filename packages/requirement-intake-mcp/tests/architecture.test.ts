import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Requirement Intake MCP ownership boundary', () => {
  it('uses the public package surface and never imports store internals', () => {
    const source = readFileSync(new URL('../src/adapter.ts', import.meta.url), 'utf8');
    expect(source).toContain("from '@wrongstack/requirement-intake'");
    expect(source).toContain("from '@wrongstack/mcp'");
    expect(source).not.toMatch(/\.\.\/store|_index\.json|idempotency\.json/);
  });
});
