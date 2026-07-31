import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFleetCommandHandlers } from '../src/wiring/fleet-command-handlers.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeHandlers(lines: string[]) {
  const fleetRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-fleet-log-'));
  roots.push(fleetRoot);
  const runDir = path.join(fleetRoot, 'subagents', 'run-1');
  await fs.mkdir(runDir, { recursive: true });
  const transcript = path.join(runDir, 'agent-1.jsonl');
  await fs.writeFile(transcript, `${lines.join('\n')}\n`);
  const multiAgentHost = {
    status: vi.fn().mockReturnValue({ live: [], completed: [], pending: [] }),
    ensureDirector: vi.fn().mockResolvedValue(null),
  };
  return {
    transcript,
    handlers: createFleetCommandHandlers({
      multiAgentHost: multiAgentHost as never,
      getDirector: () => null,
      events: {} as never,
      getSessionId: () => 'session',
      fleetRoot,
    }),
  };
}

describe('fleet log memory bounds', () => {
  it('streams transcript summaries without materializing the JSONL', async () => {
    const { handlers } = await makeHandlers([
      JSON.stringify({ type: 'user_input', content: 'fix the leak' }),
      JSON.stringify({ type: 'tool_use', name: 'grep' }),
      JSON.stringify({ type: 'llm_response', content: 'done' }),
    ]);

    await expect(handlers.onFleetLog?.('agent-1', 'summary')).resolves.toContain('3 events');
  });

  it('does not load oversized raw transcripts into chat history', async () => {
    const { handlers, transcript } = await makeHandlers([JSON.stringify({ type: 'user_input' })]);
    await fs.truncate(transcript, 2 * 1024 * 1024 + 1);

    const output = await handlers.onFleetLog?.('agent-1', 'raw');
    expect(output).toContain('refusing to load it into chat history');
    expect(output).toContain(transcript);
  });
});
