import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { Entry, type HistoryEntry } from '../src/components/history.js';

function renderEntry(
  entry: HistoryEntry,
  opts: { termWidth?: number; showModelReasoning?: boolean } = {},
): string {
  const { lastFrame, unmount } = render(
    React.createElement(Entry, {
      entry,
      termWidth: opts.termWidth ?? 100,
      ...(opts.showModelReasoning !== undefined
        ? { showModelReasoning: opts.showModelReasoning }
        : {}),
    }),
  );
  const frame = lastFrame() ?? '';
  unmount();
  return frame;
}

describe('<Entry /> — comprehensive coverage', () => {
  describe('user kind', () => {
    it('renders user text', () => {
      const frame = renderEntry({ id: 1, kind: 'user', text: 'hello world' });
      expect(frame).toContain('hello world');
      expect(frame).toContain('USER');
    });

    it('shows queued marker for queued entries', () => {
      const frame = renderEntry({ id: 1, kind: 'user', text: 'test', queued: true });
      expect(frame).toContain('queued');
    });

    it('shows pasteContent when present without text', () => {
      const frame = renderEntry({ id: 1, kind: 'user', text: '', pasteContent: 'pasted content' });
      expect(frame).toContain('pasted content');
    });

    it('shows pasteContent with arrow when text is also present', () => {
      const frame = renderEntry({
        id: 1,
        kind: 'user',
        text: 'typed',
        pasteContent: 'pasted content',
      });
      expect(frame).toContain('typed');
      expect(frame).toContain('pasted content');
      expect(frame).toContain('↳');
    });
  });

  describe('thinking kind', () => {
    it('renders model reasoning when showModelReasoning is true', () => {
      const frame = renderEntry(
        { id: 1, kind: 'thinking', text: 'thinking text' },
        { showModelReasoning: true },
      );
      expect(frame).toContain('Model Reasoning');
      expect(frame).toContain('thinking text');
    });

    it('renders model reasoning by default', () => {
      const frame = renderEntry({ id: 1, kind: 'thinking', text: 'default thinking' });
      expect(frame).toContain('Model Reasoning');
      expect(frame).toContain('default thinking');
    });

    it('renders empty fragment when showModelReasoning is false', () => {
      const { lastFrame, unmount } = render(
        React.createElement(Entry, {
          entry: { id: 1, kind: 'thinking', text: 'hidden thinking' },
          termWidth: 100,
          showModelReasoning: false,
        }),
      );
      const frame = lastFrame() ?? '';
      unmount();
      expect(frame).toBe('');
    });
  });

  describe('assistant kind', () => {
    it('renders assistant text', () => {
      const frame = renderEntry({ id: 1, kind: 'assistant', text: 'I am an AI' });
      expect(frame).toContain('I am an AI');
      expect(frame).toContain('ASSISTANT');
    });

    it('renders next steps with auto flag', () => {
      const frame = renderEntry(
        {
          id: 1,
          kind: 'assistant',
          final: true,
          text: [
            'Done.',
            '',
            '<nextsteps>',
            '1. Check the logs',
            '2. Run tests',
            '</nextsteps>',
          ].join('\n'),
        },
        { termWidth: 100 },
      );
      expect(frame).toContain('NEXT STEPS');
      expect(frame).toContain('Check the logs');
      expect(frame).not.toContain('<nextsteps>');
    });

    it('shows auto marker on auto steps', () => {
      const frame = renderEntry(
        {
          id: 1,
          kind: 'assistant',
          final: true,
          text: [
            'Done.',
            '',
            '<nextsteps>',
            '1. Check the logs (auto)',
            '2. Run tests',
            '</nextsteps>',
          ].join('\n'),
        },
        { termWidth: 100 },
      );
      expect(frame).toContain('auto');
    });
  });

  describe('info kind', () => {
    it('renders info text dimmed when no ANSI', () => {
      const frame = renderEntry({ id: 1, kind: 'info', text: 'information message' });
      expect(frame).toContain('information message');
    });

    it('renders info text directly when ANSI escape codes present', () => {
      const frame = renderEntry({ id: 1, kind: 'info', text: '\x1b[1mbold\x1b[22m message' });
      expect(frame).toContain('bold');
      expect(frame).toContain('message');
    });
  });

  describe('warn kind', () => {
    it('renders warn text', () => {
      const frame = renderEntry({ id: 1, kind: 'warn', text: 'warning message' });
      expect(frame).toContain('⚠');
      expect(frame).toContain('warning message');
    });
  });

  describe('error kind', () => {
    it('renders error text', () => {
      const frame = renderEntry({ id: 1, kind: 'error', text: 'error message' });
      expect(frame).toContain('ERROR');
      expect(frame).toContain('error message');
    });
  });

  describe('turn-summary kind', () => {
    it('renders turn summary with text', () => {
      const frame = renderEntry({ id: 1, kind: 'turn-summary', text: 'summary text' });
      expect(frame).toContain('summary text');
    });
  });

  describe('confirm kind', () => {
    it('renders confirm entry with tool name', () => {
      const frame = renderEntry({
        id: 1,
        kind: 'confirm',
        toolName: 'bash',
        input: { command: 'run command?' },
        suggestedPattern: 'bash:*',
      });
      expect(frame).toContain('Confirm');
      expect(frame).toContain('bash');
      expect(frame).toContain('y / n / a / d');
    });
  });

  describe('subagent kind', () => {
    it('renders subagent entry with icon and label', () => {
      const frame = renderEntry({
        id: 1,
        kind: 'subagent',
        icon: '⚡',
        agentLabel: 'agent_12',
        agentColor: 'magenta',
        text: 'spawned as bug-hunter',
      });
      expect(frame).toContain('agent_12');
      expect(frame).toContain('bug-hunter');
    });

    it('renders subagent detail when present', () => {
      const frame = renderEntry({
        id: 1,
        kind: 'subagent',
        icon: '⚡',
        agentLabel: 'agent_12',
        agentColor: 'magenta',
        text: 'first line',
        detail: 'detail line',
      });
      expect(frame).toContain('detail line');
    });

    it('renders multi-line subagent text', () => {
      const frame = renderEntry({
        id: 1,
        kind: 'subagent',
        icon: '⚡',
        agentLabel: 'agent_12',
        agentColor: 'magenta',
        text: 'first line\nsecond line\nthird line',
      });
      expect(frame).toContain('first line');
      expect(frame).toContain('second line');
      expect(frame).toContain('third line');
    });
  });

  describe('brain kind — all statuses', () => {
    const statuses = [
      { status: 'thinking' as const, icon: '…', color: 'magenta' },
      { status: 'answered' as const, icon: '⚖', color: 'cyan' },
      { status: 'ask_human' as const, icon: '?', color: 'yellow' },
      { status: 'denied' as const, icon: '×', color: 'red' },
    ];

    for (const { status, icon } of statuses) {
      it(`renders brain status ${status} with icon ${icon}`, () => {
        const frame = renderEntry({
          id: 1,
          kind: 'brain',
          status,
          risk: 'low',
          question: 'test question',
          source: 'brain',
        });
        expect(frame).toContain('BRAIN');
        expect(frame).toContain('test question');
        // Status value isn't rendered as literal text but the icon is
        expect(frame).toContain(icon);
      });
    }
  });

  describe('brain kind — all risks', () => {
    const risks = [
      { risk: 'low' as const, color: 'green' },
      { risk: 'medium' as const, color: 'cyan' },
      { risk: 'high' as const, color: 'yellow' },
      { risk: 'critical' as const, color: 'red' },
    ];

    for (const { risk } of risks) {
      it(`renders brain risk ${risk}`, () => {
        const frame = renderEntry({
          id: 1,
          kind: 'brain',
          status: 'thinking',
          risk,
          question: 'test',
          source: 'brain',
        });
        expect(frame).toContain(risk);
        expect(frame).toContain('BRAIN');
      });
    }
  });

  describe('brain kind — with decision and rationale', () => {
    it('renders decision when present', () => {
      const frame = renderEntry({
        id: 1,
        kind: 'brain',
        status: 'answered',
        risk: 'low',
        question: 'test question',
        source: 'brain',
        decision: 'proceed',
      });
      expect(frame).toContain('Decision');
      expect(frame).toContain('proceed');
    });

    it('renders rationale when present', () => {
      const frame = renderEntry({
        id: 1,
        kind: 'brain',
        status: 'answered',
        risk: 'low',
        question: 'test question',
        source: 'brain',
        rationale: 'because it is safe',
      });
      expect(frame).toContain('because it is safe');
    });
  });

  describe('banner kind', () => {
    it('renders banner entry through Banner component', () => {
      const frame = renderEntry({
        id: 0,
        kind: 'banner',
        version: '1.0.0',
        provider: 'test',
        model: 'test-model',
        cwd: '/workspace',
      });
      expect(frame).toContain('v1.0.0');
      expect(frame).toContain('test › test-model');
    });
  });

  describe('tool kind — error (not ok)', () => {
    it('renders error tool entry', () => {
      const frame = renderEntry({
        id: 1,
        kind: 'tool',
        name: 'bash',
        durationMs: 100,
        ok: false,
        output: 'bash failed',
      });
      expect(frame).toContain('bash');
      expect(frame).toContain('×');
    });
  });

  describe('tool kind — with outputLines and outputBytes', () => {
    it('renders size chip when outputLines > 0 and outputBytes > 0', () => {
      const frame = renderEntry({
        id: 1,
        kind: 'tool',
        name: 'read',
        durationMs: 10,
        ok: true,
        input: { path: 'test.txt' },
        output: 'content',
        outputLines: 5,
        outputBytes: 100,
      });
      expect(frame).toContain('5 L');
      expect(frame).toContain('100B');
    });
  });

  describe('tool kind — visual lines output', () => {
    it('renders visual lines when present', () => {
      const frame = renderEntry({
        id: 1,
        kind: 'tool',
        name: 'grep',
        durationMs: 10,
        ok: true,
        input: { pattern: 'foo' },
        output: JSON.stringify({ count: 1, matches: [{ file: 'a.ts', line: 1, text: 'foo' }] }),
      });
      expect(frame).toContain('a.ts');
    });

    it('keeps a generic tool result outside its injected-memory panel', () => {
      const frame = renderEntry({
        id: 1,
        kind: 'tool',
        name: 'extension_tool',
        durationMs: 10,
        ok: true,
        output: [
          'actual tool result',
          '',
          '--- SAGE: task-aware project knowledge (Memory Injector) ---',
          '- [fact] <memory id="mem-1">remembered fact</memory>',
        ].join('\n'),
      });
      expect(frame).toContain('actual tool result');
      expect(frame).toContain('SAGE MEMORY INJECTED · extension_tool');
      expect(frame).toContain('remembered fact');
      expect(frame).not.toContain('--- SAGE:');
    });
  });

  describe('tool kind — resultRenderMode simple', () => {
    it('preserves a new-file write label when SAGE output is appended', () => {
      const output = `${JSON.stringify({
        created: true,
        path: 'new.ts',
        diff: '--- /dev/null\n+++ new.ts\n@@ -0,0 +1 @@\n+export {};',
      })}\n\n--- SAGE: related project knowledge (Memory Injector) ---\n- [fact] <memory id="mem-1">remembered fact</memory>`;
      const frame = renderEntry({
        id: 1,
        kind: 'tool',
        name: 'write',
        durationMs: 12,
        ok: true,
        resultRenderMode: 'simple',
        input: { path: 'new.ts', content: 'export {};' },
        output,
      });
      expect(frame).toContain('Write(new.ts)');
      expect(frame).toContain('Added 1 line');
      expect(frame).not.toContain('removed');
      expect(frame).toContain('SAGE MEMORY INJECTED · write');
      expect(frame).toContain('remembered fact');
      expect(frame).not.toContain('--- SAGE:');
      expect(frame).not.toContain('Update(new.ts)');
    });

    it('hides diff body in simple mode for edit', () => {
      const frame = renderEntry({
        id: 1,
        kind: 'tool',
        name: 'edit',
        durationMs: 12,
        ok: true,
        resultRenderMode: 'simple',
        input: { path: 'a.ts', old_string: 'a', new_string: 'b' },
        output: JSON.stringify({
          path: 'a.ts',
          replacements: 1,
          diff: '--- a.ts\n+++ b.ts\n@@ -1 +1 @@\n-a\n+b',
        }),
      });
      expect(frame).toContain('Update(a.ts)');
      expect(frame).not.toMatch(/[+-] a/);
    });
  });

  describe('tool kind — replace with multi-file diffs', () => {
    it('renders multi-file diff for replace tool', () => {
      const frame = renderEntry({
        id: 1,
        kind: 'tool',
        name: 'replace',
        durationMs: 50,
        ok: true,
        input: { path: 'src/' },
        output: JSON.stringify({
          results: [
            { path: 'src/a.ts', diff: '--- a.ts\n+++ b.ts\n@@ -1 +1 @@\n-old_a\n+new_a' },
            { path: 'src/b.ts', diff: '--- b.ts\n+++ b.ts\n@@ -1 +1 @@\n-old_b\n+new_b' },
          ],
        }),
      });
      // With 2 files, the summary shows "2 files" and the individual paths appear in the diff
      expect(frame).toContain('Update(src/)');
      expect(frame).toContain('new_a');
      expect(frame).toContain('new_b');
    });
  });

  describe('tool kind — patch tool with mutation output', () => {
    it('renders patch entry correctly', () => {
      const frame = renderEntry({
        id: 1,
        kind: 'tool',
        name: 'patch',
        durationMs: 30,
        ok: true,
        input: {},
        output: JSON.stringify({
          diff: '--- a.ts\n+++ b.ts\n@@ -1 +1 @@\n-old\n+new',
        }),
      });
      expect(frame).toContain('Update(changes)');
      expect(frame).toContain('Added 1 line, removed 1 line');
    });
  });
});
