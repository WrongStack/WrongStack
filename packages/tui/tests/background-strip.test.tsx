import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getProcessRegistry } from '@wrongstack/tools';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetEntry } from '../src/app-state-fleet.js';
import {
  agentPeekLines,
  type BackgroundItem,
  buildBackgroundItems,
  formatElapsed,
  getBackgroundStrip,
  layoutStripChips,
  updateBackgroundStrip,
} from '../src/background-strip-model.js';
import { BackgroundStrip } from '../src/components/background-strip.js';
import { EMPTY_KEY, type KeyEvent } from '../src/components/input.js';
import { routeBackgroundStrip } from '../src/key-routes/key-route-background-strip.js';

const agent = (id: string, startedAt: number, status: FleetEntry['status'] = 'running') =>
  ({
    id,
    name: `explore#${id}`,
    status,
    streamingText: '',
    iterations: 0,
    toolCalls: 0,
    recentTools: [],
    recentMessages: [],
    cost: 0,
    startedAt,
    lastEventAt: startedAt,
  }) as FleetEntry;

const shell = (pid: number, command: string, startedAt: number, extra = {}) => ({
  pid,
  command,
  startedAt,
  background: true,
  killed: false,
  ...extra,
});

const key = (over: Partial<KeyEvent>): KeyEvent => ({ ...EMPTY_KEY, ...over });

beforeEach(() => updateBackgroundStrip({ items: [] }));

describe('background strip model', () => {
  it('lists running subagents, then background shells, each oldest first', () => {
    const items = buildBackgroundItems(
      { a: agent('2', 20), b: agent('1', 10), c: agent('3', 5, 'success') },
      [
        shell(42, 'pnpm   dev', 30),
        shell(41, 'vite', 25),
        { ...shell(40, 'fg', 1), background: false },
        { ...shell(39, 'gone', 1), killed: true },
      ],
    );
    expect(items.map((i) => i.id)).toEqual(['agent:1', 'agent:2', 'shell:41', 'shell:42']);
    expect(items[3]?.label).toBe('pnpm dev');
  });

  it('formats elapsed time compactly', () => {
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(3 * 60_000 + 5_000)).toBe('3m');
    expect(formatElapsed(64 * 60_000)).toBe('1h4m');
    expect(formatElapsed(120 * 60_000)).toBe('2h');
  });

  it('always shows the selected chip, and counts the ones that did not fit', () => {
    const items: BackgroundItem[] = Array.from({ length: 8 }, (_, i) => ({
      id: `shell:${i}`,
      kind: 'shell',
      label: `server-number-${i}`,
      startedAt: 0,
      pid: i,
    }));
    const { chips, hidden } = layoutStripChips(items, 7, 60, 5_000, '⠋');
    expect(chips.some((c) => c.selected && c.item.id === 'shell:7')).toBe(true);
    expect(hidden).toBe(items.length - chips.length);
    expect(hidden).toBeGreaterThan(0);
  });

  it('peeks at what a subagent said and is doing', () => {
    const entry = {
      ...agent('1', 0),
      recentMessages: [{ text: 'reading the parser\nfound it', at: 1 }],
      streamingText: 'The bug is in',
      currentTool: { name: 'grep', startedAt: 2 },
    };
    expect(agentPeekLines(entry, 3)).toEqual(['found it', 'The bug is in', '▸ grep']);
  });

  it('keeps the selection on the same chip when another appears before it', () => {
    const a: BackgroundItem = { id: 'agent:1', kind: 'agent', label: 'a', startedAt: 1 };
    const s: BackgroundItem = { id: 'shell:9', kind: 'shell', label: 's', startedAt: 2, pid: 9 };
    updateBackgroundStrip({ items: [s], selectedId: 'shell:9', focused: true });
    updateBackgroundStrip({ items: [a, s] });
    expect(getBackgroundStrip().selectedId).toBe('shell:9');
    updateBackgroundStrip({ items: [] });
    expect(getBackgroundStrip()).toMatchObject({ focused: false, peek: false });
  });
});

describe('Alt+B and the strip keys', () => {
  const items: BackgroundItem[] = [
    { id: 'agent:1', kind: 'agent', label: 'explore#1', startedAt: 1, agentId: '1' },
    { id: 'shell:77', kind: 'shell', label: 'pnpm dev', startedAt: 2, pid: 77 },
  ];

  it('does nothing while nothing runs in the background', () => {
    expect(routeBackgroundStrip('b', key({ meta: true }), vi.fn())).toBe(false);
  });

  it('focuses, moves, opens output, and stops a shell only after y', () => {
    const stop = vi.fn();
    updateBackgroundStrip({ items });
    expect(routeBackgroundStrip('b', key({ meta: true }), stop)).toBe(true);
    expect(getBackgroundStrip()).toMatchObject({
      focused: true,
      peek: true,
      selectedId: 'agent:1',
    });

    // `x` on a subagent does not offer to stop it.
    routeBackgroundStrip('x', key({}), stop);
    expect(getBackgroundStrip().confirmStop).toBe(false);

    routeBackgroundStrip('', key({ rightArrow: true }), stop);
    expect(getBackgroundStrip().selectedId).toBe('shell:77');
    routeBackgroundStrip('', key({ return: true }), stop);
    expect(getBackgroundStrip().peek).toBe(false);

    routeBackgroundStrip('x', key({}), stop);
    expect(getBackgroundStrip().confirmStop).toBe(true);
    routeBackgroundStrip('n', key({}), stop);
    expect(stop).not.toHaveBeenCalled();
    routeBackgroundStrip('x', key({}), stop);
    routeBackgroundStrip('y', key({}), stop);
    expect(stop).toHaveBeenCalledWith(77);

    routeBackgroundStrip('', key({ escape: true }), stop);
    expect(getBackgroundStrip().focused).toBe(false);
  });

  it('hands typing back to the composer, and lets Ctrl+C and scrolling through', () => {
    updateBackgroundStrip({ items, focused: true });
    expect(routeBackgroundStrip('', key({ pageUp: true }), vi.fn())).toBe(false);
    expect(routeBackgroundStrip('c', key({ ctrl: true }), vi.fn())).toBe(false);
    expect(getBackgroundStrip().focused).toBe(true);
    expect(routeBackgroundStrip('h', key({}), vi.fn())).toBe(false);
    expect(getBackgroundStrip().focused).toBe(false);
  });
});

describe('BackgroundStrip', () => {
  let dir: string;
  // A live pid: on POSIX the registry prunes a handle-less entry older than a
  // minute whose pid answers ESRCH, so a made-up pid vanished there. The
  // registry never signals its own process.
  const pid = process.pid;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-strip-'));
  });
  afterEach(() => {
    getProcessRegistry().unregister(pid);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('renders nothing while nothing runs', () => {
    const view = render(<BackgroundStrip fleet={{}} width={100} />);
    expect(view.lastFrame()).toBe('');
    view.unmount();
  });

  it('shows a chip per item, and the tail of a shell log when opened', async () => {
    const logFile = path.join(dir, 'dev.log');
    fs.writeFileSync(logFile, 'compiling…\nready on http://localhost:5173\n');
    getProcessRegistry().register({
      pid,
      name: 'bash',
      command: 'pnpm dev',
      startedAt: Date.now() - 65_000,
      child: null,
      background: true,
      logFile,
    });
    const view = render(<BackgroundStrip fleet={{ a: agent('1', Date.now()) }} width={120} />);
    await new Promise((r) => setTimeout(r, 30));
    let out = view.lastFrame() ?? '';
    expect(out).toContain('explore#1');
    expect(out).toContain('$ pnpm dev 1m');
    expect(out).toContain('Alt+B');

    updateBackgroundStrip({ focused: true, peek: true, selectedId: `shell:${pid}` });
    await new Promise((r) => setTimeout(r, 30));
    out = view.lastFrame() ?? '';
    expect(out).toContain('│ ready on http://localhost:5173');
    expect(out).toContain('x stop shell');
    view.unmount();
  });

  it('shortens its key help before it hides a chip', async () => {
    getProcessRegistry().register({
      pid,
      name: 'bash',
      command: 'node -e "let i=0;setInterval(()=>console.log(i++),1000)"',
      startedAt: Date.now(),
      child: null,
      background: true,
    });
    const view = render(<BackgroundStrip fleet={{ a: agent('1', Date.now()) }} width={100} />);
    await new Promise((r) => setTimeout(r, 30));
    updateBackgroundStrip({ focused: true, selectedId: `shell:${pid}` });
    await new Promise((r) => setTimeout(r, 30));
    const out = view.lastFrame() ?? '';
    expect(out).toContain('explore#1');
    expect(out).toContain('←→ · Enter · x · Esc');
    expect(out).not.toMatch(/\+1/);
    view.unmount();
  });

  it('formatElapsed returns 0s for non-finite durations', () => {
    expect(formatElapsed(Number.NaN)).toBe('0s');
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe('0s');
  });
});
