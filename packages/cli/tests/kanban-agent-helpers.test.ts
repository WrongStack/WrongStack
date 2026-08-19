import { describe, expect, it } from 'vitest';
import {
  buildKanbanAgentPrompt,
  parseKanbanAgentFlags,
  splitCsv,
} from '../src/slash-commands/kanban-agent-helpers.js';

describe('kanban agent helpers', () => {
  it('parses long, short, equals, quoted, CSV, and positional arguments', () => {
    expect(
      parseKanbanAgentFlags([
        '',
        'task-1',
        '--provider=anthropic',
        '-m',
        'claude',
        '--name',
        '"Worker One"',
        '--role=reviewer',
        '--fallback-profile',
        'quality',
        '--fallback-models=a,b, ,c',
        '--tools',
        'read, write',
        '--caps=filesystem,network',
      ]),
    ).toEqual({
      target: 'task-1',
      flags: {
        provider: 'anthropic',
        model: 'claude',
        name: 'Worker One',
        role: 'reviewer',
        fallbackProfile: 'quality',
        fallbackModels: ['a', 'b', 'c'],
        tools: ['read', 'write'],
        allowedCapabilities: ['filesystem', 'network'],
      },
    });
  });

  it('supports alternate short and long forms and ignores missing flag values', () => {
    expect(
      parseKanbanAgentFlags([
        'task-2',
        '-p',
        'openai',
        '--model=gpt',
        '-n=Worker',
        '--fallback=fallback',
        '--capabilities',
        'shell',
        '--provider',
        '--unknown',
      ]),
    ).toEqual({
      target: 'task-2',
      flags: {
        provider: 'openai',
        model: 'gpt',
        name: 'Worker',
        fallbackProfile: 'fallback',
        allowedCapabilities: ['shell'],
      },
    });
  });

  it('splits and trims CSV values', () => {
    expect(splitCsv(' one, two ,,three ')).toEqual(['one', 'two', 'three']);
    expect(splitCsv('')).toEqual([]);
  });

  it('builds a complete task prompt with routing, dependencies, metrics, and boundaries', () => {
    const dependency = {
      id: 'dep-1',
      title: 'Dependency',
      status: 'completed',
    };
    const task = {
      id: 'task-1',
      title: 'Implement',
      status: 'todo',
      priority: 'high',
      description: 'Implement the feature',
      dependsOn: ['dep-1', 'missing'],
      successCriteria: [{ description: 'Tests pass' }],
      goalMetrics: [
        { name: 'coverage', current: 80, target: 100, unit: '%', status: 'behind' },
        { name: 'flaky', current: 1, target: 3, direction: 'at_most', status: 'met' },
        { name: 'unknown', status: 'unknown' },
      ],
      chain: {
        chainId: 'chain-1',
        order: 2,
        previousTaskId: 'task-0',
        nextTaskId: 'task-2',
      },
      labels: ['testing', 'coverage'],
      boundary: {
        enabled: true,
        mode: 'allowlist',
        allow: [{ access: 'write', kind: 'path', path: 'packages/cli' }],
      },
      assignment: {
        role: 'tester',
        provider: 'openai',
        model: 'gpt',
        fallbackProfile: 'quality',
        fallbackModels: ['fallback/model'],
      },
    };
    const board = {
      id: 'board-1',
      title: 'Board',
      tasks: [dependency, task],
      boundary: {
        enabled: true,
        mode: 'allowlist',
        allow: [{ access: 'read', kind: 'path', path: 'packages' }],
      },
    };

    const prompt = buildKanbanAgentPrompt(board as never, task as never, task.assignment as never);

    expect(prompt).toContain('Board: Board (board-1)');
    expect(prompt).toContain('Description:\nImplement the feature');
    expect(prompt).toContain('role: tester');
    expect(prompt).toContain('fallbackModels: fallback/model');
    expect(prompt).toContain('previous: task-0');
    expect(prompt).toContain('next: task-2');
    expect(prompt).toContain('- Dependency [completed] (dep-1)');
    expect(prompt).not.toContain('missing)');
    expect(prompt).toContain('- Tests pass');
    expect(prompt).toContain('- coverage: 80 / ≥ 100 % [behind]');
    expect(prompt).toContain('- flaky: 1 / ≤ 3 [met]');
    expect(prompt).toContain('- unknown: n/a [unknown]');
    expect(prompt).toContain('Labels: testing, coverage');
    expect(prompt).toContain('board allow read path:packages');
    expect(prompt).toContain('task allow write path:packages/cli');
  });

  it('omits every optional section from a minimal task prompt', () => {
    const task = {
      id: 'task-minimal',
      title: 'Minimal',
      status: 'todo',
      priority: 'normal',
    };
    const board = {
      id: 'board-minimal',
      title: 'Minimal Board',
      tasks: [task],
    };

    const prompt = buildKanbanAgentPrompt(board as never, task as never, undefined);
    expect(prompt).not.toContain('Description:');
    expect(prompt).not.toContain('Routing hints:');
    expect(prompt).not.toContain('Task chain:');
    expect(prompt).not.toContain('Dependencies:');
    expect(prompt).not.toContain('Success criteria:');
    expect(prompt).not.toContain('Goal metrics:');
    expect(prompt).not.toContain('BOUNDARY CONTRACT');
  });
});
