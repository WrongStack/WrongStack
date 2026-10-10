#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bunTypecheckInvocation } from '../packages/tools/src/_bun-typechecker.ts';

try {
  const invocation = await bunTypecheckInvocation(process.cwd(), process.argv.slice(2), {
    cacheRoot: fileURLToPath(new URL('../.bun/typecheck/', import.meta.url)),
    onInstall: () =>
      console.error('[typecheck] Ensuring the required Bun checker (no tsc fallback).'),
  });
  const child = spawn(invocation.cmd, invocation.args, {
    cwd: invocation.cwd,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on('close', (code) => {
    process.exitCode = code ?? 1;
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
