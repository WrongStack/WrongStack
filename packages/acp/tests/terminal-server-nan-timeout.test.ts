import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TerminalServer } from '../src/client/terminal-server.js';

describe('TerminalServer NaN commandTimeoutMs fallback (F1837)', () => {
  it('falls back to 5-minute default when commandTimeoutMs is NaN or non-positive', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-term-nan-'));
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const server = new TerminalServer({ projectRoot: dir, commandTimeoutMs: Number.NaN });
      const term = server.create({
        sessionId: 's1',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
      });
      await server.waitForExit(term.terminalId);
      server.dispose();
      expect(spy).toHaveBeenCalledWith(expect.any(Function), 5 * 60_000);
    } finally {
      spy.mockRestore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
