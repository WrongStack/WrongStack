import { beforeEach, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/arg-parser.js';

const run = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ result: 'ok', iterations: 1, toolCalls: 0 }),
);
vi.mock('@wrongstack/acp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/acp')>()),
  runOneAcpTask: run,
}));
const { spawnACPAgent } = await import('../src/subcommands/handlers/acp-agents.js');
const renderer = { write: vi.fn(), writeInfo: vi.fn(), writeError: vi.fn() };
beforeEach(() => {
  run.mockClear();
  renderer.writeError.mockClear();
});
it('passes options removed by the global argument parser to the actual ACP runner', async () => {
  const parsed = parseArgs([
    'acp',
    'spawn',
    'fixture',
    '--acp-options={"engine":"deep","thought":"ultra"}',
    'Report configuration',
  ]);
  const status = await spawnACPAgent(parsed.positional.slice(2), {
    config: { acp: { agents: { fixture: { command: 'fixture' } } } },
    flags: parsed.flags,
    projectRoot: '/fixture',
    renderer,
  } as never);
  expect(status).toBe(0);
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({
      task: 'Report configuration',
      runtimeValues: { engine: 'deep', thought: 'ultra' },
    }),
  );
});
it('validates JSON options before opening an external agent', async () => {
  const parsed = parseArgs([
    'acp',
    'spawn',
    'fixture',
    '--acp-options={"thought":4}',
    'Report configuration',
  ]);
  expect(
    await spawnACPAgent(parsed.positional.slice(2), {
      config: {},
      flags: parsed.flags,
      renderer,
    } as never),
  ).toBe(1);
  expect(run).not.toHaveBeenCalled();
  expect(renderer.writeError).toHaveBeenCalledWith(expect.stringContaining('bounded strings'));
});
