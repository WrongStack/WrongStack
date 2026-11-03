import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ serve: vi.fn() }));
vi.mock('../src/boot/short-circuit-hq.js', () => ({
  handleHqShortCircuit: mocks.serve,
}));
vi.mock('../src/boot.js', () => ({ boot: vi.fn() }));

import { main } from '../src/cli-entry-main.js';
import { ReadlineInputReader } from '../src/input-reader.js';

let stdinTty: PropertyDescriptor | undefined;
let stdoutTty: PropertyDescriptor | undefined;

beforeEach(() => {
  stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(ReadlineInputReader.prototype, 'readLine')
    // Launch menu: 5 = HQ (1 TUI, 2 REPL, 3 WebUI, 4 VibeUI).
    .mockResolvedValueOnce('5')
    .mockResolvedValueOnce('3499')
    .mockResolvedValueOnce('0.0.0.0');
  mocks.serve.mockReset();
});

afterEach(() => {
  if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
  if (stdoutTty) Object.defineProperty(process.stdout, 'isTTY', stdoutTty);
  else Reflect.deleteProperty(process.stdout, 'isTTY');
  vi.restoreAllMocks();
});

describe('HQ launch menu startup output', () => {
  it('prints connection details while HQ is running, before shutdown', async () => {
    const log = console.log;
    const warn = console.warn;
    const stderr = process.stderr.write;
    let shutdown!: () => void;
    let started!: (flags: unknown) => void;
    const ready = new Promise<unknown>((resolve) => {
      started = resolve;
    });
    const lifetime = new Promise<number>((resolve) => {
      shutdown = () => resolve(0);
    });
    mocks.serve.mockImplementation(async (flags) => {
      console.warn(JSON.stringify({ level: 'warn', event: 'hq.insecure_exposure' }));
      process.stderr.write(`${JSON.stringify({ level: 'info', event: 'hq.startup' })}\n`);
      console.log('WrongStack HQ listening on http://127.0.0.1:3499/');
      console.log('Browser endpoint: http://127.0.0.1:3499/#bootstrap=test');
      console.log('Client endpoint: ws://127.0.0.1:3499/ws/client?token=test');
      started(flags);
      return lifetime;
    });

    let exited = false;
    const running = main([]).then((code) => {
      exited = true;
      return code;
    });
    try {
      const flags = await Promise.race([
        ready,
        running.then(() => {
          throw new Error('CLI exited before the HQ server started');
        }),
      ]);
      expect(flags).toMatchObject({ hq: true, port: '3499', host: '0.0.0.0' });
      expect(exited).toBe(false);
      expect(log).toHaveBeenCalledWith('WrongStack HQ listening on http://127.0.0.1:3499/');
      expect(log).toHaveBeenCalledWith('Browser endpoint: http://127.0.0.1:3499/#bootstrap=test');
      expect(log).toHaveBeenCalledWith('Client endpoint: ws://127.0.0.1:3499/ws/client?token=test');
      expect(warn).toHaveBeenCalledOnce();
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('hq.startup'));
    } finally {
      shutdown();
      expect(await running).toBe(0);
    }
    expect(log).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledOnce();
  });
});
