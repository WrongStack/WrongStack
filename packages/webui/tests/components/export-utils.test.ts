import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadChatAsHtml,
  downloadChatAsMarkdown,
} from '../../src/components/CommandPalette/export-utils.js';
import { useChatStore, useSessionStore } from '../../src/stores';
import type { ChatMessage } from '../../src/stores';

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

function thinkingMessage(overrides: Partial<ChatMessage['thinkingLog']> = {}): ChatMessage {
  return {
    id: 'think_1',
    role: 'system',
    content: '',
    timestamp: 1_700_000_000_000,
    thinkingLog: {
      iteration: 2,
      text: 'first thought\nsecond thought',
      startedAt: 1_700_000_000_000,
      durationMs: 1_250,
      ...overrides,
    },
  };
}

async function captureDownload(run: () => void): Promise<{ blob: Blob; link: HTMLAnchorElement }> {
  const blobs: Blob[] = [];
  const links: HTMLAnchorElement[] = [];

  URL.createObjectURL = vi.fn((blob: Blob) => {
    blobs.push(blob);
    return 'blob:test-download';
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.spyOn(document.body, 'appendChild').mockImplementation((node: Node) => {
    if (node instanceof HTMLAnchorElement) links.push(node);
    return node;
  });
  vi.spyOn(document.body, 'removeChild').mockImplementation((node: Node) => node);

  run();

  expect(blobs).toHaveLength(1);
  expect(links).toHaveLength(1);
  return { blob: blobs[0]!, link: links[0]! };
}

describe('chat export thinking logs', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [
        { id: 'user_1', role: 'user', content: 'Question?', timestamp: 1_700_000_000_000 },
        thinkingMessage(),
        { id: 'assistant_1', role: 'assistant', content: 'Answer.', timestamp: 1_700_000_001_500 },
      ],
    });
    useSessionStore.setState({
      projectName: 'WrongStack',
      session: {
        id: 'sess_1',
        startedAt: 1_700_000_000_000,
        provider: 'anthropic<provider>',
        model: 'claude"model"',
        title: 'Thinking <Export>',
      },
    });
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    vi.restoreAllMocks();
    useChatStore.getState().clearMessages();
    useSessionStore.setState({ session: null, projectName: '' });
  });

  it('includes archived thinking logs in markdown exports', async () => {
    const { blob, link } = await captureDownload(() => downloadChatAsMarkdown());
    const markdown = await blob.text();

    expect(link.download).toMatch(/wrongstack-chat-/);
    expect(markdown).toContain('### 🧠 Thinking process — iteration 2');
    expect(markdown).toContain('_1.3s · 2 lines_');
    expect(markdown).toContain('first thought\nsecond thought');
    expect(markdown).toContain('## 🤖 Assistant');
  });

  it('includes archived thinking logs in html exports', async () => {
    useChatStore.setState({
      messages: [
        thinkingMessage({
          text: 'replayed <thinking>',
          durationMs: 0,
          replayed: true,
        }),
      ],
    });

    const { blob } = await captureDownload(() => downloadChatAsHtml());
    const html = await blob.text();

    expect(html).toContain('class="bubble thinking"');
    expect(html).toContain('<title>Thinking &lt;Export&gt; — chat export</title>');
    expect(html).toContain('anthropic&lt;provider&gt;/claude&quot;model&quot;');
    expect(html).toContain('iter 2 · replay · 1 line');
    expect(html).toContain('replayed &lt;thinking&gt;');
  });
});
