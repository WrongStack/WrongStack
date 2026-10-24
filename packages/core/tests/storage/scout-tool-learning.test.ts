import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  providerToolsForVariant,
  SCOUT_LEARNED_TOOLS_META_KEY,
} from '../../src/registry/scout-tool-surface.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import { ToolCapabilities } from '../../src/security/capabilities.js';
import {
  attachScoutToolLearning,
  readLearnedScoutTools,
  recordGatewayToolUse,
  scoutToolUseLogPath,
  seedScoutLearnedTools,
} from '../../src/storage/scout-tool-learning.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 4);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ws-scout-learn-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const use = (tool: string, times: number, at = NOW) => {
  for (let i = 0; i < times; i++) recordGatewayToolUse(dir, tool, at);
};

describe('readLearnedScoutTools', () => {
  it('promotes tools used often enough, most-used first, capped', () => {
    use('git', 5);
    use('diff', 3);
    use('lint', 2); // below the threshold
    use('logs', 4);
    expect(readLearnedScoutTools(dir, { now: NOW })).toEqual(['git', 'logs', 'diff']);
    expect(readLearnedScoutTools(dir, { now: NOW, max: 2 })).toEqual(['git', 'logs']);
  });

  it('counts only calls inside the window and breaks ties by recency', () => {
    use('old', 9, NOW - 40 * DAY);
    use('a', 3, NOW - 2 * DAY);
    use('b', 3, NOW - DAY);
    expect(readLearnedScoutTools(dir, { now: NOW })).toEqual(['b', 'a']);
  });

  it('skips excluded names and malformed lines', () => {
    use('read', 5);
    use('git', 3);
    appendFileSync(scoutToolUseLogPath(dir), 'not json\n{"tool":7}\n', 'utf8');
    expect(readLearnedScoutTools(dir, { now: NOW, exclude: new Set(['read']) })).toEqual(['git']);
  });

  it('promotes nothing when the log is missing', () => {
    expect(readLearnedScoutTools(path.join(dir, 'absent'))).toEqual([]);
  });

  it('keeps the log bounded by rotating the oldest lines away', () => {
    use('x', 12_000);
    expect(statSync(scoutToolUseLogPath(dir)).size).toBeLessThanOrEqual(256 * 1024);
    expect(readFileSync(scoutToolUseLogPath(dir), 'utf8').endsWith('\n')).toBe(true);
  });
});

describe('attachScoutToolLearning', () => {
  it('records successful gateway calls only', () => {
    const events = new EventBus();
    const detach = attachScoutToolLearning(events, dir);
    const executed = (name: string, ok: boolean, input: unknown) =>
      events.emit('tool.executed', { id: 'i', name, durationMs: 1, ok, input });

    executed('tool_use', true, { tool: 'git', input: {} });
    executed('tool_use', false, { tool: 'lint', input: {} });
    executed('git', true, {});
    detach();
    executed('tool_use', true, { tool: 'diff', input: {} });

    const lines = readFileSync(scoutToolUseLogPath(dir), 'utf8').trim().split('\n');
    expect(lines.map((line) => JSON.parse(line).tool)).toEqual(['git']);
  });
});

describe('learned tools on the Scout surface', () => {
  const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({
    name,
    description: name,
    inputSchema: { type: 'object' },
    permission: 'auto',
    mutating: false,
    async execute() {
      return '';
    },
    ...extra,
  });
  const registry = () => {
    const r = new ToolRegistry();
    for (const name of ['read', 'tool_search', 'tool_use', 'git', 'lint']) r.register(tool(name));
    r.register(tool('collab_debug', { capabilities: [ToolCapabilities.SUBAGENT_SPAWN] }));
    return r;
  };
  const names = (tools: readonly Tool[]) => tools.map((t) => t.name);

  it('seeds the session meta once, never with tools Scout already sends', () => {
    use('read', 5);
    use('git', 3);
    const meta: Record<string, unknown> = {};
    expect(seedScoutLearnedTools(meta, dir, { now: NOW })).toEqual(['git']);
    expect(meta[SCOUT_LEARNED_TOOLS_META_KEY]).toEqual(['git']);
    expect(Object.isFrozen(meta[SCOUT_LEARNED_TOOLS_META_KEY])).toBe(true);
    // Nothing learned: the key stays absent.
    const empty: Record<string, unknown> = {};
    seedScoutLearnedTools(empty, path.join(dir, 'none'));
    expect(SCOUT_LEARNED_TOOLS_META_KEY in empty).toBe(false);
  });

  it('adds the learned tools to the direct surface with a stable array per session', () => {
    const r = registry();
    const meta = { [SCOUT_LEARNED_TOOLS_META_KEY]: Object.freeze(['git']) };
    const first = providerToolsForVariant(r, 'scout', meta);
    expect(names(first)).toEqual(['read', 'tool_search', 'tool_use', 'git']);
    expect(providerToolsForVariant(r, 'scout', meta)).toBe(first);
    expect(names(providerToolsForVariant(r, 'scout', {}))).not.toContain('git');
  });

  it('never offers a learned spawn-capable tool to a solo session', () => {
    const r = registry();
    const learned = Object.freeze(['collab_debug', 'git']);
    const allowed = providerToolsForVariant(r, 'scout', {
      [SCOUT_LEARNED_TOOLS_META_KEY]: learned,
    });
    expect(names(allowed)).toContain('collab_debug');
    const solo = providerToolsForVariant(r, 'scout', {
      [SCOUT_LEARNED_TOOLS_META_KEY]: learned,
      subagentsAllowed: false,
    });
    expect(names(solo)).toEqual(['read', 'tool_search', 'tool_use', 'git']);
  });
});
