/**
 * An ACP agent's own tool calls reach surfaces as tool cards. Their `name` is
 * the agent's title ("Read D:\app\src\a.ts"), which no surface could show as a
 * read: rows read "Read D:\…\a.ts", Codex output arrived as a JSON envelope
 * and Claude's results kept their Markdown fences and `cat -n` numbers. The
 * shapes below are what the adapters' own renderers send (claude-agent-acp
 * 0.101, codex-acp 2.6).
 */
import { join, resolve } from 'node:path';
import type { ACPCapturedToolCall } from '@wrongstack/acp';
import { EventBus } from '@wrongstack/contracts/kernel';
import { describe, expect, it } from 'vitest';
import { ToolCardRelay } from '../src/acp-leader/acp-leader-stream.js';
import {
  acpToolOutputText,
  acpToolView,
  changedLines,
  shellCommand,
} from '../src/acp-leader/acp-tool-view.js';

const root = resolve('/work/acme-app');
const file = join(root, 'src', 'components', 'Sidebar.tsx');

function call(partial: Partial<ACPCapturedToolCall>): ACPCapturedToolCall {
  return { toolCallId: 't', title: 'tool', status: 'completed', ...partial };
}

describe('acpToolView: Claude (claude-agent-acp)', () => {
  it('reads, edits and writes become read/edit/write with project-relative paths', () => {
    expect(
      acpToolView(
        call({
          title: `Read ${file} (10 - 49)`,
          kind: 'read',
          rawInput: { file_path: file, offset: 10, limit: 40 },
        }),
        root,
      ),
    ).toEqual({
      name: 'read',
      input: { path: 'src/components/Sidebar.tsx', offset: 10, limit: 40 },
    });
    expect(
      acpToolView(
        call({
          title: `Edit ${file}`,
          kind: 'edit',
          rawInput: { file_path: file, old_string: 'a', new_string: 'b\nc' },
        }),
        root,
      ),
    ).toEqual({
      name: 'edit',
      input: { path: 'src/components/Sidebar.tsx', old_string: 'a', new_string: 'b\nc' },
    });
    expect(
      acpToolView(
        call({
          title: `Write ${file}`,
          kind: 'edit',
          rawInput: { file_path: file, content: 'x\n' },
        }),
        root,
      ),
    ).toEqual({ name: 'write', input: { path: 'src/components/Sidebar.tsx', content: 'x\n' } });
  });

  it('a path outside the project stays absolute', () => {
    const outside = resolve('/elsewhere/notes.md');
    expect(
      acpToolView(
        call({ title: `Read ${outside}`, kind: 'read', rawInput: { file_path: outside } }),
        root,
      ),
    ).toEqual({ name: 'read', input: { path: outside } });
  });

  it('commands, searches, fetches and subagents', () => {
    expect(
      acpToolView(
        call({
          title: 'bun run test -- sidebar',
          kind: 'execute',
          rawInput: { command: 'bun run test -- sidebar', description: 'Run sidebar tests' },
        }),
        root,
      ),
    ).toEqual({
      name: 'bash',
      input: { command: 'bun run test -- sidebar', description: 'Run sidebar tests' },
    });
    expect(
      acpToolView(
        call({
          title: `grep -n "useSessions" ${join(root, 'src')}`,
          kind: 'search',
          rawInput: {
            pattern: 'useSessions',
            path: join(root, 'src'),
            output_mode: 'content',
            '-n': true,
          },
        }),
        root,
      ),
    ).toEqual({
      name: 'grep',
      input: { pattern: 'useSessions', path: 'src', output_mode: 'content' },
    });
    expect(
      acpToolView(
        call({
          title: `Find \`${root}\` \`**/*.test.tsx\``,
          kind: 'search',
          rawInput: { pattern: '**/*.test.tsx', path: root },
        }),
        root,
      ),
    ).toEqual({ name: 'glob', input: { pattern: '**/*.test.tsx' } });
    expect(
      acpToolView(
        call({
          title: 'Fetch https://react.dev',
          kind: 'fetch',
          rawInput: { url: 'https://react.dev', prompt: 'refs?' },
        }),
      ),
    ).toEqual({ name: 'web_fetch', input: { url: 'https://react.dev', prompt: 'refs?' } });
    expect(
      acpToolView(
        call({ title: 'Search "react refs"', kind: 'fetch', rawInput: { query: 'react refs' } }),
      ),
    ).toEqual({ name: 'web_search', input: { query: 'react refs' } });
    expect(
      acpToolView(
        call({
          title: 'Explore scrolling',
          kind: 'think',
          rawInput: {
            description: 'Explore scrolling',
            prompt: 'Find it',
            subagent_type: 'Explore',
          },
        }),
      ),
    ).toEqual({
      name: 'delegate',
      input: { task: 'Explore scrolling', agent: 'Explore', prompt: 'Find it' },
    });
  });

  it('an MCP call is shown as its tool, with its server', () => {
    expect(
      acpToolView(
        call({
          title: 'mcp__wrongstack__codebase_search',
          kind: 'other',
          rawInput: { query: 'scroll' },
        }),
      ),
    ).toEqual({ name: 'codebase_search', input: { query: 'scroll' }, server: 'wrongstack' });
  });

  it('an unknown call keeps the agent title (no view)', () => {
    expect(
      acpToolView(call({ title: 'NotebookEdit', kind: 'other', rawInput: { cell_id: '3' } })),
    ).toBeUndefined();
  });
});

describe('acpToolView: Codex (codex-acp)', () => {
  it('a shell command loses its shell wrapper; the project directory is not repeated', () => {
    expect(
      acpToolView(
        call({
          title: 'bun run lint',
          kind: 'execute',
          rawInput: { command: "bash -lc 'bun run lint'", cwd: root },
        }),
        root,
      ),
    ).toEqual({ name: 'bash', input: { command: 'bun run lint' } });
    expect(shellCommand(['pwsh.exe', '-NoProfile', '-Command', 'bun run lint'])).toBe(
      'bun run lint',
    );
    expect(
      shellCommand('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "bun run lint"'),
    ).toBe('bun run lint');
    expect(shellCommand('git status')).toBe('git status');
  });

  it('reads, searches and listings are named by title and location', () => {
    expect(
      acpToolView(
        call({ title: "Read file 'src/a.ts'", kind: 'read', locations: [{ path: 'src/a.ts' }] }),
      ),
    ).toEqual({ name: 'read', input: { path: 'src/a.ts' } });
    expect(acpToolView(call({ title: "Search for 'useSessions' in src", kind: 'search' }))).toEqual(
      {
        name: 'grep',
        input: { pattern: 'useSessions', path: 'src' },
      },
    );
    expect(acpToolView(call({ title: "List files in 'src'", kind: 'read' }))).toEqual({
      name: 'ls',
      input: { path: 'src' },
    });
  });

  it('a file change is an edit of its changed lines, a new file a write, several files a patch', () => {
    const path = join(root, 'src', 'Row.tsx');
    expect(
      acpToolView(
        call({
          title: 'Editing files',
          kind: 'edit',
          diffs: [{ path, oldText: 'a\nb\nc\nd', newText: 'a\nB\nB2\nc\nd' }],
        }),
        root,
      ),
    ).toEqual({
      name: 'edit',
      input: { path: 'src/Row.tsx', old_string: 'b', new_string: 'B\nB2' },
    });
    expect(
      acpToolView(
        call({
          title: 'Editing files',
          kind: 'edit',
          diffs: [{ path, oldText: null, newText: 'x' }],
        }),
        root,
      ),
    ).toEqual({ name: 'write', input: { path: 'src/Row.tsx', content: 'x' } });
    expect(
      acpToolView(
        call({
          title: 'Editing files',
          kind: 'edit',
          diffs: [
            { path, oldText: 'a', newText: 'b' },
            { path: join(root, 'src', 'Other.ts'), oldText: 'c', newText: 'd' },
          ],
        }),
        root,
      ),
    ).toEqual({
      name: 'patch',
      input: { path: 'src/Row.tsx', files: ['src/Row.tsx', 'src/Other.ts'] },
    });
    expect(changedLines('same', 'same')).toEqual({ removed: '', added: '' });
  });
});

describe('acpToolOutputText', () => {
  it("drops the adapter's Markdown fence and Read's cat -n numbers", () => {
    expect(
      acpToolOutputText(call({ output: '```\n     1→import a;\n     2→\n     3→export {};\n```' })),
    ).toBe('import a;\n\nexport {};');
    expect(acpToolOutputText(call({ output: '```console\nFAIL x\n  expected 3\n```' }))).toBe(
      'FAIL x\n  expected 3',
    );
    // Text that only starts with a number is not a numbered listing.
    expect(acpToolOutputText(call({ output: '3 files changed\nok' }))).toBe('3 files changed\nok');
  });

  it("prints a command's structured output, and nothing for a bare exit code", () => {
    expect(
      acpToolOutputText(
        call({
          rawOutput: {
            stdout: '',
            stderr: '',
            aggregated_output: 'Checked 412 files.\n',
            exit_code: 0,
          },
        }),
      ),
    ).toBe('Checked 412 files.\n');
    expect(acpToolOutputText(call({ rawOutput: { exit_code: 0 } }))).toBeUndefined();
    expect(acpToolOutputText(call({ rawOutput: { result: { n: 1 } } }))).toBe(
      '{\n  "result": {\n    "n": 1\n  }\n}',
    );
  });
});

describe('ToolCardRelay', () => {
  it('keeps the agent title as the name and carries the view on both events', () => {
    const events = new EventBus();
    const seen: Array<Record<string, unknown>> = [];
    events.on('tool.started', (e) => seen.push(e as never));
    events.on('tool.executed', (e) => seen.push(e as never));
    const relay = new ToolCardRelay(events, { model: 'claude-code', cwd: root });
    const rawInput = { file_path: file };
    relay.update({
      toolCallId: 'r',
      title: `Read ${file}`,
      kind: 'read',
      status: 'in_progress',
      rawInput,
    });
    relay.update({
      toolCallId: 'r',
      title: `Read ${file}`,
      kind: 'read',
      status: 'completed',
      rawInput,
      output: '```\n     1→ok\n```',
    });
    const view = { name: 'read', input: { path: 'src/components/Sidebar.tsx' } };
    expect(seen[0]).toMatchObject({ name: `Read ${file}`, input: rawInput, view });
    expect(seen[1]).toMatchObject({
      name: `Read ${file}`,
      view,
      output: 'ok',
      outsideConversation: true,
    });
  });
});
