import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/kernel/index.ts',
    'src/types/index.ts',
    'src/defaults/index.ts',
    'src/utils/index.ts',
    'src/utils/expect-defined.ts',
    'src/execution/prompt-enhancer.ts',
    // Domain entry points (new as of 0.2.0)
    'src/execution/index.ts',
    'src/coordination/index.ts',
    'src/storage/index.ts',
    'src/security/index.ts',
    'src/sdd/index.ts',
    'src/models/index.ts',
    'src/infrastructure/index.ts',
    'src/observability/index.ts',
    'src/tools/index.ts',
    'src/extension/index.ts',
    // Skill installer
    'src/skills/index.ts',
  ],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'es2023',
});
