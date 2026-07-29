import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubcommandDeps } from '../../src/subcommands/contracts.js';

const { createChronicleProjectAccess } = vi.hoisted(() => ({
  createChronicleProjectAccess: vi.fn(),
}));

vi.mock('@wrongstack/core/chronicle', () => ({ createChronicleProjectAccess }));

import { chronicleCmd } from '../../src/subcommands/handlers/chronicle.js';

afterEach(() => {
  vi.resetAllMocks();
});

describe('chronicle subcommand', () => {
  it(
    'reports synchronous gateway creation failures instead of rejecting',
    { timeout: 5_000 },
    async () => {
      createChronicleProjectAccess.mockImplementationOnce(() => {
        throw new Error('chronicle daemon unavailable');
      });
      const writeError = vi.fn();
      const deps = {
        projectRoot: '/project',
        userHome: '/home/test',
        renderer: { write: vi.fn(), writeError },
      } as unknown as SubcommandDeps;

      await expect(chronicleCmd(['query'], deps)).resolves.toBe(1);
      expect(writeError).toHaveBeenCalledWith('chronicle daemon unavailable\n');
    },
  );
});
