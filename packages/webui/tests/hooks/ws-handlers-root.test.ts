import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = {
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  undoable: vi.fn(),
};
vi.mock('@/components/Toaster', () => ({ toast }));

const wsClient = { send: vi.fn(), sendAbort: vi.fn() };
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => wsClient }));

const { useChatStore, useConfigStore, useHistoryStore, useSessionStore } = await import(
  '../../src/stores'
);
const {
  WS_HANDLERS,
  handleConfigDoctorResult,
  handleContextModeChanged,
  handleContextModesList,
  handleDiagGet,
  handleMemoryList,
  handleMemorySageBackfillRecoverable,
  handleMemorySageCandidateResolve,
  handleMemorySageGet,
  handleMemorySageList,
  handleMemorySageRecover,
  handleMemorySageRemember,
  handleMemorySageUpdate,
  handleModesList,
  handleSessionEnd,
  handleSessionsList,
  handleSkillsList,
  handleStatsGet,
  handleTodosUpdated,
  handleToolsList,
} = await import('../../src/hooks/ws-handlers');

function msg(type: string, payload: unknown) {
  return { type, payload } as never;
}

/**
 * The handlers format token counts with a bare `toLocaleString()`, so the
 * grouping separator follows the host locale (`1,000` on en-US, `1.000` on
 * tr-TR). Assert through the same call rather than hard-coding a separator.
 */
function n(value: number): string {
  return value.toLocaleString();
}

/** Content of the last chat message the handler pushed. */
function chat(): string {
  const msgs = useChatStore.getState().messages as Array<{ content: string }>;
  return msgs[msgs.length - 1]?.content ?? '';
}

function lastMessage(): Record<string, unknown> | undefined {
  const msgs = useChatStore.getState().messages as unknown as Array<Record<string, unknown>>;
  return msgs[msgs.length - 1];
}

const { readLane } = await import('../../src/stores/chat-lanes');
const { readSessionLane } = await import('../../src/stores/session-lanes');

describe('root ws-handler map', () => {
  beforeEach(() => {
    for (const fn of Object.values(toast)) fn.mockReset();
    wsClient.send.mockReset();
    useChatStore.setState({ messages: [] } as never);
    useSessionStore.setState({ session: null } as never);
    useHistoryStore.setState({ entries: [], loading: false, error: null } as never);
  });

  // ── map integrity ─────────────────────────────────────────────────────────

  describe('WS_HANDLERS map', () => {
    it('is populated and maps every key to a function', () => {
      const keys = Object.keys(WS_HANDLERS);
      expect(keys.length).toBeGreaterThan(50);
      for (const key of keys) {
        expect(typeof WS_HANDLERS[key as keyof typeof WS_HANDLERS], key).toBe('function');
      }
    });

    it('merges in every domain sub-map', () => {
      // One representative key per extracted domain module.
      for (const key of [
        'session.start', // session-handlers
        'provider.text_delta', // chat-handlers
        'coordinator.status', // coordinator-handlers
        'files.tree', // files-mailbox-handlers
        'worktree.state', // fleet-handlers
        'techstack.job.started', // techstack-handlers
        'goal.paused', // misc-handlers
      ]) {
        expect(WS_HANDLERS[key as keyof typeof WS_HANDLERS], key).toBeTypeOf('function');
      }
    });

    it('wires its own handlers into the map', () => {
      expect(WS_HANDLERS['tools.list']).toBe(handleToolsList);
      expect(WS_HANDLERS['skills.list']).toBe(handleSkillsList);
      expect(WS_HANDLERS['diag.get']).toBe(handleDiagGet);
      expect(WS_HANDLERS['stats.get']).toBe(handleStatsGet);
      // NOTE: `sessions.list` is NOT this file's handleSessionsList — the
      // session-handlers sub-map is spread in after it and wins. Both exist
      // and both are exported; the sub-map's is the one that actually runs.
      expect(WS_HANDLERS['sessions.list']).toBeTypeOf('function');
      expect(WS_HANDLERS['sessions.list']).not.toBe(handleSessionsList);
    });

    it('has no duplicate keys after the domain merges', () => {
      const keys = Object.keys(WS_HANDLERS);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  // ── session.end ───────────────────────────────────────────────────────────

  it('session.end marks the socket disconnected', () => {
    useConfigStore.setState({ wsConnected: true } as never);
    handleSessionEnd();
    expect(useConfigStore.getState().wsConnected).toBe(false);
  });

  // ── tools.list ────────────────────────────────────────────────────────────

  describe('tools.list', () => {
    it('renders a count and one row per tool', () => {
      handleToolsList(
        msg('tools.list', {
          tools: [
            { name: 'read_file', description: 'Read a file', params: ['path'] },
            { name: 'bash', description: 'Run a command', params: ['cmd', 'cwd'] },
          ],
        }),
      );
      expect(chat()).toContain('**Registered tools** (2)');
      expect(chat()).toContain('`read_file` (path) — Read a file');
      expect(chat()).toContain('`bash` (cmd, cwd) — Run a command');
    });

    it('omits the parameter list for a no-arg tool', () => {
      handleToolsList(
        msg('tools.list', { tools: [{ name: 'ping', description: 'Ping', params: [] }] }),
      );
      expect(chat()).toContain('`ping` — Ping');
    });

    it('substitutes a placeholder for a missing description', () => {
      handleToolsList(msg('tools.list', { tools: [{ name: 'x', description: '', params: [] }] }));
      expect(chat()).toContain('_no description_');
    });

    it('renders a zero count for an empty registry', () => {
      handleToolsList(msg('tools.list', { tools: [] }));
      expect(chat()).toContain('**Registered tools** (0)');
    });
  });

  // ── memory.list ───────────────────────────────────────────────────────────

  describe('memory.list', () => {
    it('renders the remembered notes', () => {
      handleMemoryList(msg('memory.list', { text: '  remember this  ' }));
      expect(chat()).toBe('🧠 **Memory** \n\nremember this');
    });

    it('reports an empty memory rather than a blank block', () => {
      handleMemoryList(msg('memory.list', { text: '   ' }));
      expect(chat()).toContain('_empty — nothing remembered yet_');
    });

    it('tolerates a missing text field', () => {
      handleMemoryList(msg('memory.list', {}));
      expect(chat()).toContain('_empty — nothing remembered yet_');
    });

    it('surfaces a read failure', () => {
      handleMemoryList(msg('memory.list', { text: '', error: 'EACCES' }));
      expect(chat()).toBe('Memory read failed: EACCES');
    });
  });

  // ── config doctor ─────────────────────────────────────────────────────────

  describe('config.doctor_result', () => {
    const base = {
      success: true,
      applied: false,
      changed: false,
      changes: [],
      configPath: '/cfg.json',
    };

    it('flags a failure as an error message', () => {
      handleConfigDoctorResult(
        msg('config.doctor_result', { ...base, success: false, error: 'bad JSON' }),
      );
      expect(chat()).toContain('**Config Doctor failed**');
      expect(chat()).toContain('bad JSON');
      expect(lastMessage()?.isError).toBe(true);
    });

    it('falls back to a generic reason', () => {
      handleConfigDoctorResult(msg('config.doctor_result', { ...base, success: false }));
      expect(chat()).toContain('Unknown config error.');
    });

    it('reports a healthy config', () => {
      handleConfigDoctorResult(msg('config.doctor_result', base));
      expect(chat()).toContain('active profile config is healthy');
      expect(chat()).toContain('`/cfg.json`');
    });

    it('lists repairable fields without applying them', () => {
      handleConfigDoctorResult(
        msg('config.doctor_result', {
          ...base,
          changed: true,
          changes: [
            { path: 'a.b', action: 'added' },
            { path: 'c.d', action: 'replaced' },
          ],
        }),
      );
      expect(chat()).toContain('found 2 repairable field(s)');
      expect(chat()).toContain('`a.b` — missing default');
      expect(chat()).toContain('`c.d` — invalid shape; default required');
      expect(chat()).toContain('Run `/doctor fix` to apply these repairs.');
    });

    it('reports applied repairs with the backup path', () => {
      handleConfigDoctorResult(
        msg('config.doctor_result', {
          ...base,
          changed: true,
          applied: true,
          backupPath: '/cfg.bak',
          changes: [{ path: 'a', action: 'added' }],
        }),
      );
      expect(chat()).toContain('repaired 1 field(s)');
      expect(chat()).toContain('Backup: `/cfg.bak`');
      expect(chat()).not.toContain('/doctor fix');
    });

    it('omits the backup line when the server sends none', () => {
      handleConfigDoctorResult(
        msg('config.doctor_result', {
          ...base,
          changed: true,
          applied: true,
          changes: [{ path: 'a', action: 'added' }],
        }),
      );
      expect(chat()).not.toContain('Backup:');
    });

    it('caps the change list at 40 with an overflow line', () => {
      const changes = Array.from({ length: 45 }, (_, i) => ({
        path: `f${i}`,
        action: 'added' as const,
      }));
      handleConfigDoctorResult(msg('config.doctor_result', { ...base, changed: true, changes }));
      expect(chat()).toContain('`f39`');
      expect(chat()).not.toContain('`f40`');
      expect(chat()).toContain('_…and 5 more_');
    });

    it('omits the overflow line at exactly 40 changes', () => {
      const changes = Array.from({ length: 40 }, (_, i) => ({
        path: `f${i}`,
        action: 'added' as const,
      }));
      handleConfigDoctorResult(msg('config.doctor_result', { ...base, changed: true, changes }));
      expect(chat()).not.toContain('more_');
    });
  });

  // ── SAGE ──────────────────────────────────────────────────────────────────

  describe('memory.sage.list', () => {
    it('surfaces an error', () => {
      handleMemorySageList(msg('memory.sage.list', { error: 'sage offline' }));
      expect(chat()).toBe('❌ sage offline');
    });

    it('renders the stats line', () => {
      handleMemorySageList(
        msg('memory.sage.list', {
          memories: [],
          stats: {
            total: 10,
            byStatus: { active: 6, stale: 3, archived: 1 },
            byKind: { fact: 7, feedback: 3, unused: 0 },
            edges: 12,
          },
        }),
      );
      expect(chat()).toContain(
        '**Total:** 10 · Active: 6 · Stale: 3 · Archived: 1 · Graph edges: 12',
      );
      // Zero-count kinds are dropped from the summary.
      expect(chat()).toContain('**Kinds:** fact=7, feedback=3');
      expect(chat()).not.toContain('unused');
    });

    it('defaults missing status buckets to zero', () => {
      handleMemorySageList(
        msg('memory.sage.list', {
          memories: [],
          stats: { total: 0, byStatus: {}, byKind: {}, edges: 0 },
        }),
      );
      expect(chat()).toContain('Active: 0 · Stale: 0 · Archived: 0');
    });

    it('omits the kinds line when every count is zero', () => {
      handleMemorySageList(
        msg('memory.sage.list', {
          memories: [],
          stats: { total: 0, byStatus: {}, byKind: { fact: 0 }, edges: 0 },
        }),
      );
      expect(chat()).not.toContain('**Kinds:**');
    });

    it('reports an empty list', () => {
      handleMemorySageList(msg('memory.sage.list', { memories: [] }));
      expect(chat()).toContain('_No entries to display._');
    });

    it('renders a memory row with id, kind, status, date, text and tags', () => {
      handleMemorySageList(
        msg('memory.sage.list', {
          memories: [
            {
              id: 'abcdef012345678',
              kind: 'fact',
              status: 'active',
              text: 'the thing',
              tags: ['a', 'b'],
              createdAt: '2026-07-29T10:00:00Z',
            },
          ],
        }),
      );
      expect(chat()).toContain('`abcdef012345…` [fact|active] 2026-07-29 — the thing `a` `b`');
    });

    it('truncates a long memory text', () => {
      handleMemorySageList(
        msg('memory.sage.list', {
          memories: [
            {
              id: 'x',
              kind: 'fact',
              status: 'active',
              text: 'y'.repeat(120),
              tags: [],
              createdAt: '2026-07-29T00:00:00Z',
            },
          ],
        }),
      );
      expect(chat()).toContain(`${'y'.repeat(78)}…`);
    });

    it('caps the list at 20 rows with an overflow line', () => {
      const memories = Array.from({ length: 25 }, (_, i) => ({
        id: `id${i}`,
        kind: 'fact',
        status: 'active',
        text: `t${i}`,
        tags: [],
        createdAt: '2026-07-29T00:00:00Z',
      }));
      handleMemorySageList(msg('memory.sage.list', { memories }));
      expect(chat()).toContain('_…and 5 more_');
    });
  });

  describe('memory.sage.get', () => {
    const memory = {
      id: 'm1',
      kind: 'fact',
      status: 'active',
      text: 'the thing',
      tags: ['a'],
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-29T00:00:00Z',
      importance: 3,
      confidence: 0.9,
      anchors: [{ type: 'file', path: 'src/a.ts' }],
    };

    it('renders the full record', () => {
      handleMemorySageGet(msg('memory.sage.get', { memory }));
      const c = chat();
      expect(c).toContain('## 🧠 Memory: `m1`');
      expect(c).toContain('**Text:** the thing');
      expect(c).toContain('**Kind:** `fact` · **Status:** `active`');
      expect(c).toContain('**Created:** 2026-07-01 · **Updated:** 2026-07-29');
      expect(c).toContain('**Importance:** 3 · **Confidence:** 0.9');
      expect(c).toContain('**Tags:** `a`');
      expect(c).toContain('**Anchors:** src/a.ts');
    });

    it('falls back to the anchor type when it has no path', () => {
      handleMemorySageGet(
        msg('memory.sage.get', { memory: { ...memory, anchors: [{ type: 'symbol' }] } }),
      );
      expect(chat()).toContain('**Anchors:** symbol');
    });

    it('renders an em dash for empty tags and anchors', () => {
      handleMemorySageGet(msg('memory.sage.get', { memory: { ...memory, tags: [], anchors: [] } }));
      expect(chat()).toContain('**Tags:** —');
      expect(chat()).toContain('**Anchors:** —');
    });

    it('surfaces an error', () => {
      handleMemorySageGet(msg('memory.sage.get', { error: 'nope' }));
      expect(chat()).toBe('❌ nope');
    });

    it('reports a missing memory', () => {
      handleMemorySageGet(msg('memory.sage.get', {}));
      expect(chat()).toBe('❌ Memory not found.');
    });
  });

  describe('memory.sage mutations', () => {
    it('confirms an update', () => {
      handleMemorySageUpdate(msg('memory.sage.update', { memory: { id: 'm1' } }));
      expect(chat()).toBe('✅ Memory `m1` updated.');
    });

    it('reports an update failure', () => {
      handleMemorySageUpdate(msg('memory.sage.update', { error: 'conflict' }));
      expect(chat()).toBe('❌ Update failed: conflict');
    });

    it('says nothing when the update reply carries no memory', () => {
      handleMemorySageUpdate(msg('memory.sage.update', {}));
      expect(useChatStore.getState().messages).toHaveLength(0);
    });

    it('confirms a creation', () => {
      handleMemorySageRemember(msg('memory.sage.remember', { memory: { id: 'm2' } }));
      expect(chat()).toBe('✅ Memory `m2` created.');
    });

    it('reports a creation failure', () => {
      handleMemorySageRemember(msg('memory.sage.remember', { error: 'quota' }));
      expect(chat()).toBe('❌ Failed to create memory: quota');
    });

    it('renders an empty id rather than "undefined"', () => {
      handleMemorySageRemember(msg('memory.sage.remember', { memory: {} }));
      expect(chat()).toBe('✅ Memory `` created.');
    });
  });

  describe('memory.sage.recover', () => {
    it('confirms a recovery', () => {
      handleMemorySageRecover(msg('memory.sage.recover', { memory: { id: 'm1' } }));
      expect(chat()).toBe('✅ Memory `m1` recovered.');
    });

    it('reports a no-op against the head of the chain', () => {
      handleMemorySageRecover(
        msg('memory.sage.recover', { memory: { id: 'm1' }, noop: true, activeId: 'm9' }),
      );
      expect(chat()).toContain('`m9` is already the active version');
    });

    it('falls back to the requested id when no activeId is given', () => {
      handleMemorySageRecover(msg('memory.sage.recover', { memory: { id: 'm1' }, noop: true }));
      expect(chat()).toContain('`m1` is already the active version');
    });

    it('reports a failure', () => {
      handleMemorySageRecover(msg('memory.sage.recover', { error: 'gone' }));
      expect(chat()).toBe('❌ Recover failed: gone');
    });

    it('stays silent with no memory in the reply', () => {
      handleMemorySageRecover(msg('memory.sage.recover', {}));
      expect(useChatStore.getState().messages).toHaveLength(0);
    });
  });

  describe('memory.sage.candidate_resolve', () => {
    it('reports an acceptance', () => {
      handleMemorySageCandidateResolve(
        msg('memory.sage.candidate_resolve', {
          candidate: { id: 'c1', status: 'accepted' },
          resolvedAction: 'accept',
        }),
      );
      expect(chat()).toBe('✅ Candidate `c1` accepted.');
    });

    it('reports a rejection', () => {
      handleMemorySageCandidateResolve(
        msg('memory.sage.candidate_resolve', {
          candidate: { id: 'c1', status: 'rejected' },
          resolvedAction: 'reject',
        }),
      );
      expect(chat()).toBe('✅ Candidate `c1` rejected.');
    });

    it('defaults to "accepted" when the action is absent', () => {
      handleMemorySageCandidateResolve(
        msg('memory.sage.candidate_resolve', { candidate: { id: 'c1', status: 'x' } }),
      );
      expect(chat()).toBe('✅ Candidate `c1` accepted.');
    });

    it('reports a failure', () => {
      handleMemorySageCandidateResolve(
        msg('memory.sage.candidate_resolve', { error: 'not found' }),
      );
      expect(chat()).toBe('❌ Candidate resolve failed: not found');
    });

    it('stays silent with no candidate', () => {
      handleMemorySageCandidateResolve(msg('memory.sage.candidate_resolve', {}));
      expect(useChatStore.getState().messages).toHaveLength(0);
    });
  });

  describe('memory.sage.backfill_recoverable', () => {
    it('renders a dry-run preview', () => {
      handleMemorySageBackfillRecoverable(
        msg('memory.sage.backfill_recoverable', {
          examined: 10,
          recoverable: 4,
          recovered: 0,
          dryRun: true,
        }),
      );
      expect(chat()).toContain('Backfill preview (dry-run)');
      expect(chat()).toContain('examined 10 · recoverable 4 · recovered 0');
      expect(chat()).toContain('Re-run with apply to write.');
    });

    it('renders an applied backfill', () => {
      handleMemorySageBackfillRecoverable(
        msg('memory.sage.backfill_recoverable', { examined: 10, recoverable: 4, recovered: 4 }),
      );
      expect(chat()).toContain('Backfill applied');
      expect(chat()).not.toContain('dry-run');
    });

    it('defaults every counter to zero', () => {
      handleMemorySageBackfillRecoverable(msg('memory.sage.backfill_recoverable', {}));
      expect(chat()).toContain('examined 0 · recoverable 0 · recovered 0');
    });

    it('reports a failure', () => {
      handleMemorySageBackfillRecoverable(
        msg('memory.sage.backfill_recoverable', { error: 'locked' }),
      );
      expect(chat()).toBe('❌ Backfill failed: locked');
    });
  });

  // ── skills.list ───────────────────────────────────────────────────────────

  describe('skills.list', () => {
    const skill = {
      name: 'commit',
      description: 'Make a commit',
      version: '1.0.0',
      source: 'project',
      path: '/s',
      trigger: '/commit',
      scope: [],
    };

    it('reports the feature being off', () => {
      handleSkillsList(msg('skills.list', { enabled: false, skills: [] }));
      expect(chat()).toContain('_disabled (config.features.skills = false)_');
    });

    it('renders a skill row', () => {
      handleSkillsList(msg('skills.list', { enabled: true, skills: [skill] }));
      expect(chat()).toContain('🎯 **Skills** (1)');
      expect(chat()).toContain('`commit` v1.0.0 _(project)_ — Make a commit');
    });

    it('omits the version when there is none', () => {
      handleSkillsList(msg('skills.list', { enabled: true, skills: [{ ...skill, version: '' }] }));
      expect(chat()).toContain('`commit` _(project)_ —');
    });

    it('falls back from description to trigger, then to a placeholder', () => {
      handleSkillsList(
        msg('skills.list', { enabled: true, skills: [{ ...skill, description: '' }] }),
      );
      expect(chat()).toContain('— /commit');

      handleSkillsList(
        msg('skills.list', { enabled: true, skills: [{ ...skill, description: '', trigger: '' }] }),
      );
      expect(chat()).toContain('_no description_');
    });

    it('reports an empty registry', () => {
      handleSkillsList(msg('skills.list', { enabled: true, skills: [] }));
      expect(chat()).toContain('_none registered_');
    });

    it('appends a warning when the server reports a partial failure', () => {
      handleSkillsList(
        msg('skills.list', { enabled: true, skills: [skill], error: '1 skill failed to load' }),
      );
      expect(chat()).toContain('⚠ 1 skill failed to load');
    });
  });

  // ── diag / stats ──────────────────────────────────────────────────────────

  describe('diag.get', () => {
    // The reply names its session, so it lands in that session's lane —
    // bind the surface to it, the way the tab that typed `/diag` is.
    beforeEach(() => {
      useSessionStore.setState({ session: { id: 's1' } } as never);
    });
    const diag = {
      provider: 'anthropic',
      model: 'opus',
      cwd: '/repo',
      sessionId: 's1',
      tools: { count: 12, names: [] },
      features: { memory: true, skills: false, modelsRegistry: true },
      mode: 'code',
      usage: { input: 1000, output: 250 },
      messages: 8,
      todos: 3,
    };

    it('renders the diagnostics block', () => {
      handleDiagGet(msg('diag.get', diag));
      const c = chat();
      expect(c).toContain('**Provider:** `anthropic` / `opus`');
      expect(c).toContain('**Mode:** `code`');
      expect(c).toContain('**Tools:** 12');
      expect(c).toContain('**Messages:** 8  ·  **Todos:** 3');
      expect(c).toContain(`${n(1000)} in · ${n(250)} out`);
    });

    it('appends cache usage only when present', () => {
      handleDiagGet(msg('diag.get', diag));
      expect(chat()).not.toContain('cache');

      handleDiagGet(msg('diag.get', { ...diag, usage: { ...diag.usage, cacheRead: 5000 } }));
      expect(chat()).toContain(`${n(5000)} cache`);
    });

    it('renders feature ticks and crosses', () => {
      handleDiagGet(msg('diag.get', diag));
      expect(chat()).toContain('memory=✓ · skills=✗ · modelsRegistry=✓');
    });

    it('lands in the named session, never in the tab in front', () => {
      useSessionStore.setState({ session: { id: 's1' } } as never);
      handleDiagGet(msg('diag.get', { ...diag, sessionId: 'other' } as never));
      // The foreground transcript is untouched...
      expect(useChatStore.getState().messages).toHaveLength(0);
      // ...and the reply is waiting in the tab it actually belongs to.
      expect(readLane('other').messages).toHaveLength(1);
    });
  });

  describe('stats.get', () => {
    beforeEach(() => {
      useSessionStore.setState({ session: { id: 's1' } } as never);
    });
    const stats = {
      sessionId: 's1',
      provider: 'anthropic',
      model: 'opus',
      usage: { input: 1000, output: 250 },
      cache: null,
      cost: 0.1234,
      messages: 8,
      readFiles: 4,
      tools: 12,
      elapsedMs: 45_000,
    };

    it('renders the stats block', () => {
      handleStatsGet(msg('stats.get', stats));
      const c = chat();
      expect(c).toContain('**Session:** `s1`');
      expect(c).toContain('**Provider/Model:** `anthropic` / `opus`');
      expect(c).toContain('**Cost:** 0.1234');
      expect(c).toContain('**Messages:** 8  ·  **Files read:** 4  ·  **Tools available:** 12');
    });

    it.each([
      [45_000, '45s'],
      [90_000, '1m 30s'],
      [3_600_000, '1h 0m'],
      [7_890_000, '2h 11m'],
    ])('formats %ims elapsed as %s', (elapsedMs, expected) => {
      handleStatsGet(msg('stats.get', { ...stats, elapsedMs }));
      expect(chat()).toContain(`**Elapsed:** ${expected}`);
    });

    it('omits the cache line when there is no cache', () => {
      handleStatsGet(msg('stats.get', stats));
      expect(chat()).not.toContain('**Cache:**');
    });

    it('omits the cache line when nothing was read from cache', () => {
      handleStatsGet(
        msg('stats.get', { ...stats, cache: { readTokens: 0, writeTokens: 100, hitRatio: 0 } }),
      );
      expect(chat()).not.toContain('**Cache:**');
    });

    it('renders the cache line with a hit ratio', () => {
      handleStatsGet(
        msg('stats.get', {
          ...stats,
          cache: { readTokens: 5000, writeTokens: 1000, hitRatio: 0.8333 },
        }),
      );
      expect(chat()).toContain(`**Cache:** ${n(5000)} read · ${n(1000)} write · hit ratio 83.3%`);
    });

    it('stores provider-specific cache hit ratios for the WebUI surfaces', () => {
      const providers = [
        { provider: 'minimax', input: 200, cacheRead: 800, cacheWrite: 0, hitRatio: 0.8 },
        { provider: 'anthropic', input: 100, cacheRead: 300, cacheWrite: 100, hitRatio: 0.6 },
      ];
      handleStatsGet(
        msg('stats.get', {
          ...stats,
          cache: { readTokens: 1100, writeTokens: 100, hitRatio: 0.6875, providers },
        }),
      );
      expect(useSessionStore.getState().cacheStats?.providers).toEqual(providers);
    });

    it('appends a side-effect warning only when there are any', () => {
      handleStatsGet(msg('stats.get', stats));
      expect(chat()).not.toContain('Side effects');

      handleStatsGet(msg('stats.get', { ...stats, sideEffectCount: 3 }));
      expect(chat()).toContain('**Side effects:** ⚠ 3');
    });

    it('omits the side-effect line for a zero count', () => {
      handleStatsGet(msg('stats.get', { ...stats, sideEffectCount: 0 }));
      expect(chat()).not.toContain('Side effects');
    });
  });

  // ── session state ─────────────────────────────────────────────────────────

  describe('todos.updated', () => {
    it('stores the todo list', () => {
      const todos = [{ id: 't1', content: 'do it', status: 'pending' as const }];
      handleTodosUpdated(msg('todos.updated', { todos }));
      expect(useSessionStore.getState().todos).toEqual(todos);
    });

    it('normalises a missing list to []', () => {
      handleTodosUpdated(msg('todos.updated', {}));
      expect(useSessionStore.getState().todos).toEqual([]);
    });

    it('lands in the named session, never in the tab in front', () => {
      useSessionStore.setState({ session: { id: 's1' }, todos: [] } as never);
      handleTodosUpdated(
        msg('todos.updated', {
          sessionId: 'other',
          todos: [{ id: 'x', content: 'y', status: 'pending' }],
        }),
      );
      expect(useSessionStore.getState().todos).toEqual([]);
      expect(readSessionLane('other').todos).toHaveLength(1);
    });
  });

  describe('modes.list', () => {
    it('stores the modes and marks the active one', () => {
      handleModesList(
        msg('modes.list', {
          activeId: 'code',
          modes: [
            { id: 'code', name: 'Code', description: 'Write code', isActive: true },
            { id: 'plan', name: 'Plan', description: 'Plan work', isActive: false },
          ],
        }),
      );
      expect(useSessionStore.getState().modes).toEqual([
        { id: 'code', name: 'Code', description: 'Write code' },
        { id: 'plan', name: 'Plan', description: 'Plan work' },
      ]);
      expect(useSessionStore.getState().mode).toBe('code');
    });
  });

  describe('context modes', () => {
    it('stores the context modes with their thresholds', () => {
      handleContextModesList(
        msg('context_modes.list', {
          activeId: 'balanced',
          modes: [
            {
              id: 'balanced',
              name: 'Balanced',
              description: 'default',
              isActive: true,
              thresholds: { warn: 0.7, soft: 0.8, hard: 0.9 },
              preserveK: 6,
              eliseThreshold: 0.5,
              custom: false,
            },
          ],
        }),
      );
      expect(useSessionStore.getState().contextModes?.[0]).toMatchObject({
        id: 'balanced',
        thresholds: { warn: 0.7, soft: 0.8, hard: 0.9 },
        preserveK: 6,
        eliseThreshold: 0.5,
        custom: false,
      });
      expect(useSessionStore.getState().contextMode).toBe('balanced');
    });

    it('tolerates a mode with no optional fields', () => {
      handleContextModesList(
        msg('context_modes.list', {
          activeId: 'lean',
          modes: [{ id: 'lean', name: 'Lean', description: '', isActive: true }],
        }),
      );
      expect(useSessionStore.getState().contextModes?.[0]).toMatchObject({ id: 'lean' });
    });

    it('context_mode.changed updates the active id', () => {
      handleContextModeChanged(msg('context_mode.changed', { id: 'archival', name: 'Archival' }));
      expect(useSessionStore.getState().contextMode).toBe('archival');
    });
  });

  describe('sessions.list', () => {
    it('stores the history entries', () => {
      handleSessionsList(msg('sessions.list', { sessions: [{ id: 's1' }, { id: 's2' }] }));
      expect(useHistoryStore.getState().entries).toHaveLength(2);
      expect(useHistoryStore.getState().error).toBeNull();
    });

    it('normalises a missing list and carries the error', () => {
      handleSessionsList(msg('sessions.list', { error: 'no store' } as never));
      expect(useHistoryStore.getState().entries).toEqual([]);
      expect(useHistoryStore.getState().error).toBe('no store');
    });
  });
});
