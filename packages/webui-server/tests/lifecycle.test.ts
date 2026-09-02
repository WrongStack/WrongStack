import { describe, it, expect, vi } from 'vitest';
import { createShutdown, registerShutdownHandlers } from '../src/server/lifecycle.js';

describe('lifecycle', () => {
  describe('createShutdown', () => {
    it('calls flushSession, closes clients and servers, then exits', async () => {
      const flushSession = vi.fn().mockResolvedValue(undefined);
      const clientsFn = vi.fn().mockReturnValue([{ close: vi.fn() }, { close: vi.fn() }]);
      const server1 = { close: vi.fn() };
      const server2 = { close: vi.fn() };
      const exit = vi.fn();
      const log = vi.fn();

      const shutdown = createShutdown({
        flushSession,
        clients: clientsFn,
        servers: [server1, server2],
        log,
        exit,
      });

      await shutdown();

      expect(log).toHaveBeenCalledWith('[WebUI] Shutting down...');
      expect(flushSession).toHaveBeenCalled();
      expect(clientsFn).toHaveBeenCalled();
      // Both client sockets closed
      for (const ws of clientsFn()) {
        expect(ws.close).toHaveBeenCalled();
      }
      expect(server1.close).toHaveBeenCalled();
      expect(server2.close).toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(0);
    });

    it('is idempotent — second call returns immediately', async () => {
      const flushSession = vi.fn().mockResolvedValue(undefined);
      const clientsFn = vi.fn().mockReturnValue([]);
      const exit = vi.fn();

      const shutdown = createShutdown({
        flushSession,
        clients: clientsFn,
        servers: [],
        exit,
        log: vi.fn(),
      });

      await shutdown();
      await shutdown();

      // flushSession and exit should only be called once
      expect(flushSession).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
    });

    it('handles flushSession error gracefully', async () => {
      const flushSession = vi.fn().mockRejectedValue(new Error('Session flush failed'));
      const log = vi.fn();
      const exit = vi.fn();

      const shutdown = createShutdown({
        flushSession,
        clients: () => [],
        servers: [],
        log,
        exit,
      });

      await shutdown();

      expect(log).toHaveBeenCalledWith('[WebUI] Error closing session: Session flush failed');
      expect(exit).toHaveBeenCalledWith(0);
    });

    it('handles flushSession non-Error rejection gracefully', async () => {
      const flushSession = vi.fn().mockRejectedValue('string error');
      const log = vi.fn();
      const exit = vi.fn();

      const shutdown = createShutdown({
        flushSession,
        clients: () => [],
        servers: [],
        log,
        exit,
      });

      await shutdown();

      expect(log).toHaveBeenCalledWith('[WebUI] Error closing session: string error');
      expect(exit).toHaveBeenCalledWith(0);
    });

    it('calls onShutdown when provided', async () => {
      const onShutdown = vi.fn().mockResolvedValue(undefined);
      const exit = vi.fn();

      const shutdown = createShutdown({
        flushSession: vi.fn().mockResolvedValue(undefined),
        clients: () => [],
        servers: [],
        onShutdown,
        log: vi.fn(),
        exit,
      });

      await shutdown();

      expect(onShutdown).toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(0);
    });

    it('handles onShutdown error gracefully', async () => {
      const onShutdown = vi.fn().mockRejectedValue(new Error('Cleanup failed'));
      const log = vi.fn();
      const exit = vi.fn();

      const shutdown = createShutdown({
        flushSession: vi.fn().mockResolvedValue(undefined),
        clients: () => [],
        servers: [],
        onShutdown,
        log,
        exit,
      });

      await shutdown();

      expect(log).toHaveBeenCalledWith('[WebUI] Error during shutdown cleanup: Cleanup failed');
      expect(exit).toHaveBeenCalledWith(0);
    });

    it('handles nullish server entries gracefully', async () => {
      const exit = vi.fn();

      const shutdown = createShutdown({
        flushSession: vi.fn().mockResolvedValue(undefined),
        clients: () => [],
        servers: [null, undefined, { close: vi.fn() }],
        log: vi.fn(),
        exit,
      });

      await shutdown();

      expect(exit).toHaveBeenCalledWith(0);
    });

    it('uses console.log by default when no log is provided', async () => {
      // We can't easily assert on console.log, but we can verify it doesn't throw
      const exit = vi.fn();

      const shutdown = createShutdown({
        flushSession: vi.fn().mockResolvedValue(undefined),
        clients: () => [],
        servers: [],
        exit,
      });

      await shutdown();
      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  describe('registerShutdownHandlers', () => {
    it('registers handlers on SIGINT and SIGTERM', () => {
      const processOn = vi.spyOn(process, 'on').mockImplementation(() => process);
      const processOff = vi.spyOn(process, 'off').mockImplementation(() => process);

      const unregister = registerShutdownHandlers({
        flushSession: vi.fn().mockResolvedValue(undefined),
        clients: () => [],
        servers: [],
      });

      expect(processOn).toHaveBeenCalledWith('SIGINT', expect.any(Function));
      expect(processOn).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

      // Unregister should remove them
      unregister();
      expect(processOff).toHaveBeenCalledWith('SIGINT', expect.any(Function));
      expect(processOff).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

      processOn.mockRestore();
      processOff.mockRestore();
    });
  });
});
