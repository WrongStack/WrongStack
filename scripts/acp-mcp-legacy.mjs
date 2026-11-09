#!/usr/bin/env bun
/** Opt-in MCP handshake compatibility for ACP agents with legacy MCP clients. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export function wrapMcpServers(message, launcher, script) {
  if (!['session/new', 'session/load', 'session/resume'].includes(message?.method)) return message;
  if (!Array.isArray(message.params?.mcpServers)) return message;
  return {
    ...message,
    params: {
      ...message.params,
      mcpServers: message.params.mcpServers.map((server) =>
        server && !server.type && typeof server.command === 'string'
          ? {
              ...server,
              command: launcher,
              args: [script, '--server', '--', server.command, ...(server.args ?? [])],
            }
          : server,
      ),
    },
  };
}

export function legacyDiscoveryResponse(message) {
  if (message?.method !== 'server/discover' || message.id === undefined) return undefined;
  return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Use MCP initialize' } };
}

export async function runLegacyProxy(args) {
  const [mode, separator, command, ...childArgs] = args;
  if (!['--agent', '--server'].includes(mode) || separator !== '--' || !command) {
    throw new Error('Usage: acp-mcp-legacy.mjs <--agent|--server> -- <command> [args...]');
  }
  const child = spawn(command, childArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  child.stderr.pipe(process.stderr);
  child.stdin.on('error', () => {});
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      input.close();
      process.stdin.pause();
      resolve(code ?? 1);
    });
  });
  const stop = () => child.kill();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const write = (stream, line) =>
    new Promise((resolve, reject) => {
      stream.write(`${line}\n`, (error) => (error ? reject(error) : resolve()));
    });
  const forwardInput = async () => {
    for await (const line of input) {
      let output = line;
      try {
        const message = JSON.parse(line);
        const response = mode === '--server' ? legacyDiscoveryResponse(message) : undefined;
        if (response) {
          await write(process.stdout, JSON.stringify(response));
          continue;
        }
        if (mode === '--agent')
          output = JSON.stringify(
            wrapMcpServers(message, process.execPath, fileURLToPath(import.meta.url)),
          );
      } catch {
        /* Leave frame validation to the real client/server. */
      }
      await write(child.stdin, output);
    }
    child.stdin.end();
  };
  try {
    const [, code] = await Promise.all([
      forwardInput(),
      exited,
      (async () => {
        for await (const chunk of child.stdout)
          await new Promise((resolve, reject) => {
            process.stdout.write(chunk, (error) => (error ? reject(error) : resolve()));
          });
      })(),
    ]);
    return code;
  } finally {
    input.close();
    process.stdin.pause();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    child.kill();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await runLegacyProxy(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
