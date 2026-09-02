// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileMention } from '../src/hooks/use-file-mention.js';
import type { FileMention } from '../src/lib/file-mention.js';

interface Captured {
  current: ReturnType<typeof useFileMention>;
}

interface MockSocket {
  send: ReturnType<typeof vi.fn>;
}

const roots: Root[] = [];

function makeMention(query: string): FileMention {
  return { start: 0, end: query.length + 1, query };
}

function renderHookViaRoot(captured: Captured, socket: MockSocket): Root {
  function Probe(): null {
    captured.current = useFileMention({ socketRef: { current: socket as never } });
    return null;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<Probe />));
  return root;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useFileMention — initial state', () => {
  it('starts with null mention, empty matches, index 0, not searching', () => {
    const captured: Captured = { current: undefined as never };
    const socket: MockSocket = { send: vi.fn() };
    renderHookViaRoot(captured, socket);

    expect(captured.current.fileMention).toBeNull();
    expect(captured.current.fileMatches).toEqual([]);
    expect(captured.current.filePickerIndex).toBe(0);
    expect(captured.current.fileSearching).toBe(false);
  });
});

describe('useFileMention — debounce', () => {
  it('sends files.list after 80ms when a mention is set', () => {
    const captured: Captured = { current: undefined as never };
    const socket: MockSocket = { send: vi.fn() };
    renderHookViaRoot(captured, socket);

    act(() => captured.current.setFileMention(makeMention('app')));
    expect(captured.current.fileSearching).toBe(true);
    expect(socket.send).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(79));
    expect(socket.send).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(socket.send).toHaveBeenCalledWith('files.list', { query: 'app', limit: 12 });
  });

  it('does not send when mention is null', () => {
    const captured: Captured = { current: undefined as never };
    const socket: MockSocket = { send: vi.fn() };
    renderHookViaRoot(captured, socket);

    act(() => vi.advanceTimersByTime(100));
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('collapses rapid typing into a single files.list for the latest query', () => {
    const captured: Captured = { current: undefined as never };
    const socket: MockSocket = { send: vi.fn() };
    renderHookViaRoot(captured, socket);

    act(() => captured.current.setFileMention(makeMention('a')));
    act(() => vi.advanceTimersByTime(30));
    act(() => captured.current.setFileMention(makeMention('ap')));
    act(() => vi.advanceTimersByTime(30));
    act(() => captured.current.setFileMention(makeMention('app')));
    act(() => vi.advanceTimersByTime(80));

    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledWith('files.list', { query: 'app', limit: 12 });
  });

  it('clears fileSearching when mention is set to null', () => {
    const captured: Captured = { current: undefined as never };
    const socket: MockSocket = { send: vi.fn() };
    renderHookViaRoot(captured, socket);

    act(() => captured.current.setFileMention(makeMention('test')));
    expect(captured.current.fileSearching).toBe(true);

    act(() => captured.current.setFileMention(null));
    expect(captured.current.fileSearching).toBe(false);
  });
});

describe('useFileMention — selectFile', () => {
  it('returns updated draft (mention removed) and fileRefs (path added)', () => {
    const captured: Captured = { current: undefined as never };
    const socket: MockSocket = { send: vi.fn() };
    renderHookViaRoot(captured, socket);

    act(() => captured.current.setFileMention(makeMention('app')));
    const result = captured.current.selectFile('src/app.tsx', '@app hello', []);

    expect(result.draft).not.toContain('@app');
    expect(result.fileRefs).toEqual(['src/app.tsx']);
  });

  it('does not duplicate path in fileRefs when called twice with same path', () => {
    const captured: Captured = { current: undefined as never };
    const socket: MockSocket = { send: vi.fn() };
    renderHookViaRoot(captured, socket);

    act(() => captured.current.setFileMention(makeMention('app')));
    const r1 = captured.current.selectFile('src/app.tsx', '@app', []);
    const r2 = captured.current.selectFile('src/app.tsx', r1.draft, r1.fileRefs);
    expect(r2.fileRefs).toEqual(['src/app.tsx', 'src/app.tsx']);
  });
});
