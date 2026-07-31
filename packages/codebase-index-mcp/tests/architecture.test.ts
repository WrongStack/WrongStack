import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Codebase Index MCP ownership boundary', () => {
  it('uses only the public Codebase Index client surface and never opens storage directly', () => {
    const adapter = readFileSync(new URL('../src/adapter.ts', import.meta.url), 'utf8');
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(adapter).toContain("from '@wrongstack/tools/codebase-index'");
    expect(cli).toContain("from '@wrongstack/tools/codebase-index'");
    expect(`${adapter}\n${cli}`).not.toMatch(
      /node:sqlite|better-sqlite3|IndexStore|writer\.js|project-server-client\.js/,
    );
  });
});
