import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isExplanatoryText, SddInterviewDriver } from '../src/sdd-interview-driver.js';
import { SpecStore } from '../src/spec-store.js';
import { TaskGraphStore } from '../src/task-graph-store.js';

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeDriver() {
  const dir = tmp('sdd-gaps');
  const specStore = new SpecStore({ baseDir: path.join(dir, 'specs') });
  const graphStore = new TaskGraphStore({ baseDir: path.join(dir, 'graphs') });
  const driver = new SddInterviewDriver({
    specStore,
    graphStore,
    minQuestions: 1,
    maxQuestions: 3,
  });
  return { driver, specStore, graphStore, dir };
}

const SPEC_OUTPUT = [
  'Here is the spec:',
  '```json',
  JSON.stringify({
    title: 'OAuth login',
    overview: 'Add OAuth-based login with session management.',
    sections: [{ type: 'overview', title: 'Overview', content: 'OAuth login flow', level: 1 }],
    requirements: [
      {
        id: 'REQ-1',
        type: 'security',
        priority: 'critical',
        description: 'Verify OAuth tokens',
        acceptanceCriteria: ['tokens validated'],
      },
      {
        id: 'REQ-2',
        type: 'functional',
        priority: 'high',
        description: 'Persist sessions',
        acceptanceCriteria: [],
      },
    ],
  }),
  '```',
].join('\n');

describe('SddInterviewDriver — gap coverage', () => {
  describe('isExplanatoryText', () => {
    it('detects first-person conversational filler', () => {
      expect(isExplanatoryText("I'll start by examining the codebase.")).toBe(true);
      expect(isExplanatoryText('I will implement this feature.')).toBe(true);
      expect(isExplanatoryText('Let me check the existing tests first.')).toBe(true);
      expect(isExplanatoryText("Here's my plan for the implementation.")).toBe(true);
      expect(isExplanatoryText('Here is my plan.')).toBe(true);
      expect(isExplanatoryText("I'm going to build this step by step.")).toBe(true);
    });

    it('detects short non-plan text without periods', () => {
      // < 3 lines and no period
      expect(isExplanatoryText('Sounds good')).toBe(true);
      expect(isExplanatoryText('Sure, I can do that')).toBe(true);
      expect(isExplanatoryText('Of course')).toBe(true);
      expect(isExplanatoryText('Okay, let me start')).toBe(true);
      expect(isExplanatoryText('Ok, that makes sense')).toBe(true);
      expect(isExplanatoryText('No problem')).toBe(true);
    });

    it('returns false for structured plan text', () => {
      expect(
        isExplanatoryText(
          'Step 1: Create the auth middleware.\nStep 2: Add tests.\nStep 3: Deploy.',
        ),
      ).toBe(false);
      expect(
        isExplanatoryText(
          'The implementation plan involves creating a middleware layer that intercepts requests.',
        ),
      ).toBe(false);
    });
  });

  describe('trySaveImplementationPlan', () => {
    it('captures a prose plan preceding a JSON block', async () => {
      const { driver } = makeDriver();
      driver.start('OAuth login');
      await driver.ingestAgentOutput(SPEC_OUTPUT);
      // Advance to implementation phase
      await driver.approve(); // → implementation
      const implText = [
        'The implementation plan is as follows:',
        'We will build a middleware layer that handles JWT verification and session persistence.',
        'The middleware sits between the router and the controller, validating tokens on each request.',
        '```json',
        JSON.stringify([
          { title: 'Create middleware', description: 'JWT', type: 'feature', priority: 'high' },
        ]),
        '```',
      ].join('\n');
      const res = await driver.ingestAgentOutput(implText);
      expect(res.implementationDetected).toBe(true);
    });

    it('captures a long prose plan without JSON', async () => {
      const { driver } = makeDriver();
      driver.start('Feature');
      await driver.ingestAgentOutput(SPEC_OUTPUT);
      await driver.approve(); // → implementation
      const longPlan = [
        'The implementation plan involves creating a new authentication module.',
        'This module will handle OAuth token verification and session management.',
        'It integrates with the existing Express middleware stack.',
      ].join('\n');
      const res = await driver.ingestAgentOutput(longPlan);
      expect(res.implementationDetected).toBe(true);
    });

    it('does not capture explanatory filler as a plan', async () => {
      const { driver } = makeDriver();
      driver.start('Feature');
      await driver.ingestAgentOutput(SPEC_OUTPUT);
      await driver.approve(); // → implementation
      const res = await driver.ingestAgentOutput(
        "I'll start working on this now. Let me check the code.",
      );
      expect(res.implementationDetected).toBe(false);
    });

    it('returns false outside the implementation phase', async () => {
      const { driver } = makeDriver();
      driver.start('Feature');
      // Still in questioning phase — implementation not detected
      const res = await driver.ingestAgentOutput(SPEC_OUTPUT);
      expect(res.implementationDetected).toBe(false);
    });
  });

  describe('ensureTaskGraph', () => {
    it('generates a graph when approving into executing without prior tasks', async () => {
      const { driver } = makeDriver();
      driver.start('OAuth login');
      await driver.ingestAgentOutput(SPEC_OUTPUT);
      // No task array ingested — graph is null
      expect(driver.getGraph()).toBeNull();
      // Approve through to executing
      await driver.approve(); // → implementation
      await driver.approve(); // → task_review
      const { phase } = await driver.approve(); // → executing (ensureTaskGraph)
      expect(phase).toBe('executing');
      const graph = driver.getGraph();
      expect(graph).not.toBeNull();
    });

    it('returns the existing graph if one already exists', async () => {
      const { driver } = makeDriver();
      driver.start('OAuth login');
      await driver.ingestAgentOutput(SPEC_OUTPUT);
      const tasks = [
        '```json',
        JSON.stringify([{ title: 'Task 1', description: 'd', type: 'feature', priority: 'high' }]),
        '```',
      ].join('\n');
      await driver.ingestAgentOutput(tasks);
      const firstGraph = driver.getGraph();
      expect(firstGraph).not.toBeNull();
      // ensureTaskGraph returns the existing graph
      const result = await driver.ensureTaskGraph();
      expect(result?.id).toBe(firstGraph!.id);
    });

    it('returns null when no spec exists', async () => {
      const { driver } = makeDriver();
      driver.start('No spec');
      // No spec ingested
      const result = await driver.ensureTaskGraph();
      expect(result).toBeNull();
    });
  });

  describe('snapshot with graph', () => {
    it('includes board tasks and taskCount when a graph exists', async () => {
      const { driver } = makeDriver();
      driver.start('OAuth login');
      await driver.ingestAgentOutput(SPEC_OUTPUT);
      const tasks = [
        '```json',
        JSON.stringify([
          { title: 'Task 1', description: 'd', type: 'feature', priority: 'high' },
          { title: 'Task 2', description: 'd', type: 'test', priority: 'medium' },
        ]),
        '```',
      ].join('\n');
      await driver.ingestAgentOutput(tasks);
      const snap = driver.snapshot();
      expect(snap.taskCount).toBe(4);
      expect(snap.board).toBeDefined();
      expect(snap.board!.tasks.length).toBeGreaterThan(0);
      expect(snap.board!.columns.length).toBeGreaterThan(0);
    });
  });

  describe('loadExisting returns false', () => {
    it('returns false when no session file exists', async () => {
      const { driver } = makeDriver();
      const loaded = await driver.loadExisting();
      expect(loaded).toBe(false);
    });
  });

  describe('ingestAgentOutput — malformed payloads', () => {
    it('ignores invalid JSON arrays (not an array)', async () => {
      const { driver } = makeDriver();
      driver.start('OAuth');
      await driver.ingestAgentOutput(SPEC_OUTPUT);
      const res = await driver.ingestAgentOutput('```json\n{"not": "an array"}\n```');
      expect(res.tasksDetected).toBe(false);
    });

    it('ignores tasks with empty titles', async () => {
      const { driver } = makeDriver();
      driver.start('OAuth');
      await driver.ingestAgentOutput(SPEC_OUTPUT);
      const res = await driver.ingestAgentOutput(
        '```json\n' + JSON.stringify([{ title: '', description: 'bad' }]) + '\n```',
      );
      expect(res.tasksDetected).toBe(false);
    });

    it('ignores syntactically invalid task arrays', async () => {
      const { driver } = makeDriver();
      driver.start('OAuth');
      await driver.ingestAgentOutput(SPEC_OUTPUT);
      expect(driver.currentPrompt()).toBeTypeOf('string');
      const res = await driver.ingestAgentOutput('```json\n[invalid]\n```');
      expect(res.tasksDetected).toBe(false);
    });

    it('normalizes missing and unknown task fields and ignores stale dependencies', async () => {
      const { driver } = makeDriver();
      driver.start('OAuth');
      await driver.ingestAgentOutput(SPEC_OUTPUT);
      const res = await driver.ingestAgentOutput(
        `\`\`\`json
${JSON.stringify([
  {
    id: 'odd',
    title: 'Odd task',
    type: 'unknown',
    priority: 'urgent',
    estimateHours: 0,
    tags: ['one', 2],
    dependsOn: ['missing', 'odd'],
  },
])}
\`\`\``,
      );
      expect(res.tasksDetected).toBe(true);
      expect(driver.getTracker()?.getAllNodes()[0]).toMatchObject({
        description: '',
        type: 'feature',
        priority: 'medium',
        estimateHours: 2,
        tags: ['one', '2'],
      });
    });

    it('does not re-detect the spec once already set', async () => {
      const { driver } = makeDriver();
      driver.start('OAuth');
      await driver.ingestAgentOutput(SPEC_OUTPUT);
      // Second ingest of the same spec — specDetected should be false (already set)
      const res = await driver.ingestAgentOutput(SPEC_OUTPUT);
      expect(res.specDetected).toBe(false);
    });
  });
});
