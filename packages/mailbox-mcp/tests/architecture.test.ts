import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Mailbox MCP ownership boundary', () => {
  it('uses RemoteMailbox and never imports SQLite or legacy storage', () => {
    const adapter = readFileSync(new URL('../src/adapter.ts', import.meta.url), 'utf8');
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(adapter).toContain('RemoteMailbox');
    expect(cli).toContain('createProjectMailbox');
    expect(`${adapter}\n${cli}`).not.toMatch(/sqlite-mailbox|global-mailbox|_mailbox\.sqlite/);
  });
});
