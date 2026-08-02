import type { InputBuilder } from '@wrongstack/core/agent';
import { render } from 'ink-testing-library';
import React from 'react';
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { State } from '../src/app-state.js';
import * as fileSearchModule from '../src/file-search.js';
import { detectAtToken, useFileSearch } from '../src/hooks/use-file-search.js';
import { Text } from '../src/ink.js';
import { TokenPreviewStore } from '../src/token-previews.js';

// Mock node:fs/promises for file reading tests
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PickerState = { open: boolean; query: string; matches: string[]; selected: number };

const defaultPicker: PickerState = { open: false, query: '', matches: [], selected: 0 };

// ─── detectAtToken (pure) ────────────────────────────────────────────

describe('detectAtToken', () => {
  it('returns null when cursor is at position 0', () => {
    expect(detectAtToken('', 0)).toBeNull();
  });

  it('returns null when no @ sign precedes the cursor', () => {
    expect(detectAtToken('hello world', 5)).toBeNull();
  });

  it('detects a simple @query token', () => {
    expect(detectAtToken('@foo', 4)).toEqual({ start: 0, end: 4, query: 'foo' });
  });

  it('detects @query in the middle of buffer', () => {
    expect(detectAtToken('prefix @foo suffix', 11)).toEqual({ start: 7, end: 11, query: 'foo' });
  });

  it('returns null when @ is preceded by a non-whitespace char', () => {
    expect(detectAtToken('prefix@foo', 10)).toBeNull();
  });

  it('stops at whitespace before @', () => {
    expect(detectAtToken('no token', 7)).toBeNull();
  });

  it('stops at tab before @', () => {
    expect(detectAtToken('\t@foo', 5)).toEqual({ start: 1, end: 5, query: 'foo' });
  });

  it('stops at newline before @', () => {
    expect(detectAtToken('\n@foo', 5)).toEqual({ start: 1, end: 5, query: 'foo' });
  });

  it('returns null when whitespace appears between @ and cursor', () => {
    expect(detectAtToken('@foo bar', 5)).toBeNull();
  });

  it('handles @ at position 0', () => {
    expect(detectAtToken('@', 1)).toEqual({ start: 0, end: 1, query: '' });
  });

  it('handles empty query after @', () => {
    expect(detectAtToken('@ ', 2)).toBeNull();
  });
});

// ─── useFileSearch hook ──────────────────────────────────────────────

interface HarnessRefs {
  state: { buffer: string; cursor: number; picker: PickerState };
  dispatch: Mock;
  projectRoot: string;
  builderRef: React.MutableRefObject<InputBuilder | null>;
  draftRef: React.MutableRefObject<{ buffer: string; cursor: number }>;
  setDraft: Mock;
  tokenPreviewsRef: React.MutableRefObject<TokenPreviewStore>;
  result: { current: ReturnType<typeof useFileSearch> | null };
}

function buildHarness(): HarnessRefs {
  return {
    state: { buffer: '', cursor: 0, picker: { ...defaultPicker } },
    dispatch: vi.fn(),
    projectRoot: '/test/project',
    builderRef: { current: null },
    draftRef: { current: { buffer: '', cursor: 0 } },
    setDraft: vi.fn(),
    tokenPreviewsRef: { current: new TokenPreviewStore() },
    result: { current: null },
  };
}

function Harness({ refs }: { refs: HarnessRefs }): React.ReactElement {
  refs.result.current = useFileSearch({
    // The hook only reads buffer/cursor/picker; the harness supplies that slice
    // and casts to the full State the hook's option type nominally requires.
    state: refs.state as unknown as State,
    dispatch: refs.dispatch,
    projectRoot: refs.projectRoot,
    builderRef: refs.builderRef,
    draftRef: refs.draftRef,
    setDraft: refs.setDraft,
    tokenPreviewsRef: refs.tokenPreviewsRef,
  });
  return React.createElement(Text, null, 'file-search-harness');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('useFileSearch - @-token detection effect', () => {
  it('closes picker when no @-token is detected and picker is open', () => {
    const refs = buildHarness();
    refs.state.picker = { open: true, query: 'old', matches: [], selected: 0 };
    render(React.createElement(Harness, { refs }));
    expect(refs.dispatch).toHaveBeenCalledWith({ type: 'pickerClose' });
  });

  it('does nothing when no @-token detected and picker already closed', () => {
    const refs = buildHarness();
    render(React.createElement(Harness, { refs }));
    expect(refs.dispatch).not.toHaveBeenCalled();
  });

  it('opens picker when @-token detected but picker not open', () => {
    const refs = buildHarness();
    refs.state.buffer = '@fi';
    refs.state.cursor = 3;
    render(React.createElement(Harness, { refs }));
    expect(refs.dispatch).toHaveBeenCalledWith({ type: 'pickerOpen', query: 'fi' });
  });

  it('updates matches via searchFiles async', async () => {
    vi.spyOn(fileSearchModule, 'searchFiles').mockResolvedValue(['file1.ts', 'file2.ts']);
    const refs = buildHarness();
    refs.state.buffer = '@fi';
    refs.state.cursor = 3;
    refs.state.picker = { open: true, query: 'fi', matches: [], selected: 0 };
    render(React.createElement(Harness, { refs }));
    await vi.waitFor(() => {
      expect(refs.dispatch).toHaveBeenCalledWith({
        type: 'pickerSetMatches',
        query: 'fi',
        matches: ['file1.ts', 'file2.ts'],
      });
    });
  });

  it('onPickerEnter returns early when picker is closed', async () => {
    const refs = buildHarness();
    render(React.createElement(Harness, { refs }));
    await refs.result.current!.onPickerEnter();
    expect(refs.setDraft).not.toHaveBeenCalled();
  });

  it('onPickerEnter returns early when matches is empty', async () => {
    const refs = buildHarness();
    refs.state.picker = { open: true, query: 'x', matches: [], selected: 0 };
    render(React.createElement(Harness, { refs }));
    await refs.result.current!.onPickerEnter();
    expect(refs.setDraft).not.toHaveBeenCalled();
  });

  it('onPickerEnter returns early when builder is null', async () => {
    const refs = buildHarness();
    refs.state.picker = { open: true, query: 'x', matches: ['a.ts'], selected: 0 };
    render(React.createElement(Harness, { refs }));
    await refs.result.current!.onPickerEnter();
    expect(refs.setDraft).not.toHaveBeenCalled();
  });

  it('onPickerEnter closes picker when @-token no longer found in draft', async () => {
    const builder = { registerFile: vi.fn() } as unknown as InputBuilder;
    const refs = buildHarness();
    refs.builderRef.current = builder;
    refs.draftRef.current = { buffer: 'no at sign', cursor: 5 };
    refs.state.picker = { open: true, query: 'x', matches: ['a.ts'], selected: 0 };
    render(React.createElement(Harness, { refs }));
    await refs.result.current!.onPickerEnter();
    expect(refs.dispatch).toHaveBeenCalledWith({ type: 'pickerClose' });
  });

  it('onPickerEnter registers file and inserts token', async () => {
    const { readFile, stat } = await import('node:fs/promises');
    vi.mocked(stat).mockResolvedValue({ size: 12 } as Awaited<ReturnType<typeof stat>>);
    vi.mocked(readFile).mockResolvedValue('file content');
    const builder = {
      registerFile: vi.fn(async () => '[file:test]'),
    } as unknown as InputBuilder;
    const refs = buildHarness();
    refs.builderRef.current = builder;
    refs.draftRef.current = { buffer: '@test', cursor: 5 };
    refs.state.picker = { open: true, query: 'test', matches: ['src/test.ts'], selected: 0 };
    render(React.createElement(Harness, { refs }));
    await refs.result.current!.onPickerEnter();
    expect(builder.registerFile).toHaveBeenCalled();
    expect(refs.tokenPreviewsRef.current.get('[file:test]')).toBe('file content');
    expect(refs.dispatch).toHaveBeenCalledWith({ type: 'pickerClose' });
  });

  it('registers a path read contract for a text file over the 1 MiB inline cap', async () => {
    const { readFile, stat } = await import('node:fs/promises');
    vi.mocked(stat).mockResolvedValue({ size: 1024 * 1024 + 1 } as Awaited<
      ReturnType<typeof stat>
    >);
    const builder = {
      registerFile: vi.fn(async () => '[file:test]'),
    } as unknown as InputBuilder;
    const refs = buildHarness();
    refs.builderRef.current = builder;
    refs.draftRef.current = { buffer: '@test', cursor: 5 };
    refs.state.picker = { open: true, query: 'test', matches: ['src/test.ts'], selected: 0 };
    render(React.createElement(Harness, { refs }));

    await refs.result.current!.onPickerEnter();

    expect(readFile).not.toHaveBeenCalled();
    expect(builder.registerFile).toHaveBeenCalledWith({
      kind: 'file',
      data: expect.stringMatching(/src\/test\.ts[\s\S]*read the complete file[\s\S]*until EOF/),
      meta: { filename: 'src/test.ts', label: 'src/test.ts' },
    });
    expect(refs.setDraft).toHaveBeenCalledWith('[file:test]', '[file:test]'.length);
    expect(refs.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'addEntry' }));
  });

  it('accepts a text file exactly at the 1 MiB UTF-8 byte cap', async () => {
    const { readFile, stat } = await import('node:fs/promises');
    const data = 'x'.repeat(1024 * 1024);
    vi.mocked(stat).mockResolvedValue({ size: data.length } as Awaited<ReturnType<typeof stat>>);
    vi.mocked(readFile).mockResolvedValue(data);
    const builder = {
      registerFile: vi.fn(async () => '[file:test]'),
    } as unknown as InputBuilder;
    const refs = buildHarness();
    refs.builderRef.current = builder;
    refs.draftRef.current = { buffer: '@test', cursor: 5 };
    refs.state.picker = { open: true, query: 'test', matches: ['src/test.ts'], selected: 0 };
    render(React.createElement(Harness, { refs }));

    await refs.result.current!.onPickerEnter();

    expect(builder.registerFile).toHaveBeenCalledWith({
      kind: 'file',
      data,
      meta: { filename: 'src/test.ts', label: 'src/test.ts' },
    });
  });

  it('falls back to a path read contract when decoded UTF-8 bytes exceed the inline cap', async () => {
    const { readFile, stat } = await import('node:fs/promises');
    vi.mocked(stat).mockResolvedValue({ size: 600_000 } as Awaited<ReturnType<typeof stat>>);
    vi.mocked(readFile).mockResolvedValue('é'.repeat(600_000));
    const builder = {
      registerFile: vi.fn(async () => '[file:test]'),
    } as unknown as InputBuilder;
    const refs = buildHarness();
    refs.builderRef.current = builder;
    refs.draftRef.current = { buffer: '@test', cursor: 5 };
    refs.state.picker = { open: true, query: 'test', matches: ['src/test.ts'], selected: 0 };
    render(React.createElement(Harness, { refs }));

    await refs.result.current!.onPickerEnter();

    expect(builder.registerFile).toHaveBeenCalledWith({
      kind: 'file',
      data: expect.stringMatching(/src\/test\.ts[\s\S]*read the complete file[\s\S]*until EOF/),
      meta: { filename: 'src/test.ts', label: 'src/test.ts' },
    });
  });

  it('onPickerEnter dispatches error when file read fails', async () => {
    const { readFile, stat } = await import('node:fs/promises');
    vi.mocked(stat).mockResolvedValue({ size: 12 } as Awaited<ReturnType<typeof stat>>);
    vi.mocked(readFile).mockRejectedValue(new Error('not found'));
    const builder = {
      registerFile: vi.fn(),
    } as unknown as InputBuilder;
    const refs = buildHarness();
    refs.builderRef.current = builder;
    refs.draftRef.current = { buffer: '@test', cursor: 5 };
    refs.state.picker = { open: true, query: 'test', matches: ['src/test.ts'], selected: 0 };
    render(React.createElement(Harness, { refs }));
    await refs.result.current!.onPickerEnter();
    expect(refs.dispatch).toHaveBeenCalledWith({
      type: 'addEntry',
      entry: { kind: 'error', text: 'Attach failed: not found' },
    });
    expect(refs.dispatch).toHaveBeenCalledWith({ type: 'pickerClose' });
  });
});
