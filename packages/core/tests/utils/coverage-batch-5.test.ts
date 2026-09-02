import { describe, it, expect } from 'vitest';
import {
  compactToolDefinitionForWire,
  compactSchemaDescriptions,
  compactDescription,
  findSemanticBoundary,
} from '../../src/utils/tool-wire-compact.js';
import {
  normalizeToolResultRenderMode,
  resolveToolResultRenderMode,
  DEFAULT_TOOL_RESULT_RENDER_MODE,
  applyToolResultRenderModes,
  type ToolResultRenderModeRegistryLike,
} from '../../src/utils/tool-result-render-mode.js';
import {
  normalizeToolDescriptionMode,
  simplifyToolDescription,
  applyToolDescriptionModeToTool,
} from '../../src/utils/tool-description-mode.js';
import {
  computeTaskItemProgress,
  formatTaskProgress,
  formatTaskList,
  type TaskItem,
} from '../../src/utils/task-format.js';

// ── tool-wire-compact ──────────────────────────────────────────────────

describe('compactDescription', () => {
  it('returns short text unchanged (normalized)', () => {
    expect(compactDescription('hello world', 100)).toBe('hello world');
  });
  it('collapses whitespace', () => {
    expect(compactDescription('hello   world\n\n  foo', 100)).toBe('hello world foo');
  });
  it('truncates long text at semantic boundary (sentence)', () => {
    const long = 'This is a sentence. This is another one that should be cut off here.';
    const result = compactDescription(long, 30);
    expect(result).toContain('...');
    expect(result.length).toBeLessThanOrEqual(35);
  });
  it('truncates at word boundary when no sentence boundary available', () => {
    const long = 'oneword twoword threeword fourword fiveword sixword sevenword';
    const result = compactDescription(long, 30);
    expect(result).toContain('...');
  });
  it('handles maxChars <= 20 by hard slice', () => {
    expect(compactDescription('abcdefgh', 5)).toBe('abcde');
  });
});

describe('findSemanticBoundary', () => {
  it('finds sentence boundary', () => {
    const text = 'First. Second.';
    expect(findSemanticBoundary(text, 8)).toBe(6); // index 5 ". " + 1
  });
  it('falls back to comma', () => {
    const text = 'a, b, c, d, e, f';
    expect(findSemanticBoundary(text, 10)).toBe(11); // lastIndexOf(', ', 10) = 10 + 1
  });
  it('falls back to space', () => {
    const text = 'aaaaaa bbbb cccc';
    expect(findSemanticBoundary(text, 10)).toBeGreaterThanOrEqual(6);
  });
});

describe('compactSchemaDescriptions', () => {
  it('trims schema description fields', () => {
    const schema = {
      type: 'object',
      description: 'A'.repeat(200),
      properties: {
        foo: { type: 'string', description: 'B'.repeat(200) },
      },
    };
    const result = compactSchemaDescriptions(schema, 50);
    expect((result.description as string).length).toBeLessThanOrEqual(55);
    expect((result.properties!.foo!.description as string).length).toBeLessThanOrEqual(55);
  });
  it('handles non-object schema gracefully', () => {
    expect(compactSchemaDescriptions('not-object', 50)).toEqual({ type: 'object', properties: {} });
  });
});

describe('compactToolDefinitionForWire', () => {
  it('compacts name, description, and schema', () => {
    const tool = {
      name: 'myTool',
      description: 'A'.repeat(500),
      inputSchema: { type: 'object', description: 'B'.repeat(500) },
    };
    const result = compactToolDefinitionForWire(tool);
    expect(result.name).toBe('myTool');
    expect(result.description.length).toBeLessThanOrEqual(412);
  });
  it('caches on repeated calls with default options', () => {
    const tool = { name: 'cached', description: 'desc', inputSchema: {} };
    const r1 = compactToolDefinitionForWire(tool);
    const r2 = compactToolDefinitionForWire(tool);
    expect(r1).toBe(r2); // same object reference (cached)
  });
});

// ── tool-result-render-mode ────────────────────────────────────────────

describe('normalizeToolResultRenderMode', () => {
  it('accepts canonical extend', () => {
    expect(normalizeToolResultRenderMode('extend')).toBe('extend');
  });
  it('accepts synonyms for extend', () => {
    expect(normalizeToolResultRenderMode('extended')).toBe('extend');
    expect(normalizeToolResultRenderMode('full')).toBe('extend');
    expect(normalizeToolResultRenderMode('FULL')).toBe('extend');
  });
  it('accepts canonical simple', () => {
    expect(normalizeToolResultRenderMode('simple')).toBe('simple');
  });
  it('accepts synonyms for simple', () => {
    expect(normalizeToolResultRenderMode('short')).toBe('simple');
    expect(normalizeToolResultRenderMode('brief')).toBe('simple');
  });
  it('returns undefined for unknown', () => {
    expect(normalizeToolResultRenderMode('verbose')).toBeUndefined();
    expect(normalizeToolResultRenderMode(123)).toBeUndefined();
  });
});

describe('resolveToolResultRenderMode', () => {
  it('returns explicit mode when present', () => {
    expect(resolveToolResultRenderMode({ myTool: 'simple' }, 'myTool')).toBe('simple');
  });
  it('falls back to default when missing', () => {
    expect(resolveToolResultRenderMode(undefined, 'myTool')).toBe(DEFAULT_TOOL_RESULT_RENDER_MODE);
    expect(resolveToolResultRenderMode({}, 'myTool')).toBe(DEFAULT_TOOL_RESULT_RENDER_MODE);
  });
});

describe('applyToolResultRenderModes', () => {
  it('applies valid modes and reports missing tools', () => {
    const mockRegistry: ToolResultRenderModeRegistryLike = {
      get: (name) => (name === 'exists' ? ({ name } as never) : undefined),
      setResultRenderMode: (name: string) => name === 'exists',
    };
    const result = applyToolResultRenderModes(mockRegistry, {
      exists: 'simple',
      missing: 'short',
      invalid: 'verbose',
    });
    expect(result.applied).toBe(1);
    expect(result.missing).toEqual(['missing']);
  });
});

// ── tool-description-mode ──────────────────────────────────────────────

describe('normalizeToolDescriptionMode', () => {
  it('accepts canonical values and synonyms', () => {
    expect(normalizeToolDescriptionMode('extend')).toBe('extend');
    expect(normalizeToolDescriptionMode('full')).toBe('extend');
    expect(normalizeToolDescriptionMode('simple')).toBe('simple');
    expect(normalizeToolDescriptionMode('brief')).toBe('simple');
  });
  it('rejects unknown values', () => {
    expect(normalizeToolDescriptionMode('unknown')).toBeUndefined();
  });
});

describe('simplifyToolDescription', () => {
  it('returns short text unchanged', () => {
    expect(simplifyToolDescription('Short text.')).toBe('Short text.');
  });
  it('truncates to maxSentences', () => {
    const long = 'First sentence. Second sentence. Third sentence. Fourth.';
    // With small maxChars, the first sentence fills the budget
    const result = simplifyToolDescription(long, { maxSentences: 1, maxChars: 20 });
    expect(result).toBe('First sentence.');
  });
  it('truncates to maxChars at word boundary', () => {
    const long = 'This is a very long description that exceeds the character limit easily.';
    const result = simplifyToolDescription(long, { maxChars: 30 });
    expect(result).toContain('...');
    expect(result.length).toBeLessThanOrEqual(40);
  });
  it('collapses multiline to single line', () => {
    const multiline = 'Line one.\nLine two.\nLine three.';
    const result = simplifyToolDescription(multiline, { maxChars: 200 });
    expect(result).toContain('Line one. Line two. Line three.');
  });
});

describe('applyToolDescriptionModeToTool', () => {
  it('returns tool unchanged when mode is extend and no original exists', () => {
    const tool = { name: 't', description: 'desc', execute: () => {} } as never;
    const result = applyToolDescriptionModeToTool(tool, 'extend');
    expect(result).toBe(tool);
  });
  it('simplifies description in simple mode', () => {
    const tool = {
      name: 't',
      description: 'First sentence. Second sentence.',
      execute: (() => {}) as never,
    };
    const result = applyToolDescriptionModeToTool(tool, 'simple');
    expect(result.description.length).toBeLessThanOrEqual(tool.description.length);
    // Restoring to extend returns the original
    const restored = applyToolDescriptionModeToTool(result, 'extend');
    expect(restored.description).toBe('First sentence. Second sentence.');
  });
});

// ── task-format ────────────────────────────────────────────────────────

describe('computeTaskItemProgress', () => {
  it('computes progress for mixed tasks', () => {
    const tasks: TaskItem[] = [
      {
        id: '1',
        title: 'A',
        type: 'feature',
        priority: 'high',
        status: 'completed',
        createdAt: '',
        updatedAt: '',
        estimateHours: 2,
      },
      {
        id: '2',
        title: 'B',
        type: 'bugfix',
        priority: 'medium',
        status: 'pending',
        createdAt: '',
        updatedAt: '',
      },
      {
        id: '3',
        title: 'C',
        type: 'chore',
        priority: 'low',
        status: 'in_progress',
        createdAt: '',
        updatedAt: '',
        estimateHours: 1,
      },
      {
        id: '4',
        title: 'D',
        type: 'test',
        priority: 'critical',
        status: 'blocked',
        createdAt: '',
        updatedAt: '',
      },
      {
        id: '5',
        title: 'E',
        type: 'docs',
        priority: 'high',
        status: 'failed',
        createdAt: '',
        updatedAt: '',
      },
      {
        id: '6',
        title: 'F',
        type: 'refactor',
        priority: 'medium',
        status: 'review',
        createdAt: '',
        updatedAt: '',
      },
    ];
    const p = computeTaskItemProgress(tasks);
    expect(p.total).toBe(6);
    expect(p.completed).toBe(1);
    expect(p.pending).toBe(1);
    expect(p.inProgress).toBe(1);
    expect(p.blocked).toBe(1);
    expect(p.failed).toBe(1);
    expect(p.review).toBe(1);
    expect(p.percentComplete).toBe(17);
    expect(p.estimatedHours).toBe(3);
  });
  it('handles empty list', () => {
    const p = computeTaskItemProgress([]);
    expect(p.total).toBe(0);
    expect(p.percentComplete).toBe(0);
  });
});

describe('formatTaskProgress', () => {
  it('returns "No tasks." for empty list', () => {
    expect(formatTaskProgress([])).toBe('No tasks.');
  });
  it('renders progress bar for non-empty list', () => {
    const tasks: TaskItem[] = [
      {
        id: '1',
        title: 'A',
        type: 'feature',
        priority: 'high',
        status: 'completed',
        createdAt: '',
        updatedAt: '',
      },
    ];
    const result = formatTaskProgress(tasks);
    expect(result).toContain('Tasks');
    expect(result).toContain('100%');
    expect(result).toContain('done');
  });
});

describe('formatTaskList', () => {
  it('returns "No tasks." for empty list', () => {
    expect(formatTaskList([])).toBe('No tasks.');
  });
  it('groups tasks by status in order', () => {
    const tasks: TaskItem[] = [
      {
        id: '1',
        title: 'Active',
        type: 'feature',
        priority: 'high',
        status: 'in_progress',
        createdAt: '',
        updatedAt: '',
      },
      {
        id: '2',
        title: 'Done',
        type: 'bugfix',
        priority: 'medium',
        status: 'completed',
        createdAt: '',
        updatedAt: '',
      },
    ];
    const result = formatTaskList(tasks);
    expect(result).toContain('IN_PROGRESS');
    expect(result).toContain('COMPLETED');
    // In-progress appears before completed (status order)
    expect(result.indexOf('IN_PROGRESS')).toBeLessThan(result.indexOf('COMPLETED'));
  });
  it('shows assignee, deps, and estimate when present', () => {
    const tasks: TaskItem[] = [
      {
        id: '1',
        title: 'Task',
        type: 'feature',
        priority: 'critical',
        status: 'pending',
        createdAt: '',
        updatedAt: '',
        assignee: 'bot',
        dependsOn: ['dep1'],
        estimateHours: 4,
      },
    ];
    const result = formatTaskList(tasks);
    expect(result).toContain('@bot');
    expect(result).toContain('4h');
    expect(result).toContain('dep1');
  });
});
