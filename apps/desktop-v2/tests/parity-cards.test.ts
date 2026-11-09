import { buildPerfRunMessage } from '@wrongstack/project-surfaces/lib/perf-run-message';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SessionActivity } from '../src/SessionActivity';
import { TranscriptMessage } from '../src/TranscriptMessage';

vi.mock('../src/platform', () => ({}));

const render = (text: string, role: 'user' | 'assistant' = 'user') =>
  renderToStaticMarkup(
    createElement(TranscriptMessage, {
      message: { id: 'm', role, text },
      state: { turnActivity: {}, turnStats: {} },
      onLink: () => {},
      onOpenFile: () => {},
    }),
  );
describe('shared parity cards in the desktop conversation', () => {
  it('shows persisted performance metadata and falls back for an invalid marker', () => {
    const text = buildPerfRunMessage('Long private instructions', {
      scope: 'src/a&b',
      mode: 'audit',
      metric: 'wall-ms',
    });
    const html = render(text);
    expect(html).toContain('Performance Audit');
    expect(html).toContain('src/a&amp;b');
    expect(html).toContain('Wall time');
    expect(html).not.toContain('Long private instructions</div>');
    expect(
      render('<!-- wrongstack-perf-run scope="%bad" mode="unknown" metric="" -->\nordinary'),
    ).toContain('ordinary');
  });
  it('shows historical non-council Brain explanations without inventing confidence', () => {
    const html = render('🧠 Denied: out of scope', 'assistant');
    expect(html).toContain('Brain decision');
    expect(html).toContain('data-brain-decision="replayed"');
    expect(html).not.toContain('100%');
  });
  it('uses the shared VCS overview while keeping the exact tool details', () => {
    const html = renderToStaticMarkup(
      createElement(SessionActivity, {
        events: [
          {
            type: 'tool.started',
            payload: { id: 'git-1', name: 'git', input: { action: 'status', branch: 'main' } },
          },
        ],
        onOpenFile: () => {},
      }),
    );
    expect(html).toContain('data-tool-overview="vcs"');
    expect(html).toContain('status');
    expect(html).toContain('main');
  });
  it('shows measured ToolFlow bytes and scripts without calling them token savings', () => {
    const html = renderToStaticMarkup(
      createElement(SessionActivity, {
        events: [
          {
            type: 'tool.started',
            payload: {
              id: 'flow',
              name: 'tool_script',
              input: {
                description: 'Inspect the repository',
                script: 'return await tools.read({path:"a"});',
              },
            },
          },
          {
            type: 'tool.executed',
            payload: {
              id: 'flow',
              name: 'tool_script',
              ok: true,
              output: 'done\n\nToolFlow bytes: 100 -> 20; calls: 2',
            },
          },
        ],
        onOpenFile: () => {},
      }),
    );
    expect(html).toContain('data-tool-overview="toolflow"');
    expect(html).toContain('Inspect the repository');
    expect(html).toContain('100 B tool results');
    expect(html).toContain('20 B script return');
  });
});
