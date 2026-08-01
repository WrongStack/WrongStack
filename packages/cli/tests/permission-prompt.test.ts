import type { InputReader, Tool } from '@wrongstack/core/types';
import { stripAnsi } from '@wrongstack/core/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makePromptDelegate } from '../src/permission-prompt.js';

const fakeTool: Tool = {
  name: 'edit',
  description: '',
  inputSchema: { type: 'object' },
  permission: 'confirm',
  mutating: true,
  async execute() {
    return '';
  },
};

const origWrite = process.stdout.write.bind(process.stdout);
let buf = '';
function captureStdout(): void {
  buf = '';
  process.stdout.write = ((chunk: unknown) => {
    buf += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  }) as typeof process.stdout.write;
}
function getStdout(): string {
  return stripAnsi(buf);
}

afterEach(() => {
  process.stdout.write = origWrite;
});

describe('makePromptDelegate', () => {
  it("returns the reader's answer", async () => {
    captureStdout();
    const reader: InputReader = {
      readLine: vi.fn(async () => ''),
      readKey: vi.fn(async () => 'yes'),
      close: vi.fn(async () => undefined),
    };
    const prompt = makePromptDelegate(reader);
    const decision = await prompt(fakeTool, { path: '/a' }, 'edit:/a');
    expect(decision).toBe('yes');
    expect(reader.readKey).toHaveBeenCalled();
    const out = getStdout();
    expect(out).toContain('edit');
    expect(out).toContain('path');
  });

  it('renders diff when present for edit tool', async () => {
    captureStdout();
    const reader: InputReader = {
      readLine: vi.fn(async () => ''),
      readKey: vi.fn(async () => 'no'),
      close: vi.fn(async () => undefined),
    };
    const prompt = makePromptDelegate(reader);
    await prompt(fakeTool, { path: '/a', diff: '--- a\n+++ a\n@@\n-x\n+y\n' }, 'edit:/a');
    expect(getStdout()).toContain('-x');
    expect(getStdout()).toContain('+y');
  });

  // WS-046: the prompt must not offer a choice the policy cannot honour.
  // `exec` carries no permission subject (no subjectKey, no path/url/name), so
  // an "always" rule would be written keyed on the tool name and never match.
  // Offering it anyway is what taught users that trust rules are broken and
  // pushed them toward a blanket `{"exec":{"auto":true}}`.
  describe('always-allow availability (WS-046)', () => {
    const execTool: Tool = { ...fakeTool, name: 'exec' };

    function reader(answer: string): InputReader & { readKey: ReturnType<typeof vi.fn> } {
      return {
        readLine: vi.fn(async () => ''),
        readKey: vi.fn(async () => answer),
        close: vi.fn(async () => undefined),
      } as InputReader & { readKey: ReturnType<typeof vi.fn> };
    }

    // The option line goes to `reader.readKey` as its prompt argument, NOT to
    // stdout — the reader renders it. Asserting on stdout here would pass
    // whatever the code did.
    const promptText = (r: { readKey: ReturnType<typeof vi.fn> }): string =>
      stripAnsi(String(r.readKey.mock.calls[0]?.[0] ?? ''));
    const offeredValues = (r: { readKey: ReturnType<typeof vi.fn> }): string[] =>
      ((r.readKey.mock.calls[0]?.[1] ?? []) as Array<{ value: string }>).map((o) => o.value);

    it('withholds the [a] option and explains why for a subject-less tool', async () => {
      captureStdout();
      const r = reader('yes');
      await makePromptDelegate(r)(execTool, { command: 'ls', cwd: '.' }, 'exec');

      // The explanation IS written to stdout by the delegate.
      expect(getStdout()).toContain('no "always" for this call');
      expect(promptText(r)).not.toContain('lways allow');
      expect(offeredValues(r)).toEqual(['yes', 'no', 'deny']);
    });

    it('still offers it when the call has a subject', async () => {
      captureStdout();
      const r = reader('yes');
      await makePromptDelegate(r)(fakeTool, { path: '/a' }, 'edit:/a');

      expect(getStdout()).not.toContain('no "always" for this call');
      expect(promptText(r)).toContain('lways allow (edit:/a)');
      expect(offeredValues(r)).toEqual(['yes', 'no', 'always', 'deny']);
    });
  });

  it('omits long content and new_string from summary', async () => {
    captureStdout();
    const reader: InputReader = {
      readLine: vi.fn(async () => ''),
      readKey: vi.fn(async () => 'no'),
      close: vi.fn(async () => undefined),
    };
    const prompt = makePromptDelegate(reader);
    await prompt(
      fakeTool,
      { path: '/a', content: 'x'.repeat(500), new_string: 'y'.repeat(500) },
      'edit:/a',
    );
    expect(getStdout()).not.toContain('xxxxxx');
    expect(getStdout()).not.toContain('yyyyyy');
  });
});
