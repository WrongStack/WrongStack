import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DeadCodeScanPanel } from '../../src/components/DeadCodeScanPanel/DeadCodeScanPanel';

const sendMessage = vi.fn();
const addMessage = vi.fn();

vi.mock('@/i18n', () => ({
  useAppTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${Object.values(vars).join(',')}` : key,
  }),
}));
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => ({ sendMessage }) }));
vi.mock('@/stores', () => ({
  useChatStore: { getState: () => ({ addMessage, setLoading: vi.fn() }) },
  useUIStore: { getState: () => ({ setCurrentView: vi.fn() }) },
}));
vi.mock('@/components/Toaster', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const SCAN = {
  projectRoot: '/p',
  findings: [
    {
      id: 'aaa',
      category: 'dead-export',
      confidence: 'high',
      file: 'src/lib.ts',
      line: 3,
      name: 'unusedFn',
      kind: 'function',
      reason: 'never imported',
      fix: 'remove-declaration',
    },
    {
      id: 'bbb',
      category: 'test-only-file',
      confidence: 'medium',
      file: 'src/only-tests.ts',
      reason: 'only tests',
      manualReason: 'tests import it',
    },
  ],
  byCategory: { 'dead-export': 1, 'test-only-file': 1 },
  warnings: [],
  stats: {
    files: 3,
    testFiles: 1,
    entryFiles: 1,
    reachableFiles: 2,
    exports: 2,
    parsedFiles: 3,
    cachedFiles: 0,
    durationMs: 10,
  },
};

const PLAN = {
  changes: [
    {
      file: 'src/lib.ts',
      action: 'edit',
      diff: '-export function unusedFn() {}',
      findingIds: ['aaa'],
    },
  ],
  planned: ['aaa'],
  skipped: [],
  notes: [],
};

let calls: Array<{ url: string; body: unknown }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
      if (url === '/api/deadcode/backups') return json({ backups: [] });
      if (url === '/api/deadcode/scan') return json(SCAN);
      if (url === '/api/deadcode/preview') return json(PLAN);
      if (url === '/api/deadcode/apply') {
        return json({
          ok: true,
          backupId: 'b1',
          changed: ['src/lib.ts'],
          deleted: [],
          rolledBack: false,
          verify: [],
          plan: PLAN,
          excluded: [],
          attempts: 1,
        });
      }
      return new Response('{}', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sendMessage.mockReset();
  addMessage.mockReset();
});

async function scan(): Promise<void> {
  render(<DeadCodeScanPanel />);
  await act(async () => {
    fireEvent.click(screen.getByText('activity:deadCode.scan'));
  });
  await screen.findByText('unusedFn');
}

it('previews, confirms inline, and applies only the fixable selection', async () => {
  await scan();
  fireEvent.click(screen.getByLabelText('dead-export unusedFn'));
  await act(async () => {
    fireEvent.click(screen.getByText('activity:deadCode.preview'));
  });
  expect(calls.find((c) => c.url === '/api/deadcode/preview')?.body).toEqual({ ids: ['aaa'] });
  expect(await screen.findByText('-export function unusedFn() {}')).toBeTruthy();
  // Nothing is written by a preview.
  expect(calls.some((c) => c.url === '/api/deadcode/apply')).toBe(false);

  fireEvent.click(screen.getByText('activity:deadCode.apply'));
  await act(async () => {
    fireEvent.click(screen.getByText('activity:deadCode.confirmApply'));
  });
  await waitFor(() => expect(calls.some((c) => c.url === '/api/deadcode/apply')).toBe(true));
  expect(calls.find((c) => c.url === '/api/deadcode/apply')?.body).toEqual({
    ids: ['aaa'],
    verify: 'typecheck',
  });
});

it('hands manual findings to the agent instead of applying them', async () => {
  await scan();
  // The medium-confidence manual finding is visible under the default filter.
  fireEvent.click(screen.getByLabelText('test-only-file src/only-tests.ts'));
  expect(screen.getByText('activity:deadCode.apply').closest('button')?.disabled).toBe(true);
  fireEvent.click(screen.getByText('activity:deadCode.sendToAgent'));
  expect(sendMessage).toHaveBeenCalledTimes(1);
  const prompt = String(sendMessage.mock.calls[0]?.[0]);
  expect(prompt).toContain('[bbb] test-only-file');
  expect(prompt).toContain('manual: tests import it');
  expect(addMessage).toHaveBeenCalledWith({ role: 'user', content: prompt });
});
