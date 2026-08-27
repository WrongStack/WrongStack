import { describe, expect, it } from 'vitest';
import {
  AGENT_CATALOG,
  AGENTS_BY_PHASE,
  type AgentPhase,
  ALL_AGENT_DEFINITIONS,
  getAgentDefinition,
} from '../../src/coordination/agents/index.js';
import { Director } from '../../src/coordination/director.js';
import { makeSpawnTool } from '../../src/coordination/director-tools.js';
import {
  applyRosterBudget,
  FLEET_ROSTER,
  FLEET_ROSTER_BUDGETS,
} from '../../src/coordination/fleet.js';
import type {
  SubagentRunContext,
  SubagentRunOutcome,
  TaskSpec,
} from '../../src/types/multi-agent.js';

/** Owning session for coordinator-scoped work under test. */
const TEST_SESSION_ID = 'sess_test';

const PHASES: AgentPhase[] = [
  'discovery',
  'planning',
  'build',
  'verify',
  'review',
  'domain',
  'knowledge',
  'delivery',
  'meta',
];

const KEBAB = /^[a-z][a-z0-9-]*$/;
const TOOL_ID = /^[a-z][a-z0-9_-]*$/;

describe('agent catalog integrity', () => {
  it('has 75 catalog definitions and AGENT_CATALOG keys match 1:1', () => {
    expect(ALL_AGENT_DEFINITIONS.length).toBe(75);
    expect(Object.keys(AGENT_CATALOG).length).toBe(75);
    for (const def of ALL_AGENT_DEFINITIONS) {
      expect(AGENT_CATALOG[def.config.role as string]).toBe(def);
    }
  });

  it('every definition is structurally complete and spawnable-shaped', () => {
    for (const def of ALL_AGENT_DEFINITIONS) {
      const { config, budget, capability } = def;
      const role = config.role as string;

      // Identity
      expect(role, `role for ${config.name}`).toMatch(KEBAB);
      expect(config.name?.length ?? 0).toBeGreaterThan(0);
      // Prompts are real role briefs, not stubs.
      expect((config.prompt ?? '').length, `prompt for ${role}`).toBeGreaterThan(50);

      // Skills: every role has a diverse, duplicate-free curated set.
      const skills = config.skillNames ?? [];
      expect(skills.length, `skills for ${role}`).toBeGreaterThanOrEqual(3);
      expect(skills.length, `too many eager skills for ${role}`).toBeLessThanOrEqual(3);
      expect(new Set(skills).size, `duplicate skill in ${role}`).toBe(skills.length);

      // Tools: non-empty, unique, well-formed ids.
      const tools = config.tools ?? [];
      expect(tools.length, `tools for ${role}`).toBeGreaterThan(0);
      expect(new Set(tools).size, `duplicate tool id in ${role}`).toBe(tools.length);
      for (const t of tools) {
        expect(t, `tool id "${t}" in ${role}`).toMatch(TOOL_ID);
      }

      // Budget tier: at least a positive wall-clock ceiling.
      expect(budget.timeoutMs ?? 0, `budget.timeoutMs for ${role}`).toBeGreaterThan(0);

      // Capability metadata for the dispatcher.
      expect(PHASES, `phase for ${role}`).toContain(capability.phase);
      expect(capability.summary.length, `summary for ${role}`).toBeGreaterThan(0);
      expect(capability.keywords.length, `keywords for ${role}`).toBeGreaterThan(0);
      for (const kw of capability.keywords) {
        expect(kw.length, `empty keyword in ${role}`).toBeGreaterThan(0);
        // Heuristic dispatcher lowercases the task; keywords must be lowercase
        // or they can never match.
        expect(kw, `keyword "${kw}" in ${role} must be lowercase`).toBe(kw.toLowerCase());
      }
    }
  });

  it('groups every catalog agent into exactly one phase and the groups sum to 75', () => {
    let total = 0;
    const seen = new Set<string>();
    for (const phase of PHASES) {
      const group = AGENTS_BY_PHASE[phase];
      expect(Array.isArray(group)).toBe(true);
      for (const def of group) {
        expect(def.capability.phase, `${def.config.role} grouped under wrong phase`).toBe(phase);
        expect(seen.has(def.config.role as string), `${def.config.role} in two phases`).toBe(false);
        seen.add(def.config.role as string);
      }
      total += group.length;
    }
    expect(total).toBe(75);
    expect(seen.size).toBe(75);
  });

  it('every built-in role carries a non-empty technology policy suffix in its prompt', async () => {
    // The policy block is opt-in via `WRONGSTACK_AGENT_POLICY=on`. The loader
    // exposes a `globalThis.__WS_DISABLE_PROMPT_CACHE__` test hook that
    // bypasses the in-process prompt cache so the assertion sees the
    // policy-injected prompt even when an earlier test cached the
    // pre-policy variant. We also clear `promptCache` after the run so
    // downstream consumers do not observe the un-cached bypass state.
    const previousPolicy = process.env['WRONGSTACK_AGENT_POLICY'];
    const previousBypass = (globalThis as { __WS_DISABLE_PROMPT_CACHE__?: boolean })
      .__WS_DISABLE_PROMPT_CACHE__;
    process.env['WRONGSTACK_AGENT_POLICY'] = 'on';
    (globalThis as { __WS_DISABLE_PROMPT_CACHE__?: boolean }).__WS_DISABLE_PROMPT_CACHE__ = true;
    try {
      const mod = await import('../../src/coordination/agents/agent-prompts.js');
      for (const def of ALL_AGENT_DEFINITIONS) {
        const role = def.config.role as string;
        const prompt = mod.agentPrompt(role);
        expect(prompt, `${role} must receive the modern technology policy`).toContain(
          'Mandatory modern technology policy',
        );
        expect(prompt, `${role} must enforce latest-stable versions`).toContain(
          'Latest stable by default',
        );
      }
    } finally {
      if (previousPolicy === undefined) {
        delete process.env['WRONGSTACK_AGENT_POLICY'];
      } else {
        process.env['WRONGSTACK_AGENT_POLICY'] = previousPolicy;
      }
      if (previousBypass === undefined) {
        delete (globalThis as { __WS_DISABLE_PROMPT_CACHE__?: boolean })
          .__WS_DISABLE_PROMPT_CACHE__;
      } else {
        (globalThis as { __WS_DISABLE_PROMPT_CACHE__?: boolean }).__WS_DISABLE_PROMPT_CACHE__ =
          previousBypass;
      }
    }
  });

  it('getAgentDefinition resolves known roles and rejects unknown ones', () => {
    expect(getAgentDefinition('explore')?.config.role).toBe('explore');
    expect(getAgentDefinition('definitely-not-a-role')).toBeUndefined();
  });
});

describe('fleet roster derivation', () => {
  it('FLEET_ROSTER is the catalog plus the standalone shadow, generic, explore-companion, and chaos-monkey roles', () => {
    expect(Object.keys(FLEET_ROSTER).length).toBe(79);
    // Legacy four are preserved alongside the catalog.
    for (const legacy of ['audit-log', 'bug-hunter', 'refactor-planner', 'security-scanner']) {
      expect(FLEET_ROSTER[legacy]).toBeDefined();
    }
    // Standalone operational roles registered outside the phase catalog.
    for (const operational of ['shadow-agent', 'generic', 'explore-companion', 'chaos-monkey']) {
      expect(FLEET_ROSTER[operational]).toBeDefined();
    }
    // Every catalog role is in the roster.
    for (const def of ALL_AGENT_DEFINITIONS) {
      expect(FLEET_ROSTER[def.config.role as string]).toBeDefined();
    }
  });

  it('every roster role has a budget and applyRosterBudget fills an idle window', () => {
    for (const role of Object.keys(FLEET_ROSTER)) {
      expect(FLEET_ROSTER_BUDGETS[role], `budget for ${role}`).toBeDefined();
      const resolved = applyRosterBudget({ ...FLEET_ROSTER[role]!, role });
      // The default reaper is idle-based now — no wall-clock cap is imposed
      // by default (it killed active agents); idleTimeoutMs is always filled.
      expect(resolved.idleTimeoutMs, `resolved idle window for ${role}`).toBeGreaterThan(0);
      expect(resolved.timeoutMs, `no default wall-clock for ${role}`).toBeUndefined();
    }
  });

  it('shadow-agent has a realistic one-shot token budget and operational skills', () => {
    const resolved = applyRosterBudget({ ...FLEET_ROSTER['shadow-agent']!, role: 'shadow-agent' });
    expect(resolved.maxTokens).toBe(96_000);
    expect(resolved.maxCostUsd).toBe(0.5);
    expect(resolved.timeoutMs).toBeUndefined();
    expect(resolved.idleTimeoutMs).toBeGreaterThan(0);
    expect(resolved.skillNames).toEqual(
      expect.arrayContaining(['wrongstack-mailbox', 'multi-agent', 'audit-log', 'observability']),
    );
  });
});

describe('catalog spawnability (real Director + spawn tool)', () => {
  function makeDirector(): Director {
    const runner = async (
      _task: TaskSpec,
      _ctx: SubagentRunContext,
    ): Promise<SubagentRunOutcome> => ({ iterations: 1, toolCalls: 1 });
    return new Director({
      sessionId: TEST_SESSION_ID,
      config: {
        coordinatorId: 'catalog',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 4,
      },
      runner,
    });
  }

  it('spawns every roster role without error', async () => {
    const director = makeDirector();
    const spawn = makeSpawnTool(director, FLEET_ROSTER);
    const spawnedIds: string[] = [];

    for (const role of Object.keys(FLEET_ROSTER)) {
      const result = (await spawn.execute({ role }, {} as never, {
        signal: new AbortController().signal,
      })) as { subagentId?: string; error?: string };
      expect(result.error, `spawn error for role "${role}"`).toBeUndefined();
      expect(result.subagentId, `no subagentId for role "${role}"`).toBeTruthy();
      spawnedIds.push(result.subagentId!);
    }

    // Every role produced a distinct subagent id (instantiateRosterConfig must not
    // reuse the template id) and the director registered each one.
    const rosterSize = Object.keys(FLEET_ROSTER).length;
    expect(new Set(spawnedIds).size).toBe(rosterSize);
    expect(director.status().subagents.length).toBe(rosterSize);
  });

  it('reports a clean error for an unknown role instead of throwing', async () => {
    const director = makeDirector();
    const spawn = makeSpawnTool(director, FLEET_ROSTER);
    const result = (await spawn.execute({ role: 'no-such-role' })) as { error?: string };
    expect(result.error).toMatch(/unknown role/i);
  });
});

describe('browser and e2e agent tool lists', () => {
  const BROWSER_ROLE = 'browser';
  const E2E_ROLE = 'e2e';

  const BROWSER_TOOLS = [
    'browser_open',
    'browser_status',
    'browser_list',
    'browser_navigate',
    'browser_snapshot',
    'browser_screenshot',
    'browser_click',
    'browser_type',
    'browser_select',
    'browser_press',
    'browser_hover',
    'browser_drag',
    'browser_wait',
    'browser_evaluate',
    'browser_upload',
    'browser_close',
  ] as const;

  const READ_TOOLS = ['read', 'grep', 'glob', 'search', 'tree'] as const;
  const HEAVY_TOOLS = [
    'bash',
    'exec',
    'write',
    'edit',
    'replace',
    'patch',
    'lint',
    'format',
    'typecheck',
    'test',
  ] as const;

  const browserDef = getAgentDefinition(BROWSER_ROLE);
  const e2eDef = getAgentDefinition(E2E_ROLE);

  it('browser agent exists in the catalog', () => {
    expect(browserDef).toBeDefined();
    expect(browserDef!.config.role).toBe(BROWSER_ROLE);
  });

  it('browser agent has the canonical browser capability tools', () => {
    const tools = browserDef!.config.tools!;
    for (const pt of BROWSER_TOOLS) {
      expect(tools, `browser agent missing ${pt}`).toContain(pt);
    }
    expect(browserDef!.config.capabilities).toContain('browser.interact');
  });

  it('browser agent has read-only tools (read, grep, glob, search, tree)', () => {
    const tools = browserDef!.config.tools!;
    for (const rt of READ_TOOLS) {
      expect(tools, `browser agent missing ${rt}`).toContain(rt);
    }
  });

  it('browser agent has fetch', () => {
    expect(browserDef!.config.tools!).toContain('fetch');
  });

  it('browser agent does NOT have heavy tools (bash, exec, write, edit, ...)', () => {
    const tools = browserDef!.config.tools!;
    for (const ht of HEAVY_TOOLS) {
      expect(tools, `browser agent should NOT have ${ht}`).not.toContain(ht);
    }
  });

  it('e2e agent has the canonical browser capability tools', () => {
    const tools = e2eDef!.config.tools!;
    for (const pt of BROWSER_TOOLS) {
      expect(tools, `e2e agent missing ${pt}`).toContain(pt);
    }
    expect(e2eDef!.config.capabilities).toContain('browser.interact');
  });

  it('e2e agent DOES have heavy tools (bash, exec, write, edit, ...)', () => {
    const tools = e2eDef!.config.tools!;
    for (const ht of HEAVY_TOOLS) {
      expect(tools, `e2e agent should have ${ht}`).toContain(ht);
    }
  });

  it('browser agent total tool count is bounded (read + fetch + browser, no heavy)', () => {
    const tools = browserDef!.config.tools!;
    expect(tools.length).toBeLessThanOrEqual(24);
    expect(tools.some((name) => name.startsWith('playwright_'))).toBe(false);
  });
});
