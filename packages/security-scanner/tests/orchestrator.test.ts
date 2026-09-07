import { describe, expect, it, vi } from 'vitest';
import type { ErrorHandler, RetryPolicy } from '../src/_compat-types.js';
import { SecurityScannerOrchestrator } from '../src/orchestrator.js';

const mockRetryPolicy = (): RetryPolicy =>
  ({
    shouldRetry: vi.fn().mockReturnValue(true),
    delayMs: vi.fn().mockReturnValue(10),
    maxAttempts: vi.fn().mockReturnValue(3),
  }) as never as RetryPolicy;

const mockErrorHandler = (): ErrorHandler =>
  ({
    classify: vi.fn().mockReturnValue({ kind: 'rate_limit', retryable: true }),
    recover: vi.fn().mockResolvedValue(null),
  }) as never as ErrorHandler;

describe('SecurityScannerOrchestrator', () => {
  describe('constructor', () => {
    it('accepts retryPolicy and errorHandler via constructor', () => {
      const retryPolicy = mockRetryPolicy();
      const errorHandler = mockErrorHandler();
      const orchestrator = new SecurityScannerOrchestrator(retryPolicy, errorHandler);
      expect(orchestrator).toBeDefined();
    });

    it('works without retryPolicy or errorHandler', () => {
      const orchestrator = new SecurityScannerOrchestrator();
      expect(orchestrator).toBeDefined();
    });
  });
});
