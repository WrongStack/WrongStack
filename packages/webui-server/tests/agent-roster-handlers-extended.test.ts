import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { AgentRosterWSHandler } from '../src/server/agent-roster-handlers.js';

describe('AgentRosterWSHandler Extended Coverage', () => {
  let projectRoot = '';
  let handler: AgentRosterWSHandler;
  const ws = {} as WebSocket;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wrongstack-roster-ext-'));
    handler = new AgentRosterWSHandler({ projectRoot: () => projectRoot });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('handles read-customization, update-config, and stats errors', async () => {
    // Missing role checks
    expect(await handler.handleMessage(ws, 'agent-roster.stats', {})).toEqual({
      type: 'agent-roster.stats',
      payload: { error: 'role required' },
    });
    expect(await handler.handleMessage(ws, 'agent-roster.read-customization', {})).toEqual({
      type: 'agent-roster.read-customization',
      payload: { error: 'role required' },
    });
    expect(await handler.handleMessage(ws, 'agent-roster.read-learned', {})).toEqual({
      type: 'agent-roster.read-learned',
      payload: { error: 'role required' },
    });
    expect(
      await handler.handleMessage(ws, 'agent-roster.update-config', { role: 'executor' }),
    ).toEqual({
      type: 'agent-roster.update-config',
      payload: { error: 'role and config required' },
    });

    // Valid update-config
    const updateRes = await handler.handleMessage(ws, 'agent-roster.update-config', {
      role: 'executor',
      config: { budget: { timeoutMs: 5000 } },
    });
    expect((updateRes.payload as { success: boolean }).success).toBe(true);

    // Read customization
    const customRes = await handler.handleMessage(ws, 'agent-roster.read-customization', {
      role: 'executor',
    });
    expect((customRes.payload as { role: string }).role).toBe('executor');
  });

  it('handles agent-roster.create with validations', async () => {
    // Missing required fields
    const res1 = await handler.handleMessage(ws, 'agent-roster.create', {
      name: 'Custom',
      purpose: '',
      taskTypes: [],
    });
    expect((res1.payload as { error: string }).error).toContain('required');

    // Built-in role collision
    const res2 = await handler.handleMessage(ws, 'agent-roster.create', {
      name: 'Executor',
      role: 'executor',
      purpose: 'Do tasks',
      taskTypes: ['feature'],
    });
    expect((res2.payload as { error: string }).error).toContain('already exists');

    // Unknown base role
    const res3 = await handler.handleMessage(ws, 'agent-roster.create', {
      name: 'Custom Helper',
      role: 'custom-helper',
      baseRole: 'unknown-base',
      purpose: 'Helper purpose',
      taskTypes: ['feature'],
    });
    expect((res3.payload as { error: string }).error).toContain(
      'unknown or circular base roster role',
    );

    // Valid create
    const res4 = await handler.handleMessage(ws, 'agent-roster.create', {
      name: 'Custom Helper',
      role: 'custom-helper',
      baseRole: 'generic',
      purpose: 'Helper purpose',
      taskTypes: ['feature'],
    });
    expect((res4.payload as { success: boolean }).success).toBe(true);
    expect((res4.payload as { role: string }).role).toBe('custom-helper');
  });

  it('handles skill operations: read, save, clear, pin', async () => {
    // Validation errors
    expect(await handler.handleMessage(ws, 'agent-roster.read-skill', {})).toEqual({
      type: 'agent-roster.read-skill',
      payload: { error: 'role and skill required' },
    });
    expect(
      await handler.handleMessage(ws, 'agent-roster.save-skill', { role: 'executor' }),
    ).toEqual({
      type: 'agent-roster.save-skill',
      payload: { error: 'role, skill and content required' },
    });
    expect(await handler.handleMessage(ws, 'agent-roster.clear-skill', {})).toEqual({
      type: 'agent-roster.clear-skill',
      payload: { error: 'role required' },
    });
    expect(
      await handler.handleMessage(ws, 'agent-roster.pin-skill', { role: 'executor', skill: 'git' }),
    ).toEqual({
      type: 'agent-roster.pin-skill',
      payload: { error: 'role, skill and boolean pinned required' },
    });

    // Save skill
    const saveRes = await handler.handleMessage(ws, 'agent-roster.save-skill', {
      role: 'executor',
      skill: 'testing',
      content: '# Testing Skill Content',
    });
    expect((saveRes.payload as { success: boolean }).success).toBe(true);

    // Read skill
    const readRes = await handler.handleMessage(ws, 'agent-roster.read-skill', {
      role: 'executor',
      skill: 'testing',
    });
    expect((readRes.payload as { content: string }).content).toContain('Testing Skill Content');

    // Pin skill
    const pinRes = await handler.handleMessage(ws, 'agent-roster.pin-skill', {
      role: 'executor',
      skill: 'testing',
      pinned: true,
    });
    expect((pinRes.payload as { success: boolean }).success).toBe(true);

    // Clear skill
    const clearRes = await handler.handleMessage(ws, 'agent-roster.clear-skill', {
      role: 'executor',
      skill: 'testing',
    });
    expect((clearRes.payload as { success: boolean }).success).toBe(true);
  });

  it('handles consolidated document operations: save, read, clear', async () => {
    // Validation errors
    expect(await handler.handleMessage(ws, 'agent-roster.save-consolidated', {})).toEqual({
      type: 'agent-roster.save-consolidated',
      payload: { error: 'role and content required' },
    });
    expect(await handler.handleMessage(ws, 'agent-roster.read-consolidated', {})).toEqual({
      type: 'agent-roster.read-consolidated',
      payload: { error: 'role required' },
    });
    expect(await handler.handleMessage(ws, 'agent-roster.clear-consolidated', {})).toEqual({
      type: 'agent-roster.clear-consolidated',
      payload: { error: 'role required' },
    });

    // Save consolidated
    const saveRes = await handler.handleMessage(ws, 'agent-roster.save-consolidated', {
      role: 'executor',
      content: '## Consolidated facts',
      trigger: 'manual',
    });
    expect((saveRes.payload as { success: boolean }).success).toBe(true);

    // Read consolidated
    const readRes = await handler.handleMessage(ws, 'agent-roster.read-consolidated', {
      role: 'executor',
    });
    expect((readRes.payload as { isConsolidated: boolean }).isConsolidated).toBe(true);

    // Clear consolidated
    const clearRes = await handler.handleMessage(ws, 'agent-roster.clear-consolidated', {
      role: 'executor',
    });
    expect((clearRes.payload as { success: boolean }).success).toBe(true);
  });

  it('handles auto-optimize-status and conflicts', async () => {
    const statusRes = await handler.handleMessage(ws, 'agent-roster.auto-optimize-status', {
      role: 'executor',
    });
    expect(statusRes.type).toBe('agent-roster.auto-optimize-status');
    expect((statusRes.payload as { roles: unknown[] }).roles).toHaveLength(1);

    const conflictsRes = await handler.handleMessage(ws, 'agent-roster.conflicts', {});
    expect(conflictsRes.type).toBe('agent-roster.conflicts');
  });

  it('handles unknown actions', async () => {
    const unknownRes = await handler.handleMessage(ws, 'agent-roster.unsupported-action', {});
    expect((unknownRes.payload as { error: string }).error).toContain(
      'Unknown agent-roster action',
    );
  });
});
