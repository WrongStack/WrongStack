import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Kanban MCP ownership boundary', () => {
  it('uses the public IPC client surface and never imports storage implementations', () => {
    const source = readFileSync(new URL('../src/adapter.ts', import.meta.url), 'utf8');
    expect(source).toContain("from '@wrongstack/kanban'");
    expect(source).not.toMatch(/sqlite-storage|storage-backend|\/storage\.js|\\storage\.js/);
  });
});
