import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted to top, so we use vi.hoisted for shared mock instances
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

vi.mock('@wrongstack/tools', () => ({
  getProcessRegistry: vi.fn(() => ({
    register: vi.fn(),
    unregister: vi.fn(),
  })),
}));

import { browserOpenCommand, openBrowser } from '../src/server/open-browser.js';

describe('open-browser', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  describe('browserOpenCommand', () => {
    it('returns start command for win32', () => {
      const cmd = browserOpenCommand('http://localhost:3456', 'win32');
      expect(cmd).toEqual({ command: 'cmd', args: ['/c', 'start', '', 'http://localhost:3456'] });
    });

    it('returns open command for darwin', () => {
      const cmd = browserOpenCommand('http://localhost:3456', 'darwin');
      expect(cmd).toEqual({ command: 'open', args: ['http://localhost:3456'] });
    });

    it('returns xdg-open for linux/other', () => {
      const cmd = browserOpenCommand('http://localhost:3456', 'linux');
      expect(cmd).toEqual({ command: 'xdg-open', args: ['http://localhost:3456'] });
    });

    it('defaults to current platform when platform not specified', () => {
      const cmd = browserOpenCommand('http://localhost:3456');
      expect(cmd.command).toBeDefined();
      expect(Array.isArray(cmd.args)).toBe(true);
    });
  });

  describe('openBrowser', () => {
    it('spawns a process with the correct command', () => {
      mockSpawn.mockReturnValue({
        on: vi.fn().mockReturnThis(),
        unref: vi.fn(),
        pid: 12345,
      });

      openBrowser('http://localhost:3456', 'linux');

      expect(mockSpawn).toHaveBeenCalledWith('xdg-open', ['http://localhost:3456'], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      });
    });

    it('handles spawn errors gracefully', () => {
      mockSpawn.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      expect(() => openBrowser('http://localhost:3456', 'linux')).not.toThrow();
    });

    it('registers on error handler and unrefs the child', () => {
      const mockOn = vi.fn().mockReturnThis();
      const mockUnref = vi.fn();
      mockSpawn.mockReturnValue({
        on: mockOn,
        unref: mockUnref,
        pid: 99999,
      });

      openBrowser('http://localhost:3456', 'win32');

      expect(mockSpawn).toHaveBeenCalledWith('cmd', ['/c', 'start', '', 'http://localhost:3456'], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      });
      expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockUnref).toHaveBeenCalled();
    });

    it('handles missing process pid (no registry registration)', () => {
      const mockOn = vi.fn().mockReturnThis();
      const mockUnref = vi.fn();
      mockSpawn.mockReturnValue({
        on: mockOn,
        unref: mockUnref,
        pid: undefined,
      });

      openBrowser('http://localhost:3456', 'darwin');

      expect(mockSpawn).toHaveBeenCalledWith('open', ['http://localhost:3456'], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      });
    });

    it('handles error event on child (async spawn failure)', () => {
      const mockOn = vi.fn().mockReturnThis();
      const mockUnref = vi.fn();
      mockSpawn.mockReturnValue({
        on: mockOn,
        unref: mockUnref,
        pid: 42,
      });

      openBrowser('http://localhost:3456', 'linux');

      // Get the error handler and call it
      const errorHandler = mockOn.mock.calls.find((c: any[]) => c[0] === 'error')?.[1];
      expect(errorHandler).toBeDefined();
      // Calling it should not throw
      expect(() => errorHandler()).not.toThrow();
    });
  });
});
