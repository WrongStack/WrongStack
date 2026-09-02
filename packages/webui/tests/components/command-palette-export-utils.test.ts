import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadChatAsHtml,
  downloadChatAsMarkdown,
} from '../../src/components/CommandPalette/export-utils';
import { useChatStore, useSessionStore } from '../../src/stores';

/**
 * Both exporters build a string and hand it to the browser download dance.
 * The Blob contents are captured through a stubbed `URL.createObjectURL`, so
 * the assertions can read the produced document rather than just the fact
 * that a click happened.
 */

let captured: string;
let downloadName: string;
let clicked: number;

// Bind the pristine createElement ONCE. Re-reading it inside stubDownload()
// would wrap the previous test's wrapper, and the second wrapper's
// defineProperty would then hit the first one's non-configurable 'click'.
const nativeCreateElement = document.createElement.bind(document);

function stubDownload() {
  captured = '';
  downloadName = '';
  clicked = 0;

  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob) => {
      // jsdom's Blob has no sync text(); read the internal parts instead.
      captured = (blob as unknown as { _parts?: string[] })._parts?.join('') ?? '';
      return 'blob:stub';
    },
    revokeObjectURL: vi.fn(),
  });

  document.createElement = ((tag: string) => {
    const el = nativeCreateElement(tag);
    if (tag === 'a') {
      Object.defineProperty(el, 'click', {
        configurable: true,
        value: () => {
          clicked += 1;
          downloadName = (el as HTMLAnchorElement).download;
        },
      });
    }
    return el;
  }) as typeof document.createElement;
}

/**
 * jsdom's Blob doesn't expose its parts, so stub the constructor to keep the
 * source strings reachable.
 */
class CapturingBlob {
  _parts: string[];
  type: string;
  constructor(parts: string[], options?: { type?: string }) {
    this._parts = parts;
    this.type = options?.type ?? '';
  }
}

function messages(list: Array<Record<string, unknown>>) {
  useChatStore.setState({
    messages: list.map((m, i) => ({ id: `m${i}`, timestamp: 0, ...m })) as never,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal('Blob', CapturingBlob);
  stubDownload();
  useChatStore.setState({ messages: [] });
  useSessionStore.setState({ session: null, projectName: 'WrongStack' } as never);
});

describe('downloadChatAsMarkdown', () => {
  it('titles the export with the session title when there is one', () => {
    useSessionStore.setState({
      session: { id: 's', startedAt: 0, model: 'm', provider: 'p', title: 'Auth work' },
    } as never);
    downloadChatAsMarkdown();

    expect(captured).toContain('# Auth work — chat export');
  });

  it('falls back to the project name', () => {
    downloadChatAsMarkdown();
    expect(captured).toContain('# WrongStack — chat export');
  });

  it('falls back again to a generic name with no project', () => {
    useSessionStore.setState({ projectName: '' } as never);
    downloadChatAsMarkdown();
    expect(captured).toContain('# chat — chat export');
  });

  it('slugifies the project name into the filename', () => {
    useSessionStore.setState({ projectName: 'My Project!' } as never);
    downloadChatAsMarkdown();

    // The trailing `!` slugifies to its own dash, so the separator doubles.
    expect(downloadName).toMatch(/^my-project--chat-.*\.md$/);
    expect(clicked).toBe(1);
  });

  it('renders user and assistant turns under their own headings', () => {
    messages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi back' },
    ]);
    downloadChatAsMarkdown();

    expect(captured).toContain('## 👤 User');
    expect(captured).toContain('hello');
    expect(captured).toContain('## 🤖 Assistant');
    expect(captured).toContain('hi back');
  });

  it('marks a completed tool call with a tick and includes both sides', () => {
    messages([
      {
        role: 'tool',
        content: '',
        toolName: 'Read',
        toolInput: { path: 'a.ts' },
        toolResult: 'ok',
      },
    ]);
    downloadChatAsMarkdown();

    expect(captured).toContain('### 🔧 Tool: `Read` ✅');
    expect(captured).toContain('"path": "a.ts"');
    expect(captured).toContain('<details><summary>Output</summary>');
  });

  it('marks a failed tool call with a cross', () => {
    messages([{ role: 'tool', content: '', toolName: 'Read', isError: true }]);
    downloadChatAsMarkdown();
    expect(captured).toContain('`Read` ❌');
  });

  it('marks a still-running tool call with an hourglass', () => {
    messages([{ role: 'tool', content: '', toolName: 'Read' }]);
    downloadChatAsMarkdown();
    expect(captured).toContain('`Read` ⏳');
  });

  it('names an unattributed tool call', () => {
    messages([{ role: 'tool', content: '' }]);
    downloadChatAsMarkdown();
    expect(captured).toContain('`unknown`');
  });

  it('omits the input block when there is no input', () => {
    messages([{ role: 'tool', content: '', toolName: 'Read', toolResult: 'ok' }]);
    downloadChatAsMarkdown();
    expect(captured).not.toContain('```json');
  });

  it('renders a thinking log with its duration and line count', () => {
    messages([
      {
        role: 'system',
        content: '',
        thinkingLog: { iteration: 2, text: 'a\nb\nc', durationMs: 2_500, startedAt: 0 },
      },
    ]);
    downloadChatAsMarkdown();

    expect(captured).toContain('### 🧠 Thinking process — iteration 2');
    expect(captured).toContain('_2.5s · 3 lines_');
  });

  it('says "replay" for a rehydrated thinking log', () => {
    messages([
      {
        role: 'system',
        content: '',
        thinkingLog: { iteration: 1, text: 'x', durationMs: 0, startedAt: 0, replayed: true },
      },
    ]);
    downloadChatAsMarkdown();

    expect(captured).toContain('_replay · 1 line_');
  });

  it('drops the decimal on a long think', () => {
    messages([
      {
        role: 'system',
        content: '',
        thinkingLog: { iteration: 1, text: 'x', durationMs: 42_000, startedAt: 0 },
      },
    ]);
    downloadChatAsMarkdown();
    expect(captured).toContain('42s');
  });

  it('floors a sub-100ms think at 0.1s rather than showing 0.0s', () => {
    messages([
      {
        role: 'system',
        content: '',
        thinkingLog: { iteration: 1, text: 'x', durationMs: 5, startedAt: 0 },
      },
    ]);
    downloadChatAsMarkdown();
    expect(captured).toContain('0.1s');
  });

  it('widens the fence past any backticks inside the thinking text', () => {
    messages([
      {
        role: 'system',
        content: '',
        thinkingLog: {
          iteration: 1,
          text: 'here is ```a fenced block```',
          durationMs: 1_000,
          startedAt: 0,
        },
      },
    ]);
    downloadChatAsMarkdown();

    // Four backticks, so the inner triple fence can't terminate the block.
    expect(captured).toContain('````text');
  });

  it('skips a role it has no renderer for', () => {
    messages([{ role: 'system', content: 'internal note' }]);
    downloadChatAsMarkdown();
    expect(captured).not.toContain('internal note');
  });
});

describe('downloadChatAsHtml', () => {
  it('produces a self-contained document', () => {
    messages([{ role: 'user', content: 'hello' }]);
    downloadChatAsHtml();

    expect(captured).toContain('<html');
    expect(captured).toContain('<style');
    expect(captured).not.toMatch(/<script\s+src=/);
    expect(downloadName).toMatch(/\.html$/);
  });

  it('escapes html in message content', () => {
    messages([{ role: 'user', content: '<img src=x onerror=alert(1)>' }]);
    downloadChatAsHtml();

    expect(captured).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(captured).not.toContain('<img src=x');
  });

  it('escapes quotes and ampersands too', () => {
    messages([{ role: 'user', content: `a & "b" & 'c'` }]);
    downloadChatAsHtml();

    expect(captured).toContain('&amp;');
    expect(captured).toContain('&quot;');
    expect(captured).toContain('&#39;');
  });

  it('escapes the session title', () => {
    useSessionStore.setState({
      session: { id: 's', startedAt: 0, model: 'm', provider: 'p', title: '<b>bold</b>' },
    } as never);
    downloadChatAsHtml();

    expect(captured).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('renders a user turn and an assistant turn with distinct classes', () => {
    messages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]);
    downloadChatAsHtml();

    expect(captured).toContain('class="bubble user"');
    expect(captured).toContain('class="bubble assistant"');
  });

  it('renders a tool turn with both details blocks', () => {
    messages([
      {
        role: 'tool',
        content: '',
        toolName: 'Read',
        toolInput: { path: 'a.ts' },
        toolResult: 'ok',
      },
    ]);
    downloadChatAsHtml();

    expect(captured).toContain('<summary>Input</summary>');
    expect(captured).toContain('<summary>Output</summary>');
  });

  it('marks a failed tool turn with the error class', () => {
    messages([{ role: 'tool', content: '', toolName: 'Read', isError: true }]);
    downloadChatAsHtml();

    expect(captured).toContain('bubble tool error');
    expect(captured).toContain('❌');
  });

  it('omits the details blocks when there is nothing to show', () => {
    messages([{ role: 'tool', content: '', toolName: 'Read' }]);
    downloadChatAsHtml();

    expect(captured).not.toContain('<summary>Input</summary>');
    expect(captured).not.toContain('<summary>Output</summary>');
  });

  it('names an unattributed tool turn', () => {
    messages([{ role: 'tool', content: '' }]);
    downloadChatAsHtml();
    expect(captured).toContain('<code>tool</code>');
  });

  it('renders a thinking log as an open details block', () => {
    messages([
      {
        role: 'system',
        content: '',
        thinkingLog: { iteration: 3, text: 'a\nb', durationMs: 1_000, startedAt: 0 },
      },
    ]);
    downloadChatAsHtml();

    expect(captured).toContain('bubble thinking');
    expect(captured).toContain('iter 3');
    expect(captured).toContain('2 lines');
    expect(captured).toContain('<details open>');
  });

  it('singularises a one-line thinking log', () => {
    messages([
      {
        role: 'system',
        content: '',
        thinkingLog: { iteration: 1, text: 'a', durationMs: 1_000, startedAt: 0 },
      },
    ]);
    downloadChatAsHtml();
    expect(captured).toContain('1 line<');
  });
});
