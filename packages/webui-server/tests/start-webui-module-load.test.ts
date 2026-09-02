import { describe, expect, it, vi } from 'vitest';

const { ensureSessionShell, resolvePorts } = vi.hoisted(() => ({
  ensureSessionShell: vi.fn(),
  resolvePorts: vi.fn().mockRejectedValue(new Error('stop before server startup')),
}));

vi.mock('@wrongstack/tools', () => ({ ensureSessionShell }));
vi.mock('../src/server/server-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/server-runtime.js')>()),
  resolvePorts,
}));

import { createStandaloneTodosCheckpointLifecycle, startWebUI } from '../src/server/start-webui.js';

describe('start-webui module', () => {
  it('enters startup but stops safely before booting services or binding sockets', async () => {
    expect(startWebUI).toBeTypeOf('function');
    expect(createStandaloneTodosCheckpointLifecycle).toBeTypeOf('function');

    await expect(startWebUI({ httpPort: 3456 })).rejects.toThrow('stop before server startup');
    expect(ensureSessionShell).toHaveBeenCalledOnce();
    expect(resolvePorts).toHaveBeenCalledWith({ httpPort: 3456 });
  });
});
