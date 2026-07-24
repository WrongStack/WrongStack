import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import {
  type HistoryScrollController,
  ScrollableHistory,
} from '../src/components/scrollable-history.js';
import type { HistoryEntry } from '../src/components/history.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

const entries: HistoryEntry[] = Array.from({ length: 50 }, (_, index) => ({
  id: index + 1,
  kind: 'user',
  text: `history-entry-${String(index + 1).padStart(2, '0')}`,
}));

describe('<ScrollableHistory /> content navigation', () => {
  it('passes its viewport height to the banner so a one-row history does not clip artwork', () => {
    const banner: HistoryEntry = {
      id: 0,
      kind: 'banner',
      version: '1.2.3',
      provider: 'openai',
      model: 'gpt-test',
      cwd: '/workspace/wrongstack',
    };
    const view = render(
      <ScrollableHistory entries={[banner]} toolStream={null} viewportRows={1} />,
    );

    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('WrongStack v1.2.3');
    expect(frame).not.toContain('BUILT ON THE WRONG STACK');
    view.unmount();
  });

  it('changes the rendered history slice through the scroll controller', async () => {
    const controllerRef = { current: null as HistoryScrollController | null };
    const view = renderRealTty(
      <ScrollableHistory
        entries={entries}
        toolStream={null}
        viewportRows={8}
        controllerRef={controllerRef}
      />,
      { columns: 60, rows: 10 },
    );
    await settle();

    const newest = view.lastFrame();
    expect(newest).toContain('history-entry-50');
    expect(newest).not.toContain('history-entry-01');

    controllerRef.current?.scrollToTop();
    await settle();
    const oldest = view.lastFrame();
    expect(oldest).toContain('history-entry-01');
    expect(oldest).not.toContain('history-entry-50');
    view.unmount();
  });

  it('virtualizes a long transcript on the first frame', () => {
    const view = render(
      <ScrollableHistory entries={entries} toolStream={null} viewportRows={8} />,
    );

    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('history-entry-50');
    expect(frame).not.toContain('history-entry-01');
    expect(frame).not.toContain('history-entry-25');
    view.unmount();
  });

  it('reserves the scrollbar columns when sizing assistant content', () => {
    const assistant: HistoryEntry = {
      id: 1,
      kind: 'assistant',
      text: 'x'.repeat(200),
    };
    const view = render(
      <ScrollableHistory
        entries={[assistant]}
        toolStream={null}
        viewportRows={8}
        maxWidth={40}
      />,
    );

    const lines = (view.lastFrame() ?? '').split('\n');
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(40);
    view.unmount();
  });

  it('keeps structured diff tools ungrouped so each entry honors the summary threshold', () => {
    const replaceEntries: HistoryEntry[] = Array.from({ length: 2 }, (_, entryIndex) => ({
      id: entryIndex + 1,
      kind: 'tool',
      name: 'replace',
      durationMs: 1,
      ok: true,
      input: { path: 'src/' },
      output: JSON.stringify({
        results: Array.from({ length: 5 }, (_, fileIndex) => ({
          path: `src/file-${entryIndex + 1}-${fileIndex + 1}.ts`,
          diff: `--- a.ts\n+++ b.ts\n@@ -1 +1 @@\n-old-${fileIndex + 1}\n+new-${fileIndex + 1}`,
        })),
      }),
    }));
    const view = render(
      <ScrollableHistory
        entries={replaceEntries}
        toolStream={null}
        viewportRows={60}
        multiDiffSummaryThreshold={0}
      />,
    );

    const frame = view.lastFrame() ?? '';
    expect(frame).not.toContain('replace ×2');
    expect(frame).not.toContain('5 files');
    expect(frame.match(/Update\(/g)).toHaveLength(2);
    view.unmount();
  });

  it('keeps consecutive edit/update tool results ungrouped', () => {
    const editEntries: HistoryEntry[] = Array.from({ length: 3 }, (_, entryIndex) => ({
      id: entryIndex + 1,
      kind: 'tool',
      name: 'edit',
      durationMs: 2,
      ok: true,
      input: { path: `src/file-${entryIndex + 1}.ts` },
      output: JSON.stringify({
        path: `src/file-${entryIndex + 1}.ts`,
        replacements: 1,
        diff: `--- a.ts\n+++ b.ts\n@@ -1 +1 @@\n-old-${entryIndex + 1}\n+new-${entryIndex + 1}`,
      }),
    }));
    const view = render(
      <ScrollableHistory entries={editEntries} toolStream={null} viewportRows={60} />,
    );

    const frame = view.lastFrame() ?? '';
    expect(frame).not.toContain('edit ×3');
    expect(frame.match(/Update\(/g)).toHaveLength(3);
    view.unmount();
  });

  it('keeps the live tool tail visible while pinned and hides it past the window', async () => {
    const controllerRef = { current: null as HistoryScrollController | null };
    const history = (toolText: string) => (
      <ScrollableHistory
        entries={entries}
        toolStream={
          toolText
            ? { toolUseId: 'read-1', name: 'read', text: toolText, startedAt: Date.now() }
            : null
        }
        viewportRows={20}
        controllerRef={controllerRef}
      />
    );

    const view = renderRealTty(history(''), { columns: 60, rows: 22 });
    await settle();
    view.rerender(history('live read output'));
    await settle();

    // Pinned: the live tail renders at the bottom of the scroll space,
    // together with the newest committed entry above it.
    const pinned = view.lastFrame();
    expect(pinned).toContain('live read output');
    expect(pinned).toContain('history-entry-50');

    // Far away from the bottom, the tail's window is no longer mounted.
    controllerRef.current?.scrollToTop();
    await settle();
    const scrolled = view.lastFrame();
    expect(scrolled).toContain('history-entry-01');
    expect(scrolled).not.toContain('live read output');
    view.unmount();
  });

  it('groups consecutive read results under one compact header', () => {
    const readEntries: HistoryEntry[] = Array.from({ length: 3 }, (_, index) => ({
      id: index + 1,
      kind: 'tool',
      name: 'read',
      durationMs: index + 1,
      ok: true,
      input: { path: `src/file-${index + 1}.ts` },
    }));
    const view = render(
      <ScrollableHistory entries={readEntries} toolStream={null} viewportRows={12} />,
    );

    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('read ×3');
    expect(frame.match(/\bread\b/g)).toHaveLength(1);
    for (let index = 1; index <= 3; index++) {
      expect(frame).toContain(`src/file-${index}.ts`);
    }
    view.unmount();
  });

  it('bounds consecutive same-tool groups so one virtual item cannot grow forever', () => {
    const toolEntries: HistoryEntry[] = Array.from({ length: 50 }, (_, index) => ({
      id: index + 1,
      kind: 'tool',
      name: 'read',
      durationMs: 0,
      ok: true,
      input: { path: `bounded-file-${String(index + 1).padStart(2, '0')}.ts` },
    }));
    const view = render(
      <ScrollableHistory entries={toolEntries} toolStream={null} viewportRows={8} />,
    );

    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('bounded-file-50.ts');
    expect(frame).not.toContain('bounded-file-01.ts');
    expect(frame).not.toContain('×50');
    expect(frame).toMatch(/read ×(?:2|12)/);
    view.unmount();
  });

  it('scrolls a consecutive tool group using its rendered height', async () => {
    const controllerRef = { current: null as HistoryScrollController | null };
    const toolEntries: HistoryEntry[] = Array.from({ length: 50 }, (_, index) => ({
      id: index + 1,
      kind: 'tool',
      name: 'read',
      durationMs: 0,
      ok: true,
      input: { path: `group-file-${String(index + 1).padStart(2, '0')}.ts` },
    }));
    const view = renderRealTty(
      <ScrollableHistory
        entries={toolEntries}
        toolStream={null}
        viewportRows={8}
        controllerRef={controllerRef}
      />,
      { columns: 60, rows: 10 },
    );
    await settle();

    const newest = view.lastFrame();
    expect(newest).toContain('group-file-50.ts');
    expect(newest).not.toContain('group-file-01.ts');

    controllerRef.current?.scrollToTop();
    await settle();
    const oldest = view.lastFrame();
    expect(oldest).toContain('group-file-01.ts');
    expect(oldest).not.toContain('group-file-50.ts');
    view.unmount();
  });
});
