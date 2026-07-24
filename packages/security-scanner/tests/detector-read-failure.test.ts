import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  readdir: async () => [
    {
      name: 'package.json',
      isFile: () => true,
      isDirectory: () => false,
    },
    {
      name: 'package-lock.json',
      isFile: () => true,
      isDirectory: () => false,
    },
  ],
  readFile: async () => {
    throw new Error('manifest disappeared');
  },
}));

import { TechStackDetector } from '../src/detector.js';

describe('TechStackDetector manifest read races', () => {
  it('keeps the detected stack and uses empty dependencies', async () => {
    const result = await new TechStackDetector().detect('/virtual-project');
    expect(result.detectedStacks[0]).toMatchObject({
      stack: 'nodejs',
      packageManager: 'npm',
      dependencies: [],
    });
  });
});
