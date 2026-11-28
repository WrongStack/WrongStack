import { describe, expect, it } from 'vitest';
import { needsKey, switcherRows } from '../src/model-switcher-model';
import type { ProviderChoice } from '../src/provider-settings-model';

const choice = (id: string, extra: Partial<ProviderChoice> = {}): ProviderChoice => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  family: id,
  saved: true,
  keys: [{ label: 'default', maskedKey: 'sk-…', active: true }],
  ...extra,
});
const now = 1_800_000_000;
const meter = (providerId: string, used: number, extra: Record<string, unknown> = {}) => ({
  providerId,
  meterId: 'm',
  windows: [{ id: 'week', label: 'Week', usedPercent: used, resetsAt: now + 3600 }],
  capturedAt: now,
  ...extra,
});

describe('switcher rows', () => {
  const base = {
    choices: [
      choice('anthropic'),
      choice('openai', { keys: [] }),
      choice('ollama', { keys: [], hostServed: true }),
      choice('unsaved', { saved: false, keys: [] }),
      choice('acp', { keys: [], hostServed: true }),
    ],
    session: { provider: 'ollama', model: 'qwen3' },
    recents: [{ provider: 'anthropic', model: 'claude-sonnet' }],
    acpAgents: ['claude-code', 'codex-acp'],
    quota: [meter('anthropic', 47)],
    policy: {},
  };

  it('lists usable providers, then each ACP agent by name, the session row first', () => {
    const rows = switcherRows(base);
    expect(rows.map((row) => row.key)).toEqual([
      'ollama',
      'anthropic',
      'openai',
      'acp/claude-code',
      'acp/codex-acp',
    ]);
    expect(rows[0]).toMatchObject({ current: true, model: 'qwen3', subtitle: 'qwen3' });
    // A provider the session is not on runs the model last picked for it; unknown means none.
    expect(rows[1]).toMatchObject({ model: 'claude-sonnet', subtitle: 'claude-sonnet' });
    expect(rows[2]).toMatchObject({ model: undefined, status: { kind: 'needs-key' } });
    expect(rows.slice(3).map((row) => [row.name, row.agent])).toEqual([
      ['Claude Code', true],
      ['Codex', true],
    ]);
  });

  it('puts agents first for an ACP session and keeps its agent even when not listed', () => {
    const rows = switcherRows({ ...base, session: { provider: 'acp', model: 'gemini-cli' } });
    expect(rows.map((row) => row.key).slice(0, 3)).toEqual([
      'acp/gemini-cli',
      'acp/claude-code',
      'acp/codex-acp',
    ]);
    expect(rows[0]).toMatchObject({ current: true, agent: true, name: 'Gemini CLI' });
  });

  it('leaves out providers the profile hides, unless the session is on one', () => {
    const hidden = { disabledProviders: ['anthropic', 'ollama'] };
    const keys = switcherRows({ ...base, policy: hidden }).map((row) => row.key);
    expect(keys).not.toContain('anthropic');
    expect(keys).toContain('ollama');
  });
});

/** The status the switcher gives provider `a` under these meters. */
const quotaStatus = (provider: string, quota: ReturnType<typeof meter>[]) =>
  switcherRows({
    choices: [choice(provider)],
    session: { provider: 'other', model: '' },
    recents: [],
    acpAgents: [],
    quota,
    policy: {},
  })[0]?.status;

describe('switcher status', () => {
  it('needs a key only for a saved provider with no key the engine does not serve', () => {
    expect(needsKey(choice('a', { keys: [] }))).toBe(true);
    expect(needsKey(choice('a', { keys: [], hostServed: true }))).toBe(false);
    expect(needsKey(choice('a', { keys: [], saved: false }))).toBe(false);
    expect(needsKey(choice('a'))).toBe(false);
  });

  it('reports the share left of the busiest window, and a reached one with its reset', () => {
    expect(quotaStatus('a', [meter('a', 22), meter('b', 99)])).toEqual({
      kind: 'quota',
      left: 78,
      window: 'Week',
      level: 'ok',
      resetsAt: now + 3600,
    });
    expect(quotaStatus('a', [meter('a', 93)])).toMatchObject({ left: 7, level: 'critical' });
    expect(quotaStatus('a', [meter('a', 100, { reachedWindowId: 'week' })])).toEqual({
      kind: 'reached',
      window: 'Week',
      resetsAt: now + 3600,
    });
  });

  it('ignores gateway pool meters and providers without any meter', () => {
    expect(quotaStatus('a', [meter('a', 99, { via: 'omniroute' })])).toEqual({ kind: 'none' });
    expect(quotaStatus('a', [])).toEqual({ kind: 'none' });
  });
});
