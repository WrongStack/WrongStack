import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  load: vi.fn(),
  storeOptions: [] as unknown[],
  resolveWstackPaths: vi.fn(() => ({ projectSessions: 'C:/sessions' })),
}));

vi.mock('@wrongstack/core/storage', () => ({
  ReplayLogStore: class {
    constructor(options: unknown) {
      mocks.storeOptions.push(options);
    }

    list() {
      return mocks.list();
    }

    load(sessionId: string) {
      return mocks.load(sessionId);
    }
  },
}));

vi.mock('@wrongstack/core/utils', () => ({
  color: {
    bold: (value: string) => value,
    cyan: (value: string) => value,
    dim: (value: string) => value,
    yellow: (value: string) => value,
  },
  resolveWstackPaths: mocks.resolveWstackPaths,
}));

import { replayCmd } from '../src/subcommands/handlers/replay.js';

function deps() {
  return {
    projectRoot: 'C:/repo',
    userHome: 'C:/user',
    renderer: {
      write: vi.fn(),
      writeError: vi.fn(),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.storeOptions.length = 0;
});

describe('replay subcommand', () => {
  it('prints an empty-state hint for --list', async () => {
    mocks.list.mockResolvedValue([]);
    const input = deps();

    await expect(replayCmd(['--list'], input as never)).resolves.toBe(0);
    expect(input.renderer.write).toHaveBeenCalledWith(
      'No replay logs recorded yet. Run with --record to start one.\n',
    );
    expect(mocks.resolveWstackPaths).toHaveBeenCalledWith({
      projectRoot: 'C:/repo',
      userHome: 'C:/user',
    });
    expect(mocks.storeOptions).toEqual([{ dir: 'C:/sessions' }]);
  });

  it('lists replay logs through the short flag', async () => {
    mocks.list.mockResolvedValue([
      { sessionId: 'a', entryCount: 2, path: 'C:/sessions/a.replay.jsonl' },
      { sessionId: 'b', entryCount: 1, path: 'C:/sessions/b.replay.jsonl' },
    ]);
    const input = deps();

    await expect(replayCmd(['-l'], input as never)).resolves.toBe(0);
    const output = String(input.renderer.write.mock.calls[0]?.[0]);
    expect(output).toContain('2 replay log(s)');
    expect(output).toContain('a  2 entries');
    expect(output).toContain('b  1 entries');
    expect(output).toContain('Inspect:  wstack replay <sessionId>');
  });

  it('prints usage and fails when no session is provided', async () => {
    const input = deps();

    await expect(replayCmd([], input as never)).resolves.toBe(1);
    expect(input.renderer.writeError).toHaveBeenCalledWith(
      expect.stringContaining('Usage: wstack replay <sessionId>'),
    );
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('reports a session with no recorded entries', async () => {
    mocks.load.mockResolvedValue([]);
    const input = deps();

    await expect(replayCmd(['missing'], input as never)).resolves.toBe(0);
    expect(mocks.load).toHaveBeenCalledWith('missing');
    expect(input.renderer.write).toHaveBeenCalledWith(
      expect.stringContaining('No replay entries recorded for session missing.'),
    );
  });

  it('prints the newest ten entries and the omitted count', async () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      ts: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
      hash: `${String(index).padStart(2, '0')}${'a'.repeat(30)}`,
      request: { model: `model-${index}` },
    }));
    mocks.load.mockResolvedValue(entries);
    const input = deps();

    await expect(replayCmd(['session-1'], input as never)).resolves.toBe(0);
    const output = String(input.renderer.write.mock.calls[0]?.[0]);
    expect(output).toContain('Replay log for session-1');
    expect(output).toContain('12 recorded request/response pair(s)');
    expect(output).not.toContain('model-0');
    expect(output).not.toMatch(/\smodel-1(?:\r?\n|$)/);
    expect(output).toContain('model-2');
    expect(output).toContain('model-11');
    expect(output).toContain('… and 2 more');
  });

  it('omits the overflow message for ten or fewer entries', async () => {
    mocks.load.mockResolvedValue([
      {
        ts: '2026-01-01T12:34:56.000Z',
        hash: 'abcdef0123456789abcdef',
        request: { model: 'model' },
      },
    ]);
    const input = deps();

    await replayCmd(['session-2'], input as never);
    const output = String(input.renderer.write.mock.calls[0]?.[0]);
    expect(output).toContain('12:34:56');
    expect(output).not.toContain('more');
  });
});
