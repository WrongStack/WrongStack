#!/usr/bin/env bun
import { spawn } from 'node:child_process';

const command = process.env.WRONGSTACK_PI_REAL_COMMAND;
const extension = process.env.WRONGSTACK_PI_MCP_EXTENSION;
if (!command || !extension)
  throw new Error('Pi ACP MCP launcher needs explicit Pi command and extension paths');
const child = spawn(command, [...process.argv.slice(2), '-e', extension], {
  stdio: 'inherit',
  windowsHide: true,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill());
child.once('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.once('close', (code) => {
  process.exitCode = code ?? 1;
});
