import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { AgentRosterWSHandler } from '../src/server/agent-roster-handlers.js';

describe('AgentRosterWSHandler', () => {
  let projectRoot = '';
  let handler: AgentRosterWSHandler;
  const ws = {} as WebSocket;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wrongstack-roster-handler-'));
    handler = new AgentRosterWSHandler({ projectRoot: () => projectRoot });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('lists the complete catalog even before any role has learned data', async () => {
    const response = await handler.handleMessage(ws, 'agent-roster.list', {});
    const payload = response.payload as { roles: string[]; stats: unknown[]; catalog: unknown[] };

    expect(payload.roles).toContain('executor');
    expect(payload.roles.length).toBeGreaterThan(20);
    expect(payload.stats).toHaveLength(payload.roles.length);
    expect(payload.catalog).toHaveLength(payload.roles.length);
  });

  it('pauses learning without deleting the role knowledge', async () => {
    await handler.handleMessage(ws, 'agent-roster.append-learned', {
      role: 'executor',
      content: 'Use the project package manager and preserve focused test evidence.',
    });
    const response = await handler.handleMessage(ws, 'agent-roster.update-learning', {
      role: 'executor',
      enabled: false,
    });
    const payload = response.payload as {
      success: boolean;
      stats: { learningEnabled: boolean; entryCount: number };
    };

    expect(payload.success).toBe(true);
    expect(payload.stats).toMatchObject({ learningEnabled: false, entryCount: 1 });
    expect(
      fs.existsSync(path.join(projectRoot, '.wrongstack', 'agents', 'executor', 'learned.md')),
    ).toBe(true);
  });

  it('rejects traversal role ids', async () => {
    await expect(
      handler.handleMessage(ws, 'agent-roster.update-identity', {
        role: '../outside',
        content: 'invalid',
      }),
    ).rejects.toThrow(/Invalid project agent role/);
  });

  it('requires an explicit role for reset and allows clearing learned content', async () => {
    await handler.handleMessage(ws, 'agent-roster.append-learned', {
      role: 'executor',
      content: 'Temporary lesson that the operator can remove.',
    });

    const reset = await handler.handleMessage(ws, 'agent-roster.reset', {});
    expect(reset.payload).toMatchObject({ error: expect.stringContaining('role required') });

    const cleared = await handler.handleMessage(ws, 'agent-roster.update-learned', {
      role: 'executor',
      content: '',
    });
    expect(cleared.payload).toMatchObject({ success: true });
    expect(
      fs.readFileSync(
        path.join(projectRoot, '.wrongstack', 'agents', 'executor', 'learned.md'),
        'utf8',
      ),
    ).toBe('');
  });

  it('rejects malformed runtime config instead of persisting it', async () => {
    await expect(
      handler.handleMessage(ws, 'agent-roster.update-config', {
        role: 'executor',
        config: { tools: 'shell', budget: { timeoutMs: -1 } },
      }),
    ).rejects.toThrow(/config "tools"/);
  });

  it('persists the complete runtime policy and marks built-in roles as protected', async () => {
    const updated = await handler.handleMessage(ws, 'agent-roster.update-config', {
      role: 'executor',
      config: {
        tools: ['read_file'],
        allowedCapabilities: ['fs.read'],
        cwd: 'packages/core',
        worktree: 'required',
        modelPolicy: {
          allowed: [
            { provider: 'openai', model: 'primary' },
            { provider: 'anthropic', model: 'fallback' },
          ],
          fallbacks: [{ provider: 'anthropic', model: 'fallback' }],
          strict: true,
        },
        availability: {
          timezone: 'Europe/Kiev',
          days: [1, 2, 3, 4, 5],
          start: '09:00',
          end: '18:00',
          mode: 'enforce',
        },
        budget: { maxIterations: 50, maxToolCalls: 100 },
      },
    });
    expect(updated.payload).toMatchObject({ success: true, role: 'executor' });

    const read = await handler.handleMessage(ws, 'agent-roster.read-customization', {
      role: 'executor',
    });
    expect(read.payload).toMatchObject({
      systemProtected: true,
      config: {
        cwd: 'packages/core',
        worktree: 'required',
        modelPolicy: { strict: true },
        availability: { timezone: 'Europe/Kiev', mode: 'enforce' },
      },
    });
  });

  it('creates and lists an independently managed generic project agent', async () => {
    const created = await handler.handleMessage(ws, 'agent-roster.create-generic', {
      name: 'ABC',
      purpose: 'Own X, Y and Z workflows for this project.',
      taskTypes: ['X workflow', 'Y analysis', 'Z verification'],
    });
    expect(created.payload).toMatchObject({ success: true, role: 'abc' });

    const listed = await handler.handleMessage(ws, 'agent-roster.list', {});
    const payload = listed.payload as {
      roles: string[];
      catalog: Array<{ role: string; name: string; custom: boolean; baseRole?: string }>;
    };
    expect(payload.roles).toContain('abc');
    expect(payload.catalog).toContainEqual(
      expect.objectContaining({ role: 'abc', name: 'ABC', custom: true, baseRole: 'generic' }),
    );
    expect(
      fs.existsSync(path.join(projectRoot, '.wrongstack', 'agents', 'abc', 'profile.json')),
    ).toBe(true);
  });

  it('clones a selected roster role and rejects missing clone sources', async () => {
    const created = await handler.handleMessage(ws, 'agent-roster.create', {
      name: 'Project Executor',
      baseRole: 'executor',
      purpose: 'Execute project-specific implementation and verification tasks.',
      taskTypes: ['implementation', 'verification'],
    });
    expect(created.payload).toMatchObject({
      success: true,
      role: 'project-executor',
      profile: { baseRole: 'executor' },
    });

    const missing = await handler.handleMessage(ws, 'agent-roster.create', {
      name: 'Broken Clone',
      baseRole: 'does-not-exist',
      purpose: 'This clone should not be created from an unknown role.',
      taskTypes: ['invalid clone'],
    });
    expect(missing.payload).toMatchObject({ error: expect.stringContaining('unknown') });
  });

  it('consolidates headlessly with an active model: synthesizes, persists both files, and broadcasts', async () => {
    const synthesized = '## Consolidated\n\n- Directive one.\n- Directive two.';
    let receivedSystem = false;
    const broadcasts: Array<{ type: string; payload: unknown }> = [];
    const stubProvider = {
      capabilities: {},
      async complete() {
        return { content: [{ type: 'text', text: synthesized }] };
      },
    };
    const llmHandler = new AgentRosterWSHandler({
      projectRoot: () => projectRoot,
      // Assert the instruction actually reaches the provider.
      getLlm: () => {
        receivedSystem = true;
        return { provider: stubProvider as never, model: 'test-model' };
      },
      broadcast: (msg) => broadcasts.push(msg as { type: string; payload: unknown }),
    });

    await llmHandler.handleMessage(ws, 'agent-roster.append-learned', {
      role: 'executor',
      content: 'Always run the focused package test before the workspace suite.',
    });

    const res = await llmHandler.handleMessage(ws, 'agent-roster.consolidate', {
      role: 'executor',
    });
    const payload = res.payload as {
      consolidated: boolean;
      content?: string;
      model?: string;
      rawEntryCount: number;
    };

    expect(receivedSystem).toBe(true);
    expect(payload.consolidated).toBe(true);
    expect(payload.model).toBe('test-model');
    expect(payload.content).toContain('Directive one.');
    expect(payload.rawEntryCount).toBeGreaterThan(0);

    // consolidated.md is written verbatim, consolidation.json metadata alongside.
    const dir = path.join(projectRoot, '.wrongstack', 'agents', 'executor');
    expect(fs.readFileSync(path.join(dir, 'consolidated.md'), 'utf8')).toContain('Directive one.');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'consolidation.json'), 'utf8'));
    expect(meta.trigger).toBe('manual');
    expect(meta.model).toBe('test-model');
    expect(meta.sourceEntryCount).toBeGreaterThan(0);

    // Other connected clients are notified via agent-roster.updated.
    const updated = broadcasts.find((b) => b.type === 'agent-roster.updated');
    expect(updated).toBeDefined();
    expect(updated?.payload).toMatchObject({ role: 'executor', reason: 'consolidated' });
  });

  it('does not broadcast on the no-active-model fallback path', async () => {
    const broadcasts: object[] = [];
    const noLlmHandler = new AgentRosterWSHandler({
      projectRoot: () => projectRoot,
      broadcast: (msg) => broadcasts.push(msg),
    });
    await noLlmHandler.handleMessage(ws, 'agent-roster.append-learned', {
      role: 'executor',
      content: 'A rule that will not consolidate without a model.',
    });
    const res = await noLlmHandler.handleMessage(ws, 'agent-roster.consolidate', {
      role: 'executor',
    });
    expect((res.payload as { consolidated: boolean }).consolidated).toBe(false);
    expect(broadcasts).toHaveLength(0);
  });

  it('strips an accidental code-fence wrapper from the synthesized document', async () => {
    const stubProvider = {
      capabilities: {},
      async complete() {
        return { content: [{ type: 'text', text: '```markdown\n## Doc\n\n- Rule.\n```' }] };
      },
    };
    const llmHandler = new AgentRosterWSHandler({
      projectRoot: () => projectRoot,
      getLlm: () => ({ provider: stubProvider as never, model: 'm' }),
    });
    await llmHandler.handleMessage(ws, 'agent-roster.append-learned', {
      role: 'executor',
      content: 'A durable rule worth keeping.',
    });
    const res = await llmHandler.handleMessage(ws, 'agent-roster.consolidate', { role: 'executor' });
    const payload = res.payload as { consolidated: boolean; content?: string };
    expect(payload.consolidated).toBe(true);
    expect(payload.content?.startsWith('```')).toBe(false);
    expect(payload.content).toContain('## Doc');
  });

  it('returns a non-error signal when there are no learned entries to consolidate', async () => {
    // No append-learned call → the role has zero raw entries.
    let called = false;
    const llmHandler = new AgentRosterWSHandler({
      projectRoot: () => projectRoot,
      getLlm: () => {
        called = true;
        return { provider: { capabilities: {}, async complete() { return { content: [] }; } } as never, model: 'm' };
      },
    });
    const res = await llmHandler.handleMessage(ws, 'agent-roster.consolidate', { role: 'executor' });
    const payload = res.payload as { consolidated: boolean; rawEntryCount: number; error?: string };
    expect(payload.consolidated).toBe(false);
    expect(payload.rawEntryCount).toBe(0);
    expect(payload.error).toBeUndefined();
    // Empty-entry path short-circuits before invoking the model.
    expect(called).toBe(false);
  });

  it('surfaces a clean error payload when synthesis throws', async () => {
    const stubProvider = {
      capabilities: {},
      async complete(): Promise<never> {
        throw new Error('provider exploded');
      },
    };
    const llmHandler = new AgentRosterWSHandler({
      projectRoot: () => projectRoot,
      getLlm: () => ({ provider: stubProvider as never, model: 'test-model' }),
    });
    await llmHandler.handleMessage(ws, 'agent-roster.append-learned', {
      role: 'executor',
      content: 'A rule that will fail to consolidate.',
    });
    const res = await llmHandler.handleMessage(ws, 'agent-roster.consolidate', { role: 'executor' });
    const payload = res.payload as {
      consolidated: boolean;
      rawEntryCount: number;
      error?: string;
    };
    expect(payload.consolidated).toBe(false);
    expect(payload.rawEntryCount).toBeGreaterThan(0);
    expect(payload.error).toBe('provider exploded');
    // Failed synthesis must not have written a consolidated document.
    const dir = path.join(projectRoot, '.wrongstack', 'agents', 'executor');
    expect(fs.existsSync(path.join(dir, 'consolidated.md'))).toBe(false);
  });

  it('falls back to the instruction when no active model is available', async () => {
    // Default handler has no getLlm → no active model.
    await handler.handleMessage(ws, 'agent-roster.append-learned', {
      role: 'executor',
      content: 'Prefer surgical edits over full rewrites.',
    });
    const res = await handler.handleMessage(ws, 'agent-roster.consolidate', { role: 'executor' });
    const payload = res.payload as {
      consolidated: boolean;
      instruction?: string;
      leaderInstruction?: string;
      rawEntryCount: number;
    };
    expect(payload.consolidated).toBe(false);
    expect(payload.rawEntryCount).toBeGreaterThan(0);
    expect(typeof payload.instruction).toBe('string');
    expect(payload.instruction).toContain('executor');
    // No files written on the fallback path.
    expect(
      fs.existsSync(path.join(projectRoot, '.wrongstack', 'agents', 'executor', 'consolidated.md')),
    ).toBe(false);
  });

  it('reports consolidated:false with no error when there are no raw entries', async () => {
    const stubProvider = {
      capabilities: {},
      async complete() {
        throw new Error('should not be called for empty entries');
      },
    };
    const llmHandler = new AgentRosterWSHandler({
      projectRoot: () => projectRoot,
      getLlm: () => ({ provider: stubProvider as never, model: 'm' }),
    });
    const res = await llmHandler.handleMessage(ws, 'agent-roster.consolidate', { role: 'executor' });
    const payload = res.payload as { consolidated: boolean; rawEntryCount: number; error?: string };
    expect(payload.consolidated).toBe(false);
    expect(payload.rawEntryCount).toBe(0);
    expect(payload.error).toBeUndefined();
  });

  it('surfaces a provider error as a clean failure payload (no chat misroute)', async () => {
    const stubProvider = {
      capabilities: {},
      async complete() {
        throw new Error('provider exploded');
      },
    };
    const llmHandler = new AgentRosterWSHandler({
      projectRoot: () => projectRoot,
      getLlm: () => ({ provider: stubProvider as never, model: 'm' }),
    });
    await llmHandler.handleMessage(ws, 'agent-roster.append-learned', {
      role: 'executor',
      content: 'A lesson that will fail to consolidate.',
    });
    const res = await llmHandler.handleMessage(ws, 'agent-roster.consolidate', { role: 'executor' });
    const payload = res.payload as { consolidated: boolean; error?: string; instruction?: string };
    expect(payload.consolidated).toBe(false);
    expect(payload.error).toContain('provider exploded');
    // A real error must NOT be misrouted as the no-model fallback.
    expect(payload.instruction).toBeUndefined();
  });

  it('signals emptySynthesis when the model runs but returns only whitespace', async () => {
    const stubProvider = {
      capabilities: {},
      async complete() {
        // Model was available and ran, but produced only whitespace/fencing.
        return { content: [{ type: 'text', text: '   \n\n```markdown\n```\n' }] };
      },
    };
    const llmHandler = new AgentRosterWSHandler({
      projectRoot: () => projectRoot,
      getLlm: () => ({ provider: stubProvider as never, model: 'empty-model' }),
    });
    await llmHandler.handleMessage(ws, 'agent-roster.append-learned', {
      role: 'executor',
      content: 'A durable rule the model failed to synthesize.',
    });
    const res = await llmHandler.handleMessage(ws, 'agent-roster.consolidate', { role: 'executor' });
    const payload = res.payload as {
      consolidated: boolean;
      emptySynthesis?: boolean;
      model?: string;
      instruction?: string;
      rawEntryCount: number;
    };
    expect(payload.consolidated).toBe(false);
    // Distinct from the no-model fallback: the model ran but produced nothing.
    expect(payload.emptySynthesis).toBe(true);
    expect(payload.model).toBe('empty-model');
    expect(payload.instruction).toBeUndefined();
    expect(payload.rawEntryCount).toBeGreaterThan(0);
    // Empty synthesis must NOT write a consolidated document.
    expect(
      fs.existsSync(path.join(projectRoot, '.wrongstack', 'agents', 'executor', 'consolidated.md')),
    ).toBe(false);
  });

  it('does not swallow the success response when a broadcast throws', async () => {
    const synthesized = '## Consolidated\n\n- Keep every fact.';
    const stubProvider = {
      capabilities: {},
      async complete() {
        return { content: [{ type: 'text', text: synthesized }] };
      },
    };
    const llmHandler = new AgentRosterWSHandler({
      projectRoot: () => projectRoot,
      getLlm: () => ({ provider: stubProvider as never, model: 'test-model' }),
      broadcast: () => {
        throw new Error('client iterator disconnected mid-broadcast');
      },
    });
    await llmHandler.handleMessage(ws, 'agent-roster.append-learned', {
      role: 'executor',
      content: 'A rule worth consolidating even if the broadcast fails.',
    });
    const res = await llmHandler.handleMessage(ws, 'agent-roster.consolidate', { role: 'executor' });
    const payload = res.payload as { consolidated: boolean; content?: string };
    // The document persisted, so the success response must still be returned
    // even though the post-persist broadcast threw.
    expect(payload.consolidated).toBe(true);
    expect(payload.content).toContain('## Consolidated');
    expect(
      fs.existsSync(path.join(projectRoot, '.wrongstack', 'agents', 'executor', 'consolidated.md')),
    ).toBe(true);
  });
});
