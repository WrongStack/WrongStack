#!/usr/bin/env bun
/** Opt-in proxy for ACP agents that put a complete shell line in terminal/create.command. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

export function rewriteAgentMessage(message, shell, isExecutablePath = existsSync) {
  if (message?.method !== 'terminal/create') return message;
  const params = message.params;
  if (
    typeof params?.command !== 'string' ||
    (Array.isArray(params.args) && params.args.length > 0) ||
    !/[\s|&;<>()]/.test(params.command) ||
    isExecutablePath(params.command)
  ) {
    return message;
  }
  return {
    ...message,
    params: { ...params, command: shell, args: ['-c', params.command] },
  };
}

export async function runProxy(args) {
  const separator = args.indexOf('--');
  const shell = args[0] === '--shell' ? args[1] : undefined;
  const command = args[separator + 1];
  if (separator !== 2 || !shell || !existsSync(shell) || !command) {
    throw new Error(
      'Usage: acp-shell-compat.mjs --shell <absolute POSIX shell> -- <agent> [args...]',
    );
  }
  const child = spawn(command, args.slice(separator + 2), {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stderr.pipe(process.stderr);
  process.stdin.pipe(child.stdin);
  child.stdin.on('error', () => {}); // The agent can close stdin before the host closes its pipe.
  const forwardSignal = () => child.kill();
  process.once('SIGINT', forwardSignal);
  process.once('SIGTERM', forwardSignal);
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      let output = line;
      try {
        output = JSON.stringify(rewriteAgentMessage(JSON.parse(line), shell));
      } catch {
        // Preserve non-protocol diagnostics; the host owns frame validation.
      }
      await new Promise((resolve, reject) => {
        process.stdout.write(`${output}\n`, (error) => (error ? reject(error) : resolve()));
      });
    }
    return await exited;
  } finally {
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
    process.removeListener('SIGINT', forwardSignal);
    process.removeListener('SIGTERM', forwardSignal);
    child.kill();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await runProxy(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
