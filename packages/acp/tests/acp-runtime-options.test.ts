import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { acpRuntimeOptions, applyAcpRuntimeValues } from '../src/client/acp-runtime-options.js';
import { ACPSession } from '../src/client/acp-session.js';
import { runOneAcpTask } from '../src/integration/run-one-acp-task.js';

const sessions: ACPSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});
async function start(env = {}) {
  const session = await ACPSession.start({
    command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/runtime-config-agent.ts', import.meta.url))],
    projectRoot: process.cwd(),
    timeoutMs: 5000,
    env,
  });
  sessions.push(session);
  await session.openSession();
  return session;
}
describe('ACP runtime configuration over real stdio', () => {
  it('accepts acknowledged config updates delivered as session notifications', async () => {
    const session = await start({ ACP_NOTIFY_ONLY: '1' });
    await applyAcpRuntimeValues(session, { engine: 'deep', thought: 'ultra' });
    expect(session.getConfigOptions().map((x) => x.currentValue)).toEqual(['deep', 'ultra']);
  });
  it('runs a real subagent prompt using the selected internal model and effort', async () => {
    const result = await runOneAcpTask({
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/runtime-config-agent.ts', import.meta.url))],
      role: 'fixture',
      task: 'Report configuration',
      runtimeValues: { engine: 'deep', thought: 'ultra' },
      timeoutMs: 5000,
    });
    expect(result.result).toBe('deep/ultra');
  });
  it('applies the model before effort, refreshes vocabulary and restores the session baseline', async () => {
    const session = await start();
    expect(session.getConfigOptions().map((x) => x.id)).toEqual(['engine', 'thought']);
    const selected = await applyAcpRuntimeValues(session, { thought: 'ultra', engine: 'deep' });
    expect(selected.find((x) => x.id === 'thought')).toMatchObject({
      currentValue: 'ultra',
      options: [
        { value: 'high', name: 'high' },
        { value: 'ultra', name: 'ultra' },
      ],
    });
    await applyAcpRuntimeValues(session, {});
    expect(session.getConfigOptions().map((x) => x.currentValue)).toEqual(['fast', 'low']);
  });
  it('rejects unsupported effort and permission selectors and keeps independent sessions isolated', async () => {
    const session = await start();
    await expect(
      applyAcpRuntimeValues(session, { engine: 'deep', thought: 'medium' }),
    ).rejects.toThrow('does not offer');
    await expect(applyAcpRuntimeValues(session, { mode: 'all' })).rejects.toThrow(
      'does not advertise',
    );
    await applyAcpRuntimeValues(session, {});
    const other = await start();
    expect(other.getConfigOptions().map((x) => x.currentValue)).toEqual(['fast', 'low']);
  });
  it('requires the agent acknowledgement to match the selected value', async () => {
    const session = await start({ ACP_IGNORE_SETTING: '1' });
    await expect(applyAcpRuntimeValues(session, { thought: 'medium' })).rejects.toThrow(
      'did not confirm',
    );
  });
  it('flattens model groups and excludes non-model permission modes', () => {
    expect(
      acpRuntimeOptions([
        {
          id: 'model',
          category: 'model',
          name: 'Models',
          type: 'select',
          currentValue: 'a',
          options: [{ group: 'p', options: [{ value: 'a', name: 'A' }] }],
        },
        {
          id: 'mode',
          type: 'select',
          currentValue: 'all',
          options: [{ value: 'all', name: 'All' }],
        },
      ]),
    ).toMatchObject([{ id: 'model', options: [{ value: 'a', name: 'A' }] }]);
  });
});
