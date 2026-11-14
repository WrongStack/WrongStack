import type { spawn } from 'node:child_process';
import type { FullConfig } from '@playwright/test';

type ConfigWithServerProcess = FullConfig & {
  _serverProcess?: ReturnType<typeof spawn>;
};

/** Kill the WebUI server started by global-setup. */
export default async function globalTeardown(config: FullConfig): Promise<void> {
  const server = (config as ConfigWithServerProcess)._serverProcess;
  if (server && !server.killed && server.exitCode === null && server.signalCode === null) {
    server.once('exit', () => undefined); // ignore already-exited
    server.kill('SIGTERM');
    await new Promise<void>((r) => server.once('exit', () => r()));
  }
}
