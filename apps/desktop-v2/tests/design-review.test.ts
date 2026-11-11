import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { buildDesktopDesignReviewPrompt } from '../src/design-dna-prompt';
import type { EngineEvent } from '../src/engine-state';
import { SessionActivity } from '../src/SessionActivity';

const inspectInput = { action: 'inspect', file: 'dist/index.html', surface: 'app' };
const inspectPath = '.design/inspect/dist-index/inspect.md';
const compareInput = { action: 'compare', reference: 'catalog', file: 'dist/index.html' };
const comparePath = '.design/references/catalog/fidelity.md';
const started: EngineEvent = {
  type: 'tool.started',
  payload: { id: 'review', name: 'design_reference', input: inspectInput },
};
function executed(input: unknown, output: unknown, ok = true): EngineEvent {
  return {
    type: 'tool.executed',
    at: Date.parse('2026-11-11T04:05:00Z'),
    payload: {
      id: 'review',
      name: 'design_reference',
      input,
      ok,
      output: typeof output === 'string' ? output : JSON.stringify(output),
    },
  };
}
const render = (events: EngineEvent[], projectRoot?: string) =>
  renderToStaticMarkup(
    createElement(SessionActivity, { events, projectRoot, onOpenFile: vi.fn() }),
  );

function writeReport(path: string): EngineEvent {
  return {
    type: 'tool.progress',
    payload: { id: 'review', name: 'design_reference', event: { path, operation: 'write' } },
  };
}

describe('rendered design evidence in activity', () => {
  it('shows findings from a successful inspection without treating tool success as a clean result', () => {
    const html = render([
      executed(inspectInput, {
        action: 'inspect',
        path: inspectPath,
        fails: 2,
        warns: 1,
        output:
          '# Inspect — http://127.0.0.1:1234/dist/index.html\nSurface: app · viewports 1024, 375px · 2 FAIL · 1 WARN',
      }),
    ]);
    expect(html).toContain('aria-label="Rendered design inspection"');
    expect(html).toContain('2 FAIL · 1 WARN');
    expect(html).toContain('1024, 375 px');
    expect(html).toContain('dist/index.html');
    expect(html).toContain('dateTime="2026-11-11T04:05:00.000Z"');
    expect(html).toContain('Open report');
  });

  it('shows zero findings and a zero fidelity score as measured values', () => {
    expect(
      render([
        executed(inspectInput, { action: 'inspect', path: inspectPath, fails: 0, warns: 0 }),
      ]),
    ).toContain('0 FAIL · 0 WARN');
    const html = render([
      executed(compareInput, {
        action: 'compare',
        path: comparePath,
        score: 0,
        output:
          '# Fidelity — dist/index.html vs catalog\nOverall 0% (lowest axis: color) · color 0%\nViewports compared: 375',
      }),
    ]);
    expect(html).toContain('aria-label="Design fidelity comparison"');
    expect(html).toContain('Fidelity 0%');
    expect(html).toContain('Open report');
  });

  it('reads a legacy plain-text report and opens its reported path', () => {
    const html = render([
      executed(
        inspectInput,
        '# Inspect — /index.html\nSurface: app · viewports 375px · 0 FAIL · 3 WARN\n\nSaved: .design/inspect/dist-index/inspect.{md,json} · screenshots .design/inspect/dist-index/375.png',
      ),
    ]);
    expect(html).toContain('0 FAIL · 3 WARN');
    expect(html).toContain('Open report');
  });

  it('keeps a confirmed report action when a journal preview clips the metrics', () => {
    const html = render([
      started,
      {
        type: 'tool.progress',
        payload: {
          id: 'review',
          name: 'design_reference',
          event: { path: inspectPath, operation: 'write' },
        },
      },
      executed(inspectInput, '{"output":"truncated'),
    ]);
    expect(html).toContain('Review metrics are unavailable');
    expect(html).toContain('Open report');
    expect(html).not.toContain('0 FAIL · 0 WARN');
  });

  it('uses the engine preview and the canonical project-absolute write target', () => {
    const preview =
      'design_reference\noutput:\n# Fidelity — dist/index.html vs catalog\nOverall 60% (lowest axis: color) · color 60%\nViewports compared: 1024, 375\n\n…';
    const report = 'd:\\project\\.design\\references\\catalog\\fidelity.md';
    const html = render([writeReport(report), executed(compareInput, preview)], 'D:/Project');
    expect(html).toContain('Fidelity 60%');
    expect(html).toContain('1024, 375 px');
    expect(html).toContain('Open report');
    expect(
      render([writeReport(report), executed(compareInput, preview)], 'D:/Another'),
    ).not.toContain('Open report');
  });

  it('withholds completed metrics and file actions when the tool fails', () => {
    const html = render([
      executed(inspectInput, { action: 'inspect', path: inspectPath, fails: 0, warns: 0 }, false),
    ]);
    expect(html).toContain('aria-label="Rendered design inspection"');
    expect(html).not.toContain('Open report');
    expect(html).not.toContain('0 FAIL · 0 WARN');
  });

  it.each(['../../inspect.md', 'https://example.com/inspect.md', comparePath])(
    'does not offer %s as an inspection report',
    (path) => {
      expect(
        render([executed(inspectInput, { action: 'inspect', path, fails: 1, warns: 0 })]),
      ).not.toContain('Open report');
    },
  );

  it('prepares review requests for the original URL or file and the selected reference', () => {
    expect(
      buildDesktopDesignReviewPrompt({
        action: 'inspect',
        target: 'https://example.com/index.html',
        surface: 'app',
      }),
    ).toContain('"action":"inspect","url":"https://example.com/index.html","surface":"app"');
    expect(
      buildDesktopDesignReviewPrompt({
        action: 'compare',
        target: 'dist/index.html',
        reference: 'catalog',
      }),
    ).toContain('"action":"compare","file":"dist/index.html","reference":"catalog"');
  });
});
