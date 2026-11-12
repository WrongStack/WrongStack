// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { EngineCommand } from '../src/engine-operations';
import { emptyEngineState } from '../src/engine-state';
import { FileWorkspace } from '../src/FileWorkspace';

vi.mock('../src/platform', async (original) => ({
  ...(await original<typeof import('../src/platform')>()),
  request: vi.fn(async (method: string) =>
    method === 'file-drafts.list' ? { drafts: [] } : { revision: 0, value: null },
  ),
  fileDraftStorage: () => ({
    get: async () => ({ revision: 0, value: null }),
    save: async () => 1,
  }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const path = '.design/inspect/fixture/runs/12345678-1234-4123-8123-123456789abc/inspect.md';
const content = '# Original measured report\nSurface: app · 0 FAIL · 0 WARN\n';
const tree = [{ name: 'inspect.md', path, type: 'file' }];

async function mount(
  treeRead: () => Promise<Record<string, unknown>>,
  scope: string,
  options: { initialPath?: string; knownFile?: boolean; readError?: string } = {},
) {
  const command: EngineCommand = vi.fn(async (type, payload) => {
    if (type === 'files.tree') return treeRead();
    if (type === 'files.read') {
      expect(payload.filePath).toBe(path);
      if (options.readError) throw Error(options.readError);
      return { filePath: path, content };
    }
    return { files: [] };
  });
  const host = document.createElement('div'),
    root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(FileWorkspace, {
        command,
        send: async () => {},
        state: emptyEngineState,
        projectId: scope,
        scopeKey: 'D:/' + scope,
        initialPath: options.initialPath ?? path,
        // The caller already knows this target is a file, not a folder.
        initialPathIsFile: options.knownFile ?? true,
      }),
    );
  });
  return { host, command, close: () => act(async () => root.unmount()) };
}

describe('opening a known file independently of the explorer listing', () => {
  it('opens the measured report with a normally responding tree (control)', async () => {
    const view = await mount(async () => ({ tree }), 'known-file-control');
    try {
      expect(view.host.querySelector('.native-file-content')?.textContent).toContain(
        'Original measured report',
      );
      expect(view.command).toHaveBeenCalledWith('files.read', { filePath: path }, ['files.read']);
    } finally {
      await view.close();
    }
  });
  it('reads the known report while the unrelated whole-tree request is still gated', async () => {
    let release!: (value: Record<string, unknown>) => void;
    const gate = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve;
    });
    const view = await mount(() => gate, 'known-file-pending-tree');
    try {
      expect(
        view.command,
        'a known file must not wait for the entire explorer tree',
      ).toHaveBeenCalledWith('files.read', { filePath: path }, ['files.read']);
      expect(view.host.querySelector('.native-file-content')?.textContent).toContain(
        'Original measured report',
      );
      expect(view.host.querySelector('aside')?.textContent).toContain('Reading');
      await act(async () => release({ tree }));
      expect(
        vi.mocked(view.command).mock.calls.filter(([type]) => type === 'files.read'),
      ).toHaveLength(1);
    } finally {
      await act(async () => release({ tree }));
      await view.close();
    }
  });
  it('keeps the known report accessible when listing fails', async () => {
    const view = await mount(async () => {
      throw Error('Explorer listing unavailable');
    }, 'known-file-failed-tree');
    try {
      expect(view.host.querySelector('.native-file-content')?.textContent).toContain(
        'Original measured report',
      );
    } finally {
      await view.close();
    }
  });
  it('keeps automatic folder navigation waiting for its directory metadata', async () => {
    let release!: (value: Record<string, unknown>) => void;
    const gate = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve;
    });
    const view = await mount(() => gate, 'known-file-directory-control', {
      initialPath: 'src',
      knownFile: false,
    });
    try {
      expect(vi.mocked(view.command).mock.calls.some(([type]) => type === 'files.read')).toBe(
        false,
      );
      await act(async () =>
        release({ tree: [{ name: 'src', path: 'src', type: 'directory', children: [] }] }),
      );
      expect(vi.mocked(view.command).mock.calls.some(([type]) => type === 'files.read')).toBe(
        false,
      );
      expect(view.host.textContent).toContain('src');
    } finally {
      await act(async () => release({ tree: [] }));
      await view.close();
    }
  });
  it('reports a refused file read rather than inventing report contents', async () => {
    let release!: (value: Record<string, unknown>) => void;
    const gate = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve;
    });
    const view = await mount(() => gate, 'known-file-read-refusal', {
      readError: 'Report file is unavailable',
    });
    try {
      expect(view.host.textContent).toContain('Report file is unavailable');
      expect(view.host.querySelector('.native-file-content')?.textContent).not.toContain(
        'Original measured report',
      );
    } finally {
      await act(async () => release({ tree: [] }));
      await view.close();
    }
  });
});
