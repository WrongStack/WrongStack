#!/usr/bin/env bun
import { fileURLToPath } from 'node:url';
import { ensureBunTypechecker } from '../packages/tools/src/_bun-typechecker.ts';

try {
  const binary = await ensureBunTypechecker({
    cacheRoot: fileURLToPath(new URL('../.bun/typecheck/', import.meta.url)),
  });
  console.log(`Bun typechecker ready: ${binary}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
