import type { SubagentRunContext, TaskSpec } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { wrongstackBridgeSetup, wstackToolsCommand } from '../src/fleet/acp-wrongstack-bridge.js';

const ROOT = '/work/project';
const task: TaskSpec = { id: 't-1', description: 'rename the parser' };

function ctx(subagentId: string): SubagentRunContext {
  return {
    subagentId,
    config: { id: subagentId, name: subagentId },
    sessionId: 'sess-1',
  } as unknown as SubagentRunContext;
}

function noteOf(setup: { meta?: unknown }): string {
  return (setup.meta as { systemPrompt: { append: string } }).systemPrompt.append;
}

const cli = { indexSurface: 'cli' as const };

describe('acp.bridge.indexSurface = cli', () => {
  it('attaches no index MCP server and keeps the other servers', () => {
    const setup = wrongstackBridgeSetup('claude-code', ROOT, cli)!(task, ctx('w1'));
    const names = (setup.mcpServers as { name: string }[]).map((s) => s.name);
    expect(names).toEqual(['wrongstack-sage', 'wrongstack-mailbox', 'wrongstack-kanban']);
  });

  it('teaches the worker the CLI instead of the MCP tool names', () => {
    // Under vitest the entry is not the CLI, so the launcher falls back to `wstack`.
    const setup = wrongstackBridgeSetup('claude-code', ROOT, cli)!(task, ctx('w1'));
    const note = noteOf(setup);
    expect(note).toContain("WrongStack's codebase index is available through its CLI:");
    expect(note).toContain('wstack tools run codebase-context -- --query');
    expect(note).toContain('wstack tools describe <tool>');
    expect(note).not.toContain('mcp__wrongstack-index');
    expect(note).not.toContain('- wrongstack-index:');
    // The remaining services are still introduced as MCP servers.
    expect(note).toContain("WrongStack's project services are available as MCP servers:");
    expect(setup.promptPrefix).toContain('First run wstack tools run codebase-context');
  });

  it('keeps one note for every worker, so the prompt cache holds', () => {
    const a = noteOf(wrongstackBridgeSetup('claude-code', ROOT, cli)!(task, ctx('w1')));
    const b = noteOf(
      wrongstackBridgeSetup('claude-code', ROOT, cli)!(
        { id: 't-2', description: 'other task' },
        ctx('w2'),
      ),
    );
    expect(a).toBe(b);
  });

  it('gives the leader the same CLI surface', () => {
    const leader = wrongstackBridgeSetup('claude-code', ROOT, cli, 'leader')!(task, ctx('lead'));
    expect(noteOf(leader)).toContain('wstack tools run codebase-search -- --query <name>');
    expect(noteOf(leader)).not.toContain('mcp__wrongstack-index');
  });

  it('with only the index configured, attaches no MCP server at all and says so', () => {
    const setup = wrongstackBridgeSetup('claude-code', ROOT, {
      ...cli,
      servers: ['codebase-index'],
    })!(task, ctx('w1'));
    expect(setup.mcpServers).toEqual([]);
    expect(noteOf(setup)).not.toContain('available as MCP servers');
  });

  it('is a no-op without codebase-index in servers, and the default stays MCP', () => {
    const noIndex = wrongstackBridgeSetup('claude-code', ROOT, { ...cli, servers: ['sage'] })!(
      task,
      ctx('w1'),
    );
    expect(noteOf(noIndex)).not.toContain('wstack tools');
    const byDefault = wrongstackBridgeSetup('claude-code', ROOT, undefined)!(task, ctx('w1'));
    expect((byDefault.mcpServers as { name: string }[])[0]?.name).toBe('wrongstack-index');
    expect(noteOf(byDefault)).not.toContain('wstack tools');
  });
});

describe('wstackToolsCommand', () => {
  it('re-runs the current CLI entry, shell-quoted, with forward slashes on Windows', () => {
    const cmd = wstackToolsCommand('C:\\Program Files\\wrongstack\\dist\\index.js', 'win32');
    expect(cmd).toContain('"C:/Program Files/wrongstack/dist/index.js" tools');
    expect(cmd).not.toContain('\\');
  });

  it('leaves plain POSIX words unquoted', () => {
    expect(wstackToolsCommand('/opt/wrongstack/dist/index.js', 'linux')).toMatch(
      /\/opt\/wrongstack\/dist\/index\.js tools$/,
    );
  });
});
