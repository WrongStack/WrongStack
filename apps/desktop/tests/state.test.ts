/**
 * Unit tests for state module - types and constants.
 */
import { describe, it, expect } from 'vitest';
import type {
  DesktopRuntimeRecord,
  DesktopWebuiPrefs,
  DesktopWebuiStatusSnapshot,
} from '../src/shared/types.js';
import {
  OPEN_EXTERNAL_ALLOWED_PROTOCOLS,
  SIDEBAR_WIDTH_WIDE,
  SIDEBAR_WIDTH_MEDIUM,
  SIDEBAR_WIDTH_NARROW,
  SIDEBAR_WIDTH_COLLAPSED,
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MAX_PENDING_WEBUI_COMMANDS,
  MAX_PENDING_FLUSH_ATTEMPTS,
  WEBUI_COMMAND_FALLBACK_MS,
  WEBUI_COMMAND_ACK_TIMEOUT_MS,
  WINDOW_STATE_SAVE_DEBOUNCE_MS,
  PENDING_WEBUI_FLUSH_DELAY_MS,
  LOG_NOTIFY_DEBOUNCE_MS,
} from '../src/main/state/constants.js';

// ============================================================================
// Constants Tests
// ============================================================================

describe('State constants', () => {
  describe('External protocol validation', () => {
    it('should allow http protocol', () => {
      expect(OPEN_EXTERNAL_ALLOWED_PROTOCOLS.has('http:')).toBe(true);
    });

    it('should allow https protocol', () => {
      expect(OPEN_EXTERNAL_ALLOWED_PROTOCOLS.has('https:')).toBe(true);
    });

    it('should allow mailto protocol', () => {
      expect(OPEN_EXTERNAL_ALLOWED_PROTOCOLS.has('mailto:')).toBe(true);
    });

    it('should not allow file protocol', () => {
      expect(OPEN_EXTERNAL_ALLOWED_PROTOCOLS.has('file:')).toBe(false);
    });

    it('should not allow javascript protocol', () => {
      expect(OPEN_EXTERNAL_ALLOWED_PROTOCOLS.has('javascript:')).toBe(false);
    });
  });

  describe('Window dimensions', () => {
    it('should have valid minimum window width', () => {
      expect(MIN_WINDOW_WIDTH).toBeGreaterThan(0);
      expect(MIN_WINDOW_WIDTH).toBeGreaterThanOrEqual(600);
    });

    it('should have valid minimum window height', () => {
      expect(MIN_WINDOW_HEIGHT).toBeGreaterThan(0);
      expect(MIN_WINDOW_HEIGHT).toBeGreaterThanOrEqual(400);
    });

    it('should have reasonable aspect ratio', () => {
      const ratio = MIN_WINDOW_WIDTH / MIN_WINDOW_HEIGHT;
      expect(ratio).toBeGreaterThan(1);
      expect(ratio).toBeLessThan(3);
    });
  });

  describe('Sidebar widths', () => {
    it('should have valid sidebar widths', () => {
      expect(SIDEBAR_WIDTH_WIDE).toBeGreaterThan(0);
      expect(SIDEBAR_WIDTH_MEDIUM).toBeGreaterThan(0);
      expect(SIDEBAR_WIDTH_NARROW).toBeGreaterThan(0);
      expect(SIDEBAR_WIDTH_COLLAPSED).toBeGreaterThan(0);
    });

    it('should have descending sidebar widths', () => {
      expect(SIDEBAR_WIDTH_WIDE).toBeGreaterThan(SIDEBAR_WIDTH_MEDIUM);
      expect(SIDEBAR_WIDTH_MEDIUM).toBeGreaterThan(SIDEBAR_WIDTH_NARROW);
      expect(SIDEBAR_WIDTH_NARROW).toBeGreaterThan(SIDEBAR_WIDTH_COLLAPSED);
    });

    it('should have collapsed width as smallest', () => {
      expect(SIDEBAR_WIDTH_COLLAPSED).toBeLessThan(100);
    });
  });

  describe('WebUI command limits', () => {
    it('should have reasonable pending command limit', () => {
      expect(MAX_PENDING_WEBUI_COMMANDS).toBeGreaterThan(0);
      expect(MAX_PENDING_WEBUI_COMMANDS).toBeLessThan(1000);
    });

    it('should have reasonable flush attempt limit', () => {
      expect(MAX_PENDING_FLUSH_ATTEMPTS).toBeGreaterThan(0);
      expect(MAX_PENDING_FLUSH_ATTEMPTS).toBeLessThan(500);
    });
  });

  describe('Timing constants', () => {
    it('should have valid command fallback timeout', () => {
      expect(WEBUI_COMMAND_FALLBACK_MS).toBeGreaterThan(0);
      expect(WEBUI_COMMAND_FALLBACK_MS).toBeLessThan(10000);
    });

    it('should have valid ACK timeout', () => {
      expect(WEBUI_COMMAND_ACK_TIMEOUT_MS).toBeGreaterThan(0);
      expect(WEBUI_COMMAND_ACK_TIMEOUT_MS).toBeLessThan(30000);
    });

    it('should have valid debounce timings', () => {
      expect(WINDOW_STATE_SAVE_DEBOUNCE_MS).toBeGreaterThan(0);
      expect(WINDOW_STATE_SAVE_DEBOUNCE_MS).toBeLessThan(5000);

      expect(PENDING_WEBUI_FLUSH_DELAY_MS).toBeGreaterThan(0);
      expect(PENDING_WEBUI_FLUSH_DELAY_MS).toBeLessThan(5000);

      expect(LOG_NOTIFY_DEBOUNCE_MS).toBeGreaterThan(0);
      expect(LOG_NOTIFY_DEBOUNCE_MS).toBeLessThan(5000);
    });
  });
});

// ============================================================================
// Mock Types for Testing
// ============================================================================

describe('State types', () => {
  it('should define DesktopRuntimeRecord interface shape', () => {
    const runtime: DesktopRuntimeRecord = {
      id: 'test-runtime-1',
      name: 'Test Runtime',
      root: '/test/project',
      slug: 'test-project',
      kind: 'project',
      status: 'running',
      httpPort: 34560,
      wsPort: 34660,
      url: 'http://localhost:34560',
      startedAt: '2024-01-01T00:00:00.000Z',
    };

    expect(runtime.id).toBeDefined();
    expect(runtime.name).toBeDefined();
    expect(runtime.status).toBeDefined();
  });

  it('should allow all runtime kinds', () => {
    const kinds: DesktopRuntimeRecord['kind'][] = ['project', 'agent', 'session'];

    for (const kind of kinds) {
      const runtime: DesktopRuntimeRecord = {
        id: `test-${kind}`,
        name: `Test ${kind}`,
        root: '/test',
        slug: 'test',
        kind,
        status: 'stopped',
        httpPort: 34560,
        wsPort: 34660,
        url: 'http://localhost:34560',
        startedAt: '2024-01-01T00:00:00.000Z',
      };
      expect(runtime.kind).toBe(kind);
    }
  });

  it('should define WebUI status snapshot', () => {
    const status: DesktopWebuiStatusSnapshot = {
      url: 'http://localhost:34560',
      ready: false,
      prefs: { theme: 'dark' },
      commandSequence: 0,
    };

    expect(status).toHaveProperty('url');
    expect(status).toHaveProperty('ready');
    expect(status).toHaveProperty('prefs');
  });
});

// ============================================================================
// Type Utility Functions
// ============================================================================

describe('Type utilities', () => {
  it('should create valid runtime record', () => {
    function createRuntime(overrides: Partial<DesktopRuntimeRecord> = {}): DesktopRuntimeRecord {
      return {
        id: 'runtime-1',
        name: 'Test Runtime',
        root: '/test/project',
        slug: 'test-project',
        kind: 'project',
        status: 'stopped',
        httpPort: 34560,
        wsPort: 34660,
        url: 'http://localhost:34560',
        startedAt: '2024-01-01T00:00:00.000Z',
        ...overrides,
      };
    }

    const running = createRuntime({ status: 'running' });
    expect(running.status).toBe('running');

    const error = createRuntime({ status: 'error' });
    expect(error.status).toBe('error');
  });

  it('should merge prefs correctly', () => {
    const defaultPrefs: DesktopWebuiPrefs = { theme: 'light' };
    const userPrefs: Partial<DesktopWebuiPrefs> = { theme: 'dark' };

    const merged: DesktopWebuiPrefs = { ...defaultPrefs, ...userPrefs };
    expect(merged.theme).toBe('dark');
  });

  it('should track command sequence', () => {
    let sequence = 0;
    function nextSequence(): number {
      return ++sequence;
    }

    expect(nextSequence()).toBe(1);
    expect(nextSequence()).toBe(2);
    expect(nextSequence()).toBe(3);
  });
});
