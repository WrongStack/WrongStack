import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  isDebugStreamEnabled,
  setDebugStreamEnabled,
  setDebugStreamCallback,
  pushDebugChunkStats,
  defaultDebugStreamCallback,
  type DebugStreamStats,
} from '../src/stream-debug-state';

describe('stream-debug-state', () => {
  // Reset module state between tests
  beforeEach(() => {
    setDebugStreamEnabled(false);
    setDebugStreamCallback(null);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('isDebugStreamEnabled', () => {
    it('defaults to false', () => {
      expect(isDebugStreamEnabled()).toBe(false);
    });

    it('returns true after enabling', () => {
      setDebugStreamEnabled(true);
      expect(isDebugStreamEnabled()).toBe(true);
    });

    it('returns false after disabling', () => {
      setDebugStreamEnabled(true);
      setDebugStreamEnabled(false);
      expect(isDebugStreamEnabled()).toBe(false);
    });
  });

  describe('setDebugStreamCallback', () => {
    it('is called when pushDebugChunkStats fires', () => {
      const cb = vi.fn();
      setDebugStreamEnabled(true);
      setDebugStreamCallback(cb);
      pushDebugChunkStats(100, 50);
      vi.advanceTimersByTime(250); // past THROTTLE_MS (200)
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          chunkCount: 1,
          lastChunkSize: 100,
          lastDeltaMs: 50,
          totalBytes: 100,
        }),
      );
    });

    it('flushes pending stats before swapping callback', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      setDebugStreamEnabled(true);
      setDebugStreamCallback(cb1);
      pushDebugChunkStats(50, 10);
      // Don't advance time — swap before flush
      setDebugStreamCallback(cb2);
      vi.advanceTimersByTime(300);
      expect(cb1).toHaveBeenCalledTimes(1); // cb1 got the pending flush
      expect(cb2).not.toHaveBeenCalled(); // cb2 got nothing (no new chunks)
    });

    it('accumulates stats across multiple pushDebugChunkStats calls', () => {
      const cb = vi.fn();
      setDebugStreamEnabled(true);
      setDebugStreamCallback(cb);
      pushDebugChunkStats(100, 50);
      pushDebugChunkStats(200, 100);
      vi.advanceTimersByTime(250);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          chunkCount: 2,
          lastChunkSize: 200,
          lastDeltaMs: 100,
          totalBytes: 300,
        }),
      );
    });

    it('returns early when disabled without calling callback', () => {
      const cb = vi.fn();
      setDebugStreamCallback(cb);
      pushDebugChunkStats(100, 50);
      vi.advanceTimersByTime(300);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('pushDebugChunkStats when disabled', () => {
    it('returns early without scheduling a flush', () => {
      const cb = vi.fn();
      setDebugStreamEnabled(false);
      setDebugStreamCallback(cb);
      pushDebugChunkStats(100, 50);
      vi.advanceTimersByTime(300);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('defaultDebugStreamCallback', () => {
    it('writes a formatted debug line to stderr', () => {
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const stats: DebugStreamStats = {
        chunkCount: 3,
        lastChunkSize: 1024,
        lastDeltaMs: 250,
        totalBytes: 4096,
        lastChunkAt: '2025-01-01T12:00:00.000Z',
      };
      defaultDebugStreamCallback(stats);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith(expect.stringContaining('[DEBUG-STREAM]'));
      expect(write).toHaveBeenCalledWith(expect.stringContaining('chunk #3'));
      expect(write).toHaveBeenCalledWith(expect.stringContaining('4.0KB'));
    });

    it('formats bytes under 1024 as B', () => {
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const stats: DebugStreamStats = {
        chunkCount: 0,
        lastChunkSize: 512,
        lastDeltaMs: 10,
        totalBytes: 512,
        lastChunkAt: '2025-01-01T12:00:00.000Z',
      };
      defaultDebugStreamCallback(stats);
      expect(write).toHaveBeenCalledWith(expect.stringContaining('512B'));
    });

    it('formats bytes >= 1MB with MB suffix', () => {
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const stats: DebugStreamStats = {
        chunkCount: 0,
        lastChunkSize: 1048576,
        lastDeltaMs: 10,
        totalBytes: 2097152,
        lastChunkAt: '2025-01-01T12:00:00.000Z',
      };
      defaultDebugStreamCallback(stats);
      expect(write).toHaveBeenCalledWith(expect.stringContaining('2.0MB'));
    });
  });
});
