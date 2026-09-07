import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

export default defineConfig({
  root: repoRoot,
  include: ['.temp_files/proof-driven-bug-hunter/round-1/proof.ts'],
  test: {
    globals: false,
    environment: 'node',
  },
});
