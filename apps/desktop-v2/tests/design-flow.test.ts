import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { buildDesktopDesignPrompt } from '../src/design-dna-prompt';
import { designArtifactRoot, designExtractionResult } from '../src/design-extraction-result';
import type { EngineEvent } from '../src/engine-state';
import { appendRunEvent } from '../src/run-timeline';
import { SessionActivity } from '../src/SessionActivity';
import { activityRows } from '../src/session-activity-model';
import { WorkspaceTools } from '../src/WorkspaceTools';

const input = { action: 'extract', url: 'https://example.com' };
const started: EngineEvent = {
  type: 'tool.started',
  payload: { id: 'extract', name: 'design_reference', input },
};
const progress = (text: string): EngineEvent => ({
  type: 'tool.progress',
  payload: { id: 'extract', name: 'design_reference', event: { text } },
});
const spec = '.design/references/example-com/DESIGN.md';
const completed = (output: string, ok = true): EngineEvent => ({
  type: 'tool.executed',
  payload: { id: 'extract', name: 'design_reference', input, ok, output },
});
const activity = (events: EngineEvent[], settled = false, projectRoot?: string) =>
  renderToStaticMarkup(
    createElement(SessionActivity, {
      events,
      settled,
      projectRoot,
      onOpenFile: vi.fn(),
      onOpenDesign: vi.fn(),
    }),
  );

describe('design workflow entry and results', () => {
  it('uses a nested conversation root for truncated native extraction artifacts', () => {
    const project = 'C:/Projects/Alpha';
    const engine = `${project}/packages/web`;
    const events: EngineEvent[] = [
      started,
      {
        type: 'tool.progress',
        payload: {
          id: 'extract',
          name: 'design_reference',
          event: { type: 'file_changed', path: `${engine}/${spec}`, operation: 'write' },
        },
      },
      completed('design_reference\noutput:\n# Design DNA — truncated…'),
    ];
    const row = activityRows(events)[0]!;
    expect(designExtractionResult(row, project)?.path).toBeUndefined();
    const owner = designArtifactRoot(project, engine);
    expect(owner).toBe(engine);
    expect(designExtractionResult(row, owner)?.path).toBe(spec);
  });

  it.each([
    ['C:/Projects/Alpha', 'C:/Projects/Alpha'],
    ['c:\\projects\\alpha\\packages\\web', 'c:\\projects\\alpha\\packages\\web'],
    [undefined, 'C:/Projects/Alpha'],
    ['C:/Projects/Alpha-other', null],
    ['C:/Projects/Beta', null],
    ['../Beta', null],
    ['', null],
  ])('keeps artifact root %j within its owning project', (engine, expected) => {
    expect(designArtifactRoot('C:/Projects/Alpha', engine)).toBe(expected);
  });
  it('offers extraction from the tools of an existing conversation', () => {
    const action = vi.fn();
    const html = renderToStaticMarkup(
      createElement(WorkspaceTools, {
        onClose: action,
        onActivity: action,
        onHistory: action,
        onSkills: action,
        onMcpTasks: action,
        onProcesses: action,
        onSideEffects: action,
        onUsage: action,
        onStory: action,
        onContext: action,
        onPlan: action,
        onProject: action,
        onSettings: action,
        onDesign: action,
      }),
    );
    expect(html).toContain('Reference Site');
  });

  it('exposes the reported DESIGN.md rather than requiring users to search raw output', () => {
    const html = renderToStaticMarkup(
      createElement(SessionActivity, {
        events: [
          {
            type: 'tool.started',
            payload: {
              id: 'extract',
              name: 'design_reference',
              input: { action: 'extract', url: 'https://example.com' },
            },
          },
          {
            type: 'tool.executed',
            payload: {
              id: 'extract',
              name: 'design_reference',
              ok: true,
              output: JSON.stringify({
                action: 'extract',
                reference: 'example-com',
                path: '.design/references/example-com/dna.md',
                output:
                  'Full 10-section DESIGN.md specification: .design/references/example-com/DESIGN.md.\n(3 page(s) analyzed)',
              }),
            },
          },
        ],
        onOpenFile: vi.fn(),
        onOpenDesign: vi.fn(),
      }),
    );
    expect(html).toContain('Open DESIGN.md');
    expect(html).toContain('aria-label="Reference Site');
  });

  it('can prepare React Native materialization from a reference', () => {
    const prompt = buildDesktopDesignPrompt({
      source: 'example.com',
      maxPages: 3,
      workflow: 'materialize-rn',
    });
    expect(prompt).toContain('action: "materialize", stack: "react-native"');
    expect(prompt).not.toContain('stack: "web"');
    expect(prompt).toContain('A pinned kit takes precedence');
  });

  it('advances through the multiline progress a journal actually coalesces', () => {
    const events = [
      started,
      progress('[1/4] Measuring'),
      progress('[3/4] Synthesizing'),
      progress('[2/4] Late frame'),
    ].reduce<EngineEvent[]>(appendRunEvent, []);
    const html = activity(events);
    expect(html).toMatch(/aria-current="step"[^>]*>[\s\S]*?DNA Synthesis<\/li>/);
    expect(html).not.toContain('Open DESIGN.md');
  });

  it('offers no file action for a failed extraction, even if partial output reports a path', () => {
    const html = activity([
      started,
      progress('[4/4] Writing'),
      completed(`Full 10-section DESIGN.md specification: ${spec}.`, false),
    ]);
    expect(html).toContain('data-state="failed"');
    expect(html).not.toContain('Open DESIGN.md');
  });

  it('settles interrupted activity without inventing a written file', () => {
    const html = activity([
      started,
      progress('[3/4] Synthesizing'),
      { type: 'run.result', payload: { status: 'aborted' } },
    ]);
    expect(html).toContain('data-state="failed"');
    expect(html).not.toContain('aria-current="step"');
    expect(html).not.toContain('Open DESIGN.md');
    expect(activity([started, progress('[3/4] Synthesizing')], true)).not.toContain(
      'aria-current="step"',
    );
  });

  it.each([
    '../../DESIGN.md',
    'D:/another-project/.design/references/example-com/DESIGN.md',
    '.design/references/example-com/../../DESIGN.md',
    'https://example.com/DESIGN.md',
    '.design/references/example-com/dna.md',
  ])('does not turn %s into an artifact action', (path) => {
    const html = activity([completed(`Full 10-section DESIGN.md specification: ${path}.`)]);
    expect(html).toContain('No DESIGN.md path was reported');
    expect(html).not.toContain('Open DESIGN.md');
  });

  it.each([spec, `D:/fixture/project/${spec}`])(
    'accepts the reported spec write at %s even when output was clipped',
    (path) => {
      const html = activity(
        [
          started,
          {
            ...progress(''),
            payload: {
              id: 'extract',
              name: 'design_reference',
              event: { path: path.replaceAll('/', '\\'), operation: 'write' },
            },
          },
          completed('{"output":"truncated'),
        ],
        false,
        'D:/fixture/project',
      );
      expect(html).toContain(spec);
      expect(html).toContain('Open DESIGN.md');
    },
  );

  it('does not display the extraction stages for a rendered inspection', () => {
    const html = activity([
      {
        ...started,
        payload: { ...started.payload, input: { action: 'inspect', file: 'index.html' } },
      },
    ]);
    expect(html).not.toContain('aria-label="Reference Site');
  });
});
