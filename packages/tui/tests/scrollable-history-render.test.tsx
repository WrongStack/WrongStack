import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../src/components/history.js';
import {
  type HistoryScrollController,
  ScrollableHistory,
} from '../src/components/scrollable-history.js';
import { Box, Text } from '../src/ink.js';
import { displayWidth, splitDisplay } from '../src/terminal-width.js';
import { cleanFrame, renderRealTty, settle } from './helpers/real-tty.js';

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
    const view = render(<ScrollableHistory entries={entries} toolStream={null} viewportRows={8} />);

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
      <ScrollableHistory entries={[assistant]} toolStream={null} viewportRows={8} maxWidth={40} />,
    );

    const lines = (view.lastFrame() ?? '').split('\n');
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(40);
    view.unmount();
  });

  it('keeps the scrollbar rail at the viewport edge for compact exec output', async () => {
    // `exec` previews contain both an argument summary and a stdout preview;
    // even in a narrow terminal neither may displace the managed rail.
    const execEntries: HistoryEntry[] = [1, 2, 3].flatMap((id) => [
      {
        id: id * 2 - 1,
        kind: 'tool' as const,
        name: 'exec',
        durationMs: id,
        ok: true,
        input: {
          command: 'gh',
          args: ['pr', 'view', String(id), '--json', 'title,body,author,createdAt,labels'],
        },
        output: JSON.stringify({ exitCode: 0, stdout: `result-${'x'.repeat(120)}` }),
      },
      { id: id * 2, kind: 'info' as const, text: `after exec ${id}` },
    ]);
    const tty = renderRealTty(
      <ScrollableHistory entries={execEntries} toolStream={null} viewportRows={18} />,
      { columns: 50, rows: 20 },
    );
    await settle(120);

    const rows = tty.lines().slice(0, 18);
    expect(rows).toHaveLength(18);
    expect(rows.every((row) => row.length <= 50)).toBe(true);
    // The final column belongs to the managed rail on every viewport row;
    // no exec preview may push it off the right edge.
    expect(rows.every((row) => row.endsWith('│') || row.endsWith('█'))).toBe(true);
    tty.unmount();
  });

  it('keeps tabular exec output from painting through the rail into a sidebar', async () => {
    const columns = 100;
    const mainColumnWidth = 70;
    const execEntry: HistoryEntry = {
      id: 1,
      kind: 'tool',
      name: 'exec',
      durationMs: 538,
      ok: true,
      input: { command: 'pnpm', args: ['exec', 'tsx', '.temp_files/residual-probe.ts'] },
      output:
        'exec: pnpm exec tsx .temp_files/residual-probe.ts (exit_code=0 allowed=true truncated=false)\n' +
        'stdout:\n' +
        'PASS\tshould block\tsudo --user=root rm .env\t[".env"]\texpected [".env"]\n' +
        'PASS\tshould block\tenv -u VAR rm .env\t[".env"]\texpected [".env"]\x1b[40C',
    };
    const markdownEntry: HistoryEntry = {
      id: 2,
      kind: 'assistant',
      text: [
        '| Status | Route | Owner |',
        '|--------|-------|-------|',
        '| ✅ | a->b=>c | 👨‍👩‍👧‍👦 名前 |',
        '| ❌ | x!=y | e\u0301quipe 🚀 |',
      ].join('\n'),
    };
    const tty = renderRealTty(
      <Box flexDirection="row" width={columns} height={30} overflowX="hidden">
        <Box width={mainColumnWidth} height={30} flexShrink={0} overflowX="hidden">
          <ScrollableHistory
            entries={[execEntry, markdownEntry]}
            toolStream={null}
            viewportRows={30}
            maxWidth={mainColumnWidth}
          />
        </Box>
        <Box width={columns - mainColumnWidth} height={30} flexShrink={0} flexDirection="column">
          {Array.from({ length: 30 }, (_, row) => (
            <Text key={row}>{`SIDE-${String(row).padStart(2, '0')}`}</Text>
          ))}
        </Box>
      </Box>,
      { columns, rows: 30 },
    );
    await settle(120);

    const frame = tty.lastFrame();
    expect(frame).toContain('PASS  should block');
    expect(frame).toContain('SIDE-00');
    expect(frame).toContain('👨‍👩‍👧‍👦');
    expect(frame).not.toContain('a->b');
    expect(frame).not.toContain('b=>c');
    expect(frame).toContain('a- >b=');
    expect(frame).toContain('>c');
    expect(frame).not.toMatch(/[\t\r]/);
    expect(tty.stdout.frames.every((rawFrame) => !rawFrame.includes('\x1b[40Cspill'))).toBe(true);
    const rows = cleanFrame(tty.stdout.frames.at(-1) ?? '')
      .split('\n')
      .slice(0, 30);
    expect(rows).toHaveLength(30);
    expect(rows.every((row) => displayWidth(row) <= columns)).toBe(true);
    for (let row = 0; row < rows.length; row++) {
      const [main, sidebar] = splitDisplay(rows[row] ?? '', mainColumnWidth);
      expect(main.endsWith('│') || main.endsWith('█'), JSON.stringify({ row, main, sidebar })).toBe(
        true,
      );
      expect(sidebar).toContain(`SIDE-${String(row).padStart(2, '0')}`);
    }
    tty.unmount();
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
