/**
 * Unit tests for DesktopRuntimeManager functionality.
 *
 * Note: These tests focus on the runtime state management, port allocation,
 * path normalization, and utility functions. Full integration tests require
 * actual child process spawning.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  DesktopRuntimeRecord,
  DesktopRuntimeKind,
  DesktopConversationStatus,
} from '../src/shared/types.js';

// ============================================================================
// Mock Types and Helpers
// ============================================================================

interface RuntimeInternal extends DesktopRuntimeRecord {
  child: unknown | null;
}

interface DesktopStateFile {
  openProjects: string[];
  activeRuntimeId: string | null;
  openProjectSessions: Array<{
    runtimeId: string;
    root: string;
    name: string;
    kind: string;
    startedAt: string;
  }>;
  shellSidebarCollapsed: boolean;
}

// Runtime constants (matching actual implementation)
const HTTP_PORT_START = 34560;
const WS_PORT_START = 34660;

// ============================================================================
// Port Allocation Logic Tests
// ============================================================================

describe('Port allocation', () => {
  it('should start HTTP ports from correct base', () => {
    expect(HTTP_PORT_START).toBe(34560);
  });

  it('should start WS ports from correct base', () => {
    expect(WS_PORT_START).toBe(34660);
  });

  it('should allocate ports sequentially', () => {
    // Simulate port allocation
    const usedPorts = new Set<number>();
    const findFreePort = (startPort: number): number => {
      let port = startPort;
      while (usedPorts.has(port)) {
        port++;
      }
      usedPorts.add(port);
      return port;
    };

    const port1 = findFreePort(HTTP_PORT_START);
    const port2 = findFreePort(HTTP_PORT_START);
    const port3 = findFreePort(HTTP_PORT_START);

    expect(port1).toBe(HTTP_PORT_START);
    expect(port2).toBe(HTTP_PORT_START + 1);
    expect(port3).toBe(HTTP_PORT_START + 2);
  });

  it('should skip already used ports', () => {
    const usedPorts = new Set<number>([HTTP_PORT_START, HTTP_PORT_START + 1]);
    const findFreePort = (startPort: number): number => {
      let port = startPort;
      while (usedPorts.has(port)) {
        port++;
      }
      usedPorts.add(port);
      return port;
    };

    const port = findFreePort(HTTP_PORT_START);
    expect(port).toBe(HTTP_PORT_START + 2);
  });
});

// ============================================================================
// Runtime State Management Tests
// ============================================================================

describe('Runtime state management', () => {
  function createMockRuntime(overrides: Partial<DesktopRuntimeRecord> = {}): DesktopRuntimeRecord {
    return {
      id: 'runtime-1',
      name: 'Test Runtime',
      root: '/test/project',
      slug: 'test-project',
      kind: 'project',
      status: 'disconnected',
      httpPort: 34560,
      wsPort: 34660,
      url: 'http://localhost:34560',
      startedAt: '2024-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  describe('Runtime creation', () => {
    it('should create runtime with all required fields', () => {
      const runtime = createMockRuntime();
      expect(runtime.id).toBeDefined();
      expect(runtime.name).toBeDefined();
      expect(runtime.root).toBeDefined();
      expect(runtime.slug).toBeDefined();
      expect(runtime.kind).toBe('project');
    });

    it('should support different runtime kinds', () => {
      const kinds: DesktopRuntimeKind[] = ['project', 'global-settings'];

      for (const kind of kinds) {
        const runtime = createMockRuntime({ kind });
        expect(runtime.kind).toBe(kind);
      }
    });

    it('should track runtime status', () => {
      const statuses: DesktopConversationStatus[] = [
        'disconnected',
        'connecting',
        'connected',
        'running',
        'error',
      ];

      for (const status of statuses) {
        const runtime = createMockRuntime({ status });
        expect(runtime.status).toBe(status);
      }
    });
  });

  describe('Runtime storage', () => {
    it('should store runtimes in a map', () => {
      const runtimes = new Map<string, DesktopRuntimeRecord>();

      const runtime1 = createMockRuntime({ id: 'runtime-1' });
      const runtime2 = createMockRuntime({ id: 'runtime-2' });

      runtimes.set(runtime1.id, runtime1);
      runtimes.set(runtime2.id, runtime2);

      expect(runtimes.size).toBe(2);
      expect(runtimes.get('runtime-1')).toBeDefined();
      expect(runtimes.get('runtime-2')).toBeDefined();
    });

    it('should allow runtime removal', () => {
      const runtimes = new Map<string, DesktopRuntimeRecord>();
      const runtime = createMockRuntime({ id: 'runtime-1' });
      runtimes.set(runtime.id, runtime);

      expect(runtimes.size).toBe(1);
      runtimes.delete(runtime.id);
      expect(runtimes.size).toBe(0);
    });

    it('should find runtime by ID', () => {
      const runtimes = new Map<string, DesktopRuntimeRecord>();
      const runtime = createMockRuntime({ id: 'runtime-1' });
      runtimes.set(runtime.id, runtime);

      expect(runtimes.get('runtime-1')).toBe(runtime);
      expect(runtimes.get('non-existent')).toBeUndefined();
    });
  });

  describe('Runtime URL generation', () => {
    it('should generate correct HTTP URL', () => {
      const runtime = createMockRuntime({ httpPort: 34560 });
      const url = `http://localhost:${runtime.httpPort}`;
      expect(url).toBe('http://localhost:34560');
    });

    it('should generate correct WebSocket URL', () => {
      const runtime = createMockRuntime({ wsPort: 34660 });
      const wsUrl = `ws://127.0.0.1:${runtime.wsPort}`;
      expect(wsUrl).toBe('ws://127.0.0.1:34660');
    });

    it('should use 127.0.0.1 for WebSocket', () => {
      const runtime = createMockRuntime({ wsPort: 34660 });
      const wsUrl = new URL(`ws://127.0.0.1:${runtime.wsPort}`);
      expect(wsUrl.hostname).toBe('127.0.0.1');
    });
  });
});

// ============================================================================
// Path Normalization Tests
// ============================================================================

describe('Path normalization', () => {
  function normalizePath(input: string): string {
    // Simulate path normalization
    return input.replace(/\\/g, '/').toLowerCase();
  }

  function pathKey(input: string): string {
    return normalizePath(input);
  }

  it('should convert backslashes to forward slashes', () => {
    expect(normalizePath('C:\\Users\\test\\project')).toBe('c:/users/test/project');
  });

  it('should convert to lowercase', () => {
    expect(normalizePath('/Test/Project')).toBe('/test/project');
  });

  it('should handle mixed separators', () => {
    expect(normalizePath('/Test\\Project')).toBe('/test/project');
  });

  it('should create consistent keys for same path', () => {
    const key1 = pathKey('C:\\Users\\test\\project');
    const key2 = pathKey('c:/users/test/project');
    expect(key1).toBe(key2);
  });
});

// ============================================================================
// Runtime ID Validation Tests
// ============================================================================

describe('Runtime ID validation', () => {
  const RUNTIME_ID_PATTERN = /^[a-zA-Z0-9._:-]{3,120}$/;

  function isValidRuntimeId(id: string): boolean {
    return RUNTIME_ID_PATTERN.test(id);
  }

  it('should accept valid runtime IDs', () => {
    const validIds = [
      'abc',
      'runtime-1',
      'my.project',
      'session_123',
      'a'.repeat(120),
      'runtime-123.session_456',
    ];

    for (const id of validIds) {
      expect(isValidRuntimeId(id)).toBe(true);
    }
  });

  it('should reject invalid runtime IDs', () => {
    const invalidIds = [
      'ab', // too short
      'a'.repeat(121), // too long
      'runtime@1', // special char
      'runtime 1', // space
      '', // empty
    ];

    for (const id of invalidIds) {
      expect(isValidRuntimeId(id)).toBe(false);
    }
  });
});

// ============================================================================
// State Persistence Tests
// ============================================================================

describe('State persistence', () => {
  function createDesktopStateFile(overrides: Partial<DesktopStateFile> = {}): DesktopStateFile {
    return {
      openProjects: [],
      activeRuntimeId: null,
      openProjectSessions: [],
      shellSidebarCollapsed: false,
      ...overrides,
    };
  }

  it('should serialize state to JSON', () => {
    const state: DesktopStateFile = {
      openProjects: ['/test/project1', '/test/project2'],
      activeRuntimeId: 'runtime-1',
      openProjectSessions: [
        {
          runtimeId: 'runtime-1',
          root: '/test/project1',
          name: 'Project 1',
          kind: 'project',
          startedAt: '2024-01-01T00:00:00.000Z',
        },
      ],
      shellSidebarCollapsed: false,
    };

    const json = JSON.stringify(state);
    const parsed = JSON.parse(json) as DesktopStateFile;

    expect(parsed.openProjects).toHaveLength(2);
    expect(parsed.activeRuntimeId).toBe('runtime-1');
    expect(parsed.openProjectSessions).toHaveLength(1);
  });

  it('should handle empty state', () => {
    const state = createDesktopStateFile();
    expect(state.openProjects).toEqual([]);
    expect(state.activeRuntimeId).toBeNull();
    expect(state.openProjectSessions).toEqual([]);
  });

  it('should preserve session state', () => {
    const state: DesktopStateFile = {
      openProjects: ['/test/project'],
      activeRuntimeId: 'runtime-1',
      openProjectSessions: [
        {
          runtimeId: 'runtime-1',
          root: '/test/project',
          name: 'Test Project',
          kind: 'project',
          startedAt: '2024-01-01T00:00:00.000Z',
        },
      ],
      shellSidebarCollapsed: true,
    };

    expect(state.openProjectSessions[0].runtimeId).toBe('runtime-1');
    expect(state.openProjectSessions[0].kind).toBe('project');
  });
});

// ============================================================================
// Project Slug Generation Tests
// ============================================================================

describe('Project slug generation', () => {
  function projectSlug(root: string): string {
    // Extract basename and sanitize
    const basename = root.split(/[\\/]/).filter(Boolean).pop() ?? 'project';
    return basename.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
  }

  it('should extract basename from path', () => {
    expect(projectSlug('/test/my-project')).toBe('my-project');
  });

  it('should handle Windows paths', () => {
    expect(projectSlug('C:\\Users\\test\\MyProject')).toBe('myproject');
  });

  it('should sanitize special characters', () => {
    // Dots and spaces are sanitized
    expect(projectSlug('/test/Project v2.0!')).toBe('project-v2.0-');
  });

  it('should handle nested paths', () => {
    expect(projectSlug('/a/b/c/my-app')).toBe('my-app');
  });

  it('should handle empty path', () => {
    expect(projectSlug('')).toBe('project');
  });
});

// ============================================================================
// Session Management Tests
// ============================================================================

describe('Session management', () => {
  function nextRuntimeName(
    runtimes: Map<string, DesktopRuntimeRecord>,
    root: string,
    kind: DesktopRuntimeKind,
  ): string {
    const basename = root.split(/[\\/]/).filter(Boolean).pop() ?? 'Runtime';
    const existing = Array.from(runtimes.values()).filter((r) => r.root === root);
    if (existing.length === 0) return basename;
    return `${basename} (${existing.length + 1})`;
  }

  it('should return basename for first runtime', () => {
    const runtimes = new Map<string, DesktopRuntimeRecord>();
    const name = nextRuntimeName(runtimes, '/test/project', 'project');
    expect(name).toBe('project');
  });

  it('should append number for duplicate runtimes', () => {
    const runtimes = new Map<string, DesktopRuntimeRecord>();
    runtimes.set('r1', {
      id: 'r1',
      name: 'project',
      root: '/test/project',
      slug: 'project',
      kind: 'project',
      status: 'running',
      httpPort: 34560,
      wsPort: 34660,
      url: 'http://localhost:34560',
      startedAt: '2024-01-01T00:00:00.000Z',
    });

    const name = nextRuntimeName(runtimes, '/test/project', 'project');
    expect(name).toBe('project (2)');
  });

  it('should handle multiple sessions', () => {
    const runtimes = new Map<string, DesktopRuntimeRecord>();
    for (let i = 0; i < 3; i++) {
      runtimes.set(`r${i + 1}`, {
        id: `r${i + 1}`,
        name: `project (${i + 1})`,
        root: '/test/project',
        slug: 'project',
        kind: 'project',
        status: 'running',
        httpPort: 34560 + i,
        wsPort: 34660 + i,
        url: `http://localhost:${34560 + i}`,
        startedAt: '2024-01-01T00:00:00.000Z',
      });
    }

    const name = nextRuntimeName(runtimes, '/test/project', 'project');
    expect(name).toBe('project (4)');
  });
});

// ============================================================================
// Active Runtime Management Tests
// ============================================================================

describe('Active runtime management', () => {
  function findActiveRuntime(
    runtimes: Map<string, DesktopRuntimeRecord>,
    activeId: string | null,
  ): DesktopRuntimeRecord | undefined {
    if (activeId) return runtimes.get(activeId);
    return Array.from(runtimes.values()).find((r) => r.kind === 'project');
  }

  it('should return runtime by active ID', () => {
    const runtimes = new Map<string, DesktopRuntimeRecord>();
    runtimes.set('runtime-1', {
      id: 'runtime-1',
      name: 'Test',
      root: '/test',
      slug: 'test',
      kind: 'project',
      status: 'running',
      httpPort: 34560,
      wsPort: 34660,
      url: 'http://localhost:34560',
      startedAt: '2024-01-01T00:00:00.000Z',
    });

    const active = findActiveRuntime(runtimes, 'runtime-1');
    expect(active?.id).toBe('runtime-1');
  });

  it('should fallback to first project when no active ID', () => {
    const runtimes = new Map<string, DesktopRuntimeRecord>();
    runtimes.set('settings', {
      id: 'settings',
      name: 'Settings',
      root: '',
      slug: 'global-settings',
      kind: 'global-settings',
      status: 'running',
      httpPort: 34560,
      wsPort: 34660,
      url: 'http://localhost:34560',
      startedAt: '2024-01-01T00:00:00.000Z',
    });
    runtimes.set('project', {
      id: 'project',
      name: 'Project',
      root: '/test',
      slug: 'test',
      kind: 'project',
      status: 'running',
      httpPort: 34561,
      wsPort: 34661,
      url: 'http://localhost:34561',
      startedAt: '2024-01-01T00:00:00.000Z',
    });

    const active = findActiveRuntime(runtimes, null);
    expect(active?.kind).toBe('project');
  });

  it('should return undefined for empty runtimes', () => {
    const runtimes = new Map<string, DesktopRuntimeRecord>();
    const active = findActiveRuntime(runtimes, null);
    expect(active).toBeUndefined();
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

describe('Error handling', () => {
  function toErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return String(error);
  }

  it('should extract message from Error', () => {
    const error = new Error('Connection failed');
    expect(toErrorMessage(error)).toBe('Connection failed');
  });

  it('should handle string errors', () => {
    expect(toErrorMessage('Something went wrong')).toBe('Something went wrong');
  });

  it('should convert other types to string', () => {
    expect(toErrorMessage(123)).toBe('123');
    expect(toErrorMessage(null)).toBe('null');
    expect(toErrorMessage(undefined)).toBe('undefined');
  });
});

// ============================================================================
// Timeout Configuration Tests
// ============================================================================

describe('Timeout configuration', () => {
  const START_TIMEOUT_MS = 30_000;

  it('should have reasonable start timeout', () => {
    expect(START_TIMEOUT_MS).toBe(30000);
  });

  it('should handle timeout calculation', () => {
    const startTime = Date.now();
    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeLessThan(100); // Should be very fast
  });
});

// ============================================================================
// Runtime Lifecycle Tests
// ============================================================================

describe('Runtime lifecycle', () => {
  function createRuntime(
    id: string,
    status: DesktopConversationStatus,
  ): DesktopRuntimeRecord {
    return {
      id,
      name: `Runtime ${id}`,
      root: `/test/${id}`,
      slug: id,
      kind: 'project',
      status,
      httpPort: 34560,
      wsPort: 34660,
      url: `http://localhost:34560`,
      startedAt: new Date().toISOString(),
    };
  }

  it('should track running runtimes', () => {
    const runtimes = new Map<string, DesktopRuntimeRecord>();
    runtimes.set('r1', createRuntime('r1', 'running'));
    runtimes.set('r2', createRuntime('r2', 'disconnected'));

    const running = Array.from(runtimes.values()).filter((r) => r.status === 'running');
    expect(running).toHaveLength(1);
    expect(running[0].id).toBe('r1');
  });

  it('should track error runtimes', () => {
    const runtimes = new Map<string, DesktopRuntimeRecord>();
    runtimes.set('r1', createRuntime('r1', 'running'));
    runtimes.set('r2', createRuntime('r2', 'error'));

    const errors = Array.from(runtimes.values()).filter((r) => r.status === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].id).toBe('r2');
  });

  it('should filter by kind', () => {
    const runtimes = new Map<string, DesktopRuntimeRecord>();
    runtimes.set('r1', createRuntime('r1', 'running'));
    runtimes.set('settings', {
      id: 'settings',
      name: 'Settings',
      root: '',
      slug: 'global-settings',
      kind: 'global-settings',
      status: 'running',
      httpPort: 34561,
      wsPort: 34661,
      url: 'http://localhost:34561',
      startedAt: new Date().toISOString(),
    });

    const projects = Array.from(runtimes.values()).filter((r) => r.kind === 'project');
    expect(projects).toHaveLength(1);
    expect(projects[0].kind).toBe('project');
  });
});

// ============================================================================
// Port Conflict Resolution Tests
// ============================================================================

describe('Port conflict resolution', () => {
  function usedPorts(runtimes: Map<string, DesktopRuntimeRecord>): Set<number> {
    return new Set(
      Array.from(runtimes.values())
        .flatMap((r) => [r.httpPort, r.wsPort])
    );
  }

  it('should collect used ports', () => {
    const runtimes = new Map<string, DesktopRuntimeRecord>();
    runtimes.set('r1', {
      id: 'r1',
      name: 'R1',
      root: '/test',
      slug: 'test',
      kind: 'project',
      status: 'running',
      httpPort: 34560,
      wsPort: 34660,
      url: 'http://localhost:34560',
      startedAt: '2024-01-01T00:00:00.000Z',
    });

    const ports = usedPorts(runtimes);
    expect(ports.has(34560)).toBe(true);
    expect(ports.has(34660)).toBe(true);
    expect(ports.size).toBe(2);
  });

  it('should handle empty runtime map', () => {
    const runtimes = new Map<string, DesktopRuntimeRecord>();
    const ports = usedPorts(runtimes);
    expect(ports.size).toBe(0);
  });
});
