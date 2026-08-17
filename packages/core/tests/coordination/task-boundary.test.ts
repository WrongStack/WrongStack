import { describe, expect, it } from 'vitest';
import {
  composeBoundedTaskDescription,
  parseTaskBoundary,
  renderTaskBoundaryBlock,
  taskBoundarySchemaProperties,
} from '../../src/coordination/task-boundary.js';

/**
 * Unit tests for the hard task-boundary contract shared by `delegate` and
 * `assign_task`. The gate exists so a leader cannot hand a worker a brief
 * without explicit edges: a concrete `scope` sentence plus at least one
 * non-placeholder out-of-scope non-goal.
 */

describe('parseTaskBoundary', () => {
  it('accepts a concrete scope and non-goal list', () => {
    const out = parseTaskBoundary({
      scope: 'Fix the flaky login test in packages/core/tests/login.test.ts.',
      outOfScope: ['No dependency changes', 'Do not touch other tests'],
    });
    expect(out).toEqual({
      ok: true,
      boundary: {
        scope: 'Fix the flaky login test in packages/core/tests/login.test.ts.',
        outOfScope: ['No dependency changes', 'Do not touch other tests'],
      },
    });
  });

  it('trims whitespace and drops placeholder entries while keeping concrete ones', () => {
    const out = parseTaskBoundary({
      scope: '  Audit the parser module only.  ',
      outOfScope: ['  none  ', ' Do not edit files ', 'n/a'],
    });
    expect(out).toEqual({
      ok: true,
      boundary: {
        scope: 'Audit the parser module only.',
        outOfScope: ['Do not edit files'],
      },
    });
  });

  it('rejects a missing or too-short scope with a teaching error', () => {
    for (const scope of [undefined, '', '   ', 'fix']) {
      const out = parseTaskBoundary({ scope, outOfScope: ['No edits'] });
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error).toContain('`scope`');
        expect(out.hint).toBeTruthy();
      }
    }
  });

  it('rejects a missing or empty outOfScope array', () => {
    for (const outOfScope of [undefined, 'no edits', []]) {
      const out = parseTaskBoundary({
        scope: 'Fix the flaky login test in packages/core.',
        outOfScope,
      });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toContain('`outOfScope`');
    }
  });

  it('rejects an outOfScope list where every entry is a placeholder', () => {
    const out = parseTaskBoundary({
      scope: 'Fix the flaky login test in packages/core.',
      outOfScope: ['none', 'n/a', 'TBD', '-', 'see above'],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/placeholder/i);
  });

  it('rejects filler-grade non-goals (below the minimum length)', () => {
    const out = parseTaskBoundary({
      scope: 'Fix the flaky login test in packages/core.',
      outOfScope: ['x', '-', ''],
    });
    expect(out.ok).toBe(false);
  });
});

describe('renderTaskBoundaryBlock / composeBoundedTaskDescription', () => {
  it('renders a loud, delimited boundary block', () => {
    const block = renderTaskBoundaryBlock({
      scope: 'Parser module only.',
      outOfScope: ['Do not edit files', 'No dependency changes'],
    });
    expect(block).toContain('TASK BOUNDARY');
    expect(block).toContain('Scope (what this task covers):\nParser module only.');
    expect(block).toContain('- Do not edit files');
    expect(block).toContain('- No dependency changes');
  });

  it('composes objective first, boundary block after', () => {
    const description = composeBoundedTaskDescription('  Audit the parser.  ', {
      scope: 'Parser module only.',
      outOfScope: ['Do not edit files'],
    });
    expect(description.indexOf('Audit the parser.')).toBeLessThan(
      description.indexOf('TASK BOUNDARY'),
    );
    expect(description.startsWith('Audit the parser.')).toBe(true);
  });
});

describe('taskBoundarySchemaProperties', () => {
  it('declares scope as a string and outOfScope as an array with teaching descriptions', () => {
    expect(taskBoundarySchemaProperties['scope']).toMatchObject({ type: 'string' });
    expect(taskBoundarySchemaProperties['outOfScope']).toMatchObject({ type: 'array' });
    expect(String(taskBoundarySchemaProperties['scope']?.description)).toContain('REQUIRED');
    expect(String(taskBoundarySchemaProperties['outOfScope']?.description)).toContain('REQUIRED');
  });
});
