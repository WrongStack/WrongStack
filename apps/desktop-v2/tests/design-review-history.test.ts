import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DesignReviewCard } from '../src/DesignReviewCard';
import type { ActivityRow } from '../src/session-activity-model';

const run = '12345678-1234-4123-8123-123456789abc';
const render = (
  action: 'inspect' | 'compare',
  path: string,
  status: ActivityRow['status'] = 'done',
) =>
  renderToStaticMarkup(
    createElement(DesignReviewCard, {
      row: {
        id: 'review',
        kind: 'tool',
        title: 'design_reference',
        status,
        input: { action },
        output: JSON.stringify({ action, path, fails: 0, warns: 0, score: 0.5 }),
        progress: [],
        files: [],
        sage: [],
      },
      onOpenFile: vi.fn(),
    }),
  );

describe('historical design review actions', () => {
  it.each([
    ['inspect', '.design/inspect/page/inspect.md'],
    ['compare', '.design/references/reference/fidelity.md'],
  ] as const)('identifies the shared %s report as a mutable latest alias', (action, path) => {
    const html = render(action, path);
    expect(html).toContain('Open latest report');
    expect(html).toContain('may contain a newer review');
    expect(html).not.toContain('Open report');
  });

  it.each([
    ['inspect', '.design/inspect/runs/inspect.md'],
    ['compare', '.design/references/runs/fidelity.md'],
  ] as const)(
    'does not mistake a legacy %s target named runs for a retained snapshot',
    (action, path) => {
      expect(render(action, path)).toContain('Open latest report');
    },
  );

  it.each([
    ['inspect', `.design/inspect/page/runs/${run}/inspect.md`],
    ['compare', `.design/references/reference/runs/${run}/fidelity.md`],
  ] as const)('opens the retained %s snapshot as its own report', (action, path) => {
    const html = render(action, path);
    expect(html).toContain('Open report');
    expect(html).not.toContain('Open latest report');
    expect(html).not.toContain('may contain a newer review');
  });

  it.each([
    `.design/inspect/page/runs/../../inspect.md`,
    `.design/inspect/page/runs/not-a-run/inspect.md`,
    `.design/references/reference/runs/${run}/inspect.md`,
    `.design/inspect/page/runs/${run}/inspect.json`,
  ])('does not expose an invalid snapshot target %s', (path) => {
    expect(render('inspect', path)).not.toContain('Open report');
    expect(render('inspect', path)).not.toContain('Open latest report');
  });
  it('keeps failed reviews without a completed report action', () => {
    const html = render('inspect', `.design/inspect/page/runs/${run}/inspect.md`, 'failed');
    expect(html).not.toContain('Open report');
    expect(html).not.toContain('Open latest report');
  });
});
