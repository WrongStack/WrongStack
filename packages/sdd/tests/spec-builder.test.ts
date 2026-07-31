import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Specification } from '@wrongstack/core/types/spec.js';
import { describe, expect, it, vi } from 'vitest';
import {
  AISpecBuilder,
  type AISpecPhase,
  type AISpecSession,
  type AISpecSessionPersistence,
} from '../src/spec-builder.js';
import type { SpecStore } from '../src/spec-store.js';

function mockStore(): SpecStore {
  const saved = new Map<string, Specification>();
  return {
    save: vi.fn(async (spec: Specification) => {
      saved.set(spec.id, spec);
    }),
    load: vi.fn(async (id: string) => saved.get(id) ?? null),
    list: vi.fn(async () => []),
    delete: vi.fn(async () => true),
    exists: vi.fn(async () => false),
    createDraft: vi.fn(async () => ({
      id: 'draft',
      title: '',
      version: '0.1.0',
      status: 'draft' as const,
      overview: '',
      sections: [],
      requirements: [],
      createdAt: 0,
      updatedAt: 0,
    })),
    update: vi.fn(async () => null),
  };
}

async function persistedBuilder(
  phase: AISpecPhase,
  overrides: Record<string, unknown> = {},
): Promise<{ builder: AISpecBuilder; directory: string; sessionPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'wrongstack-spec-builder-'));
  const sessionPath = join(directory, 'session.json');
  await writeFile(
    sessionPath,
    JSON.stringify({
      id: 'persisted-session',
      phase,
      title: 'Persisted session',
      userIntent: 'intent',
      projectContext: '',
      answers: [],
      questionCount: 0,
      approved: false,
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    }),
  );

  const builder = new AISpecBuilder({ store: mockStore(), sessionPath });
  expect(await builder.loadSession()).toBe(true);
  return { builder, directory, sessionPath };
}

describe('AISpecBuilder', () => {
  it('starts in questioning phase', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    expect(builder.getPhase()).toBe('questioning');
  });

  it('startSession sets title and intent', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('Auth System', 'Add OAuth2 login');
    const session = builder.getSession();
    expect(session.title).toBe('Auth System');
    expect(session.userIntent).toBe('Add OAuth2 login');
    expect(session.phase).toBe('questioning');
    expect(builder.getAIPrompt()).toContain('Intent: Add OAuth2 login');
  });

  it('getAIPrompt returns questioning prompt with budget info', () => {
    const builder = new AISpecBuilder({ store: mockStore(), minQuestions: 3, maxQuestions: 8 });
    builder.startSession('Test Feature');
    const prompt = builder.getAIPrompt();
    expect(prompt).toContain('SDD Spec Builder');
    expect(prompt).toContain('Test Feature');
    expect(prompt).toContain('Questioning');
    expect(prompt).toContain('remaining budget');
    expect(prompt).toContain('**Minimum required:** 3');
  });

  it('forces spec generation when the question budget is exhausted', () => {
    const builder = new AISpecBuilder({ store: mockStore(), minQuestions: 1, maxQuestions: 1 });
    builder.startSession('Test Feature');
    builder.addAnswer('Question?', 'Answer');

    expect(builder.getAIPrompt()).toContain(
      'You have reached the maximum question budget. Generate the spec NOW.',
    );
  });

  it('addAnswer increments question count', () => {
    const builder = new AISpecBuilder({ store: mockStore(), minQuestions: 2 });
    builder.startSession('Test');
    builder.addAnswer('What auth?', 'OAuth2');
    builder.addAnswer('Roles?', 'Admin/User');
    expect(builder.getSession().questionCount).toBe(2);
    expect(builder.hasMetMinimumQuestions()).toBe(true);
  });

  it('shouldContinueQuestioning returns false at max', () => {
    const builder = new AISpecBuilder({ store: mockStore(), maxQuestions: 3 });
    builder.startSession('Test');
    builder.addAnswer('Q1', 'A1');
    builder.addAnswer('Q2', 'A2');
    builder.addAnswer('Q3', 'A3');
    expect(builder.shouldContinueQuestioning()).toBe(false);
  });

  it('hasMetMinimumQuestions returns false below min', () => {
    const builder = new AISpecBuilder({ store: mockStore(), minQuestions: 5 });
    builder.startSession('Test');
    builder.addAnswer('Q1', 'A1');
    expect(builder.hasMetMinimumQuestions()).toBe(false);
  });

  it('setSpec moves to spec_review phase', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('Test');
    const spec: Specification = {
      id: 'test-id',
      title: 'Test',
      version: '0.1.0',
      status: 'draft',
      overview: 'Test overview',
      sections: [],
      requirements: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    builder.setSpec(spec);
    expect(builder.getPhase()).toBe('spec_review');
    expect(builder.getSession().spec).toBe(spec);
  });

  it('approve transitions through phases correctly', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('Test');
    const spec: Specification = {
      id: 'test-id',
      title: 'Test',
      version: '0.1.0',
      status: 'draft',
      overview: 'Test overview',
      sections: [],
      requirements: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    builder.setSpec(spec);
    expect(builder.getPhase()).toBe('spec_review');

    builder.approve(); // spec_review → implementation
    expect(builder.getPhase()).toBe('implementation');

    builder.setImplementation('Do stuff');
    expect(builder.getPhase()).toBe('task_review');

    builder.approve(); // task_review → executing
    expect(builder.getPhase()).toBe('executing');

    builder.approve(); // executing → done
    expect(builder.getPhase()).toBe('done');
  });

  it('approve throws if no spec generated in questioning phase', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('Test');
    expect(() => builder.approve()).toThrow('Cannot approve: no spec generated yet.');
  });

  it('supports every approve transition, including restored sessions', async () => {
    const spec = {
      id: 'restored-spec',
      title: 'Restored',
      version: '0.1.0',
      status: 'draft',
      overview: 'Overview',
      sections: [],
      requirements: [],
      createdAt: 1,
      updatedAt: 1,
    } satisfies Specification;
    const restored = await persistedBuilder('questioning', { spec });
    vi.spyOn(restored.builder, 'saveSession').mockResolvedValue();

    try {
      expect(restored.builder.approve()).toBe('spec_review');
      expect(restored.builder.approve()).toBe('implementation');
      expect(restored.builder.approve()).toBe('task_review');
      expect(restored.builder.approve()).toBe('executing');
      expect(restored.builder.getAIPrompt()).toContain('Task Execution');
      expect(restored.builder.approve()).toBe('done');
      expect(restored.builder.approve()).toBe('done');
    } finally {
      await rm(restored.directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['spec_review', 'No spec generated yet.'],
    ['implementation', 'No spec to implement.'],
  ] as const)(
    'renders the %s fallback when a restored session has no spec',
    async (phase, text) => {
      const restored = await persistedBuilder(phase);

      try {
        expect(restored.builder.getAIPrompt()).toBe(text);
      } finally {
        await rm(restored.directory, { recursive: true, force: true });
      }
    },
  );

  it('renders execution using the session title when a restored session has no spec', async () => {
    const restored = await persistedBuilder('executing');

    try {
      expect(restored.builder.getAIPrompt()).toContain('Feature: "Persisted session"');
    } finally {
      await rm(restored.directory, { recursive: true, force: true });
    }
  });

  it('renders task review without an implementation plan for a restored session', async () => {
    const restored = await persistedBuilder('task_review');

    try {
      expect(restored.builder.getAIPrompt()).toContain('No implementation plan yet.');
    } finally {
      await rm(restored.directory, { recursive: true, force: true });
    }
  });

  it('persists, loads, and deletes session state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wrongstack-spec-builder-'));
    const sessionPath = join(directory, 'nested', 'session.json');

    try {
      const builder = new AISpecBuilder({ store: mockStore(), sessionPath });
      builder.startSession('Saved', 'Intent');
      await builder.setTaskGraphId('graph-1');
      await builder.saveSession();

      const restored = new AISpecBuilder({ store: mockStore(), sessionPath });
      expect(await restored.loadSession()).toBe(true);
      expect(restored.getSession().title).toBe('Saved');
      expect(restored.getTaskGraphId()).toBe('graph-1');

      await restored.deleteSession();
      expect(await restored.loadSession()).toBe(false);
      await restored.deleteSession();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses a durable session adapter and surfaces authoritative read failures', async () => {
    let saved: AISpecSession | null = null;
    const persistence: AISpecSessionPersistence = {
      load: vi.fn(async () => saved),
      save: vi.fn(async (session) => {
        saved = structuredClone(session);
      }),
      delete: vi.fn(async () => {
        saved = null;
      }),
    };
    const builder = new AISpecBuilder({ store: mockStore(), sessionPersistence: persistence });
    builder.startSession('IPC session', 'shared state');
    await builder.saveSession();

    const restored = new AISpecBuilder({ store: mockStore(), sessionPersistence: persistence });
    expect(await restored.loadSession()).toBe(true);
    expect(restored.getSession()).toMatchObject({
      title: 'IPC session',
      userIntent: 'shared state',
    });
    await restored.deleteSession();
    expect(saved).toBeNull();

    const unavailable = new AISpecBuilder({
      store: mockStore(),
      sessionPersistence: {
        ...persistence,
        load: async () => {
          throw new Error('project daemon unavailable');
        },
      },
    });
    await expect(unavailable.loadSession()).rejects.toThrow('project daemon unavailable');
  });

  it('treats missing paths, invalid sessions, and persistence failures as best effort', async () => {
    const noPath = new AISpecBuilder({ store: mockStore() });
    await expect(noPath.saveSession()).resolves.toBeUndefined();
    expect(await noPath.loadSession()).toBe(false);
    await expect(noPath.deleteSession()).resolves.toBeUndefined();

    const directory = await mkdtemp(join(tmpdir(), 'wrongstack-spec-builder-'));
    const invalidPath = join(directory, 'invalid.json');
    const blockingFile = join(directory, 'file-parent');
    await writeFile(invalidPath, '{"title":""}');
    await writeFile(blockingFile, 'not a directory');

    try {
      const invalid = new AISpecBuilder({ store: mockStore(), sessionPath: invalidPath });
      expect(await invalid.loadSession()).toBe(false);

      await writeFile(invalidPath, 'not-json');
      expect(await invalid.loadSession()).toBe(false);

      const unwritable = new AISpecBuilder({
        store: mockStore(),
        sessionPath: join(blockingFile, 'session.json'),
      });
      await expect(unwritable.saveSession()).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('saveSpec persists to store', async () => {
    const store = mockStore();
    const builder = new AISpecBuilder({ store });
    builder.startSession('Test');
    const spec: Specification = {
      id: 'test-id',
      title: 'Test',
      version: '0.1.0',
      status: 'draft',
      overview: 'Test overview',
      sections: [],
      requirements: [
        {
          id: 'REQ-1',
          type: 'functional',
          priority: 'high',
          description: 'Implement the feature',
          acceptanceCriteria: [],
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    builder.setSpec(spec);
    await builder.saveSpec();
    expect(store.save).toHaveBeenCalledWith(spec);
  });

  it('saveSpec throws if no spec', async () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('Test');
    await expect(builder.saveSpec()).rejects.toThrow('No spec to save.');
  });

  it('extractJSON handles ```json blocks', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    const text = 'Here is the spec:\n```json\n{"title":"Test"}\n```\nDone.';
    const result = builder.extractJSON(text);
    expect(result).toBe('{"title":"Test"}');
  });

  it('extractJSON handles raw JSON objects', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    const text = 'The spec is: {"title":"Test","overview":"Hello"}';
    const result = builder.extractJSON(text);
    expect(result).toBe('{"title":"Test","overview":"Hello"}');
  });

  it('extractJSON returns null for no JSON', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    expect(builder.extractJSON('no json here')).toBeNull();
  });

  it('hasSpecInOutput detects JSON blocks', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    expect(builder.hasSpecInOutput('```json\n{"title":"T"}\n```')).toBe(true);
    expect(builder.hasSpecInOutput('no json')).toBe(false);
  });

  it('tryParseSpecFromOutput parses valid spec JSON', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('My Feature');
    const text = `Here's the spec:
\`\`\`json
{
  "title": "Auth System",
  "overview": "User authentication with OAuth2",
  "requirements": [
    {
      "id": "REQ-1",
      "type": "functional",
      "priority": "critical",
      "description": "User can login with OAuth2",
      "acceptanceCriteria": ["Login works"]
    }
  ]
}
\`\`\``;
    const spec = builder.tryParseSpecFromOutput(text);
    expect(spec).not.toBeNull();
    expect(spec!.title).toBe('Auth System');
    expect(spec!.requirements).toHaveLength(1);
    expect(spec!.requirements[0]!.priority).toBe('critical');
  });

  it('tryParseSpecFromOutput returns null for invalid JSON', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    expect(builder.tryParseSpecFromOutput('no json at all')).toBeNull();
  });

  it('parseSpecFromJSON normalizes missing fields', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('Fallback Title');
    const spec = builder.parseSpecFromJSON('{"overview":"minimal"}');
    expect(spec.title).toBe('Fallback Title');
    expect(spec.overview).toBe('minimal');
    expect(spec.requirements).toHaveLength(0);
    expect(spec.sections).toHaveLength(0);
  });

  it('parseSpecFromJSON throws on invalid JSON', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    expect(() => builder.parseSpecFromJSON('not json')).toThrow('Invalid JSON');
  });

  it('extractJSONArray handles code blocks', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    const text = 'Tasks:\n```json\n[{"title":"T1"},{"title":"T2"}]\n```';
    const result = builder.extractJSONArray(text);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed).toHaveLength(2);
  });

  it('getAIPrompt includes conversation history after answers', () => {
    const builder = new AISpecBuilder({ store: mockStore(), minQuestions: 1, maxQuestions: 5 });
    builder.startSession('Test');
    builder.addAnswer('What auth method?', 'OAuth2');
    const prompt = builder.getAIPrompt();
    expect(prompt).toContain('What auth method?');
    expect(prompt).toContain('OAuth2');
    expect(prompt).toContain('Conversation so far');
  });

  it('getAIPrompt for spec_review includes requirements', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('Test');
    const spec: Specification = {
      id: 'test-id',
      title: 'Auth',
      version: '0.1.0',
      status: 'draft',
      overview: 'Auth system',
      sections: [],
      requirements: [
        {
          id: 'REQ-1',
          type: 'security',
          priority: 'critical',
          description: 'Login',
          acceptanceCriteria: [],
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    builder.setSpec(spec);
    const prompt = builder.getAIPrompt();
    expect(prompt).toContain('Spec Review');
    expect(prompt).toContain('Login');
    expect(prompt).toContain('[critical]');
  });

  it('getAIPrompt for implementation phase includes instructions', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('Test');
    const spec: Specification = {
      id: 'test-id',
      title: 'Test',
      version: '0.1.0',
      status: 'draft',
      overview: 'Test',
      sections: [],
      requirements: [
        {
          id: 'REQ-1',
          type: 'functional',
          priority: 'high',
          description: 'Implement the feature',
          acceptanceCriteria: [],
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    builder.setSpec(spec);
    builder.approve(); // → implementation
    const prompt = builder.getAIPrompt();
    expect(prompt).toContain('Implementation Planning');
    expect(prompt).toContain('Architecture decisions');

    builder.setImplementation('Implement it');
    expect(builder.getAIPrompt()).toContain('Feature: "Test"');
  });

  it('projectContext is included in questioning prompt', () => {
    const builder = new AISpecBuilder({
      store: mockStore(),
      projectContext: 'Project: my-app\nDependencies: express, zod',
    });
    builder.startSession('Test');
    const prompt = builder.getAIPrompt();
    expect(prompt).toContain('Project Context');
    expect(prompt).toContain('express, zod');
  });

  it('setImplementation moves to task_review', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('Test');
    builder.setImplementation('Step 1: do stuff\nStep 2: more stuff');
    expect(builder.getPhase()).toBe('task_review');
    expect(builder.getSession().implementation).toContain('Step 1');
    expect(builder.getAIPrompt()).toContain('Step 1');
  });

  it('markDone moves to done phase', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('Test');
    builder.markDone();
    expect(builder.getPhase()).toBe('done');
    expect(builder.getAIPrompt()).toContain('completed');
  });

  // ── JSON extraction edge cases (extractJSON / tryParseSpecFromOutput / extractJSONArray)

  it('tryParseSpecFromOutput returns null when no JSON is present', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    expect(builder.tryParseSpecFromOutput('just some text, no JSON')).toBeNull();
  });

  it('tryParseSpecFromOutput returns null when JSON is malformed schema-wise', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    // Valid JSON but missing required fields → parseSpecFromJSON throws,
    // tryParseSpecFromOutput catches and returns null.
    expect(builder.tryParseSpecFromOutput('{"foo":"bar"}')).toBeNull();
  });

  it('extractJSONArray returns the array from a ```json fenced code block', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    const text = 'some intro\n```json\n[{"title":"a"},{"title":"b"}]\n```\noutro';
    const got = builder.extractJSONArray(text);
    expect(got).not.toBeNull();
    expect(JSON.parse(got!)).toEqual([{ title: 'a' }, { title: 'b' }]);
  });

  it('extractJSONArray falls back to a raw [..] pattern when no code block exists', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    const text = 'here are the tasks: [{"title":"x"}] and some more text';
    const got = builder.extractJSONArray(text);
    expect(JSON.parse(got!)).toEqual([{ title: 'x' }]);
  });

  it('extractJSONArray returns null when the bare [..] is not valid JSON', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    expect(builder.extractJSONArray('[not, json, here]')).toBeNull();
  });

  it('extractJSONArray returns null when the fenced block does not start with [', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    const text = '```json\n{"not": "an-array"}\n```';
    // Code block exists but content is {} — function falls through to the raw
    // [...] pattern (which doesn't match) and returns null.
    expect(builder.extractJSONArray(text)).toBeNull();
  });

  it('extractJSONArray returns null when input has no array at all', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    expect(builder.extractJSONArray('plain text only')).toBeNull();
  });

  // ── parseSpecFromJSON edge cases ──────────────────────────────────────────

  it('parseSpecFromJSON throws on invalid JSON', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    expect(() => builder.parseSpecFromJSON('not-json{')).toThrow(/Invalid JSON/);
  });

  it('parseSpecFromJSON throws when payload is not an object', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    expect(() => builder.parseSpecFromJSON('"string"')).toThrow(/must be an object/);
    expect(() => builder.parseSpecFromJSON('null')).toThrow(/must be an object/);
    expect(() => builder.parseSpecFromJSON('42')).toThrow(/must be an object/);
  });

  it('parseSpecFromJSON throws when overview is missing', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    expect(() => builder.parseSpecFromJSON('{"title":"x"}')).toThrow(/must have an overview/);
  });

  it('parseSpecFromJSON normalizes unknown section types to "overview"', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    const spec = builder.parseSpecFromJSON(
      JSON.stringify({
        title: 'T',
        overview: 'O',
        sections: [
          { type: 'fancy-type', title: 'A', content: 'a' },
          { type: 'requirements', title: 'B', content: 'b', level: 2 },
        ],
      }),
    );
    expect(spec.sections[0].type).toBe('overview');
    expect(spec.sections[1].type).toBe('requirements');
    expect(spec.sections[1].level).toBe(2);
  });

  it('parseSpecFromJSON filters out non-object sections + requirements', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    const spec = builder.parseSpecFromJSON(
      JSON.stringify({
        overview: 'ok',
        sections: [null, 1, 'string', { title: 'real' }],
        requirements: [null, 'x', { description: 'real-req' }],
      }),
    );
    expect(spec.sections).toHaveLength(1);
    expect(spec.requirements).toHaveLength(1);
    expect(spec.requirements[0].description).toBe('real-req');
  });

  it('parseSpecFromJSON normalizes invalid type/priority to defaults', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    const spec = builder.parseSpecFromJSON(
      JSON.stringify({
        overview: 'ok',
        requirements: [{ description: 'r', type: 'invalid', priority: 'extreme' }],
      }),
    );
    expect(spec.requirements[0].type).toBe('functional');
    expect(spec.requirements[0].priority).toBe('medium');
  });

  it('parseSpecFromJSON normalizes omitted section and requirement fields', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    const spec = builder.parseSpecFromJSON(
      JSON.stringify({
        title: 'Defaults',
        overview: 'ok',
        sections: [{}],
        requirements: [{}],
      }),
    );

    expect(spec.sections[0]).toMatchObject({
      type: 'overview',
      title: '',
      content: '',
      level: 1,
    });
    expect(spec.requirements[0]).toMatchObject({
      id: 'REQ-1',
      type: 'functional',
      priority: 'medium',
      description: '',
      acceptanceCriteria: [],
    });
  });

  it('parseSpecFromJSON ignores non-array sections and requirements', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    const spec = builder.parseSpecFromJSON(
      JSON.stringify({ title: 'No arrays', overview: 'ok', sections: {}, requirements: {} }),
    );

    expect(spec.sections).toEqual([]);
    expect(spec.requirements).toEqual([]);
  });

  it('parseSpecFromJSON uses session.title when payload omits title', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('Session Title');
    const spec = builder.parseSpecFromJSON(JSON.stringify({ overview: 'ok' }));
    expect(spec.title).toBe('Session Title');
  });

  // ── extractJSON variants ───────────────────────────────────────────────────

  it('extractJSON pulls JSON from a ```json fenced block', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    expect(builder.extractJSON('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('extractJSON falls back to a generic ``` block when it starts with { or [', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    expect(builder.extractJSON('```\n{"a":2}\n```')).toBe('{"a":2}');
    // [ also accepted
    expect(builder.extractJSON('```\n[1,2,3]\n```')).toBe('[1,2,3]');
  });

  it('extractJSON ignores generic ``` block whose content is not JSON-like', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    // Falls through to raw JSON pattern — which also doesn't match → null
    expect(builder.extractJSON('```\nplain prose\n```')).toBeNull();
  });

  it('extractJSON finds raw JSON object embedded in prose', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    expect(builder.extractJSON('Here it is: {"a":3} and more')).toBe('{"a":3}');
  });

  it('extractJSON returns null when raw JSON match is unparseable', () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    expect(builder.extractJSON('text {not-json} more')).toBeNull();
  });

  // ── saveSpec ──────────────────────────────────────────────────────────────

  it('saveSpec throws when no spec is set on the session', async () => {
    const builder = new AISpecBuilder({ store: mockStore() });
    builder.startSession('x');
    await expect(builder.saveSpec()).rejects.toThrow(/No spec to save/);
  });

  it('saveSpec delegates to store.save when a spec is present', async () => {
    const store = mockStore();
    const builder = new AISpecBuilder({ store });
    builder.startSession('y');
    builder.setSpec(builder.parseSpecFromJSON(JSON.stringify({ title: 'T', overview: 'O' })));
    await builder.saveSpec();
    expect(store.save).toHaveBeenCalledOnce();
  });
});
