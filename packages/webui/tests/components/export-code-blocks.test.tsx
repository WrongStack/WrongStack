import { cleanup, render } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import { afterEach, expect, it, vi } from 'vitest';
import { downloadChatAsMarkdown } from '../../src/components/CommandPalette/export-utils';
import { useChatStore, useSessionStore } from '../../src/stores';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(['plain output', '```ts\nconst value = 1;\n```\n\n## output heading\n````\n</details>'])(
  'preserves tool output as one code block: %s',
  (output) => {
    let captured = '';
    vi.stubGlobal(
      'Blob',
      class {
        constructor(parts: string[]) {
          captured = parts.join('');
        }
      },
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    useSessionStore.setState({ projectName: 'Export fixture', session: null });
    useChatStore.setState({
      messages: [
        {
          id: 'export-tool',
          role: 'tool',
          content: '',
          timestamp: 0,
          toolName: 'read',
          toolResult: output,
        },
      ],
    });
    downloadChatAsMarkdown();
    const view = render(<ReactMarkdown>{captured}</ReactMarkdown>);
    expect(
      Array.from(view.container.querySelectorAll('pre code')).map((code) => code.textContent),
    ).toEqual([`${output}\n`]);
  },
);
