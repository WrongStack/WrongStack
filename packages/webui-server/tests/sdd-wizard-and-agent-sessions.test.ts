import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEvent } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { buildSddWizardDeps } from '../src/server/sdd-wizard-wiring.js';
import { buildAgentSessionsPayload } from '../src/server/session-agent-sessions.js';

describe('session-agent-sessions', () => {
  it('returns empty array when events or load function are missing', async () => {
    expect(await buildAgentSessionsPayload(undefined, undefined)).toEqual([]);
    expect(await buildAgentSessionsPayload([], undefined)).toEqual([]);
    expect(await buildAgentSessionsPayload([{} as SessionEvent], undefined)).toEqual([]);
  });

  it('filters out leader agent and recovers gracefully when load throws', async () => {
    const events: SessionEvent[] = [
      {
        type: 'agent_spawned',
        agentId: 'leader',
        role: 'leader',
        ts: new Date().toISOString(),
      } as unknown as SessionEvent,
      {
        type: 'agent_spawned',
        agentId: 'worker-1',
        role: 'executor',
        ts: new Date().toISOString(),
      } as unknown as SessionEvent,
      {
        type: 'agent_session_linked',
        agentId: 'worker-1',
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
      } as unknown as SessionEvent,
    ];

    const loadFailing = vi.fn().mockRejectedValue(new Error('disk read failed'));
    const result = await buildAgentSessionsPayload(events, loadFailing);

    expect(result.length).toBe(1);
    expect(result[0]!.subagentId).toBe('worker-1');
    expect(result[0]!.role).toBe('executor');
    expect(result[0]!.provider).toBe('anthropic');
  });

  it('populates task and transcript from virtual session bodies', async () => {
    const events: SessionEvent[] = [
      {
        type: 'agent_spawned',
        agentId: 'worker-2',
        role: 'researcher',
        ts: new Date().toISOString(),
      } as unknown as SessionEvent,
      {
        type: 'agent_stopped',
        agentId: 'worker-2',
        ts: new Date().toISOString(),
      } as unknown as SessionEvent,
    ];

    const loadSuccess = vi.fn().mockResolvedValue([
      {
        subagentId: 'worker-2',
        agentName: 'Research Subagent',
        task: 'Survey the landscape',
        transcript: [
          {
            id: 'line-1',
            subagentId: 'worker-2',
            agentName: 'Research Subagent',
            ts: new Date().toISOString(),
            kind: 'tool_call',
            content: 'reading file',
            iteration: 1,
          },
        ],
      },
    ]);

    const result = await buildAgentSessionsPayload(events, loadSuccess);
    expect(result.length).toBe(1);
    expect(result[0]!.agentName).toBe('Research Subagent');
    expect(result[0]!.task).toBe('Survey the landscape');
    expect(result[0]!.transcript?.length).toBe(1);
  });
});

describe('sdd-wizard-wiring', () => {
  it('constructs SddWizardDeps, runs interview turns, and validates missing graphs', async () => {
    const testDir = join(tmpdir(), `sdd-wizard-test-${Date.now()}`);
    const mockAgent = {
      run: vi.fn().mockResolvedValue({ finalText: 'I have designed the spec.' }),
    };
    const mockSubagentFactory = vi.fn().mockResolvedValue({
      agent: mockAgent,
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    const wizardDeps = buildSddWizardDeps({
      agent: { ctx: { session: { id: 'test-sess' } } } as never,
      events: new EventEmitter() as never,
      projectRoot: testDir,
      paths: {
        projectDir: testDir,
        projectSpecs: join(testDir, 'specs'),
        projectTaskGraphs: join(testDir, 'graphs'),
        projectSddBoards: join(testDir, 'boards'),
      },
      subagentFactory: mockSubagentFactory as never,
    });

    expect(wizardDeps).toBeDefined();

    // ensureReady
    await wizardDeps.ensureReady?.();

    // makeDriver
    const driver = wizardDeps.makeDriver();
    expect(driver).toBeDefined();

    // runInterviewTurn
    const response = await wizardDeps.runInterviewTurn('Please create an authentication spec');
    expect(response).toBe('I have designed the spec.');
    expect(mockAgent.run).toHaveBeenCalled();

    // startRun without graph should throw ToolValidationError
    await expect(wizardDeps.startRun(driver, {})).rejects.toThrow(
      'No task graph to run — finish the interview first.',
    );

    // startRunFromGraphId with non-existent graph should throw ToolValidationError
    await expect(wizardDeps.startRunFromGraphId?.('graph-nonexistent-xyz', {})).rejects.toThrow(
      'Task graph not found: graph-nonexistent-xyz',
    );

    // resolveGraphIdForSpec
    const graphId = await wizardDeps.resolveGraphIdForSpec?.('spec-missing');
    expect(graphId).toBeNull();
  });
});
