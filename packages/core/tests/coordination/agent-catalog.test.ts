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
  it('has 50 catalog definitions and AGENT_CATALOG keys match 1:1', () => {
    expect(ALL_AGENT_DEFINITIONS.length).toBe(50);
    expect(Object.keys(AGENT_CATALOG).length).toBe(50);
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

  it('groups every catalog agent into exactly one phase and the groups sum to 50', () => {
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
    expect(total).toBe(50);
    expect(seen.size).toBe(50);
  });

  it('getAgentDefinition resolves known roles and rejects unknown ones', () => {
    expect(getAgentDefinition('explore')?.config.role).toBe('explore');
    expect(getAgentDefinition('definitely-not-a-role')).toBeUndefined();
  });
});

describe('fleet roster derivation', () => {
  it('FLEET_ROSTER is the catalog plus the standalone shadow-agent role', () => {
    expect(Object.keys(FLEET_ROSTER).length).toBe(51);
    // Legacy four are preserved alongside the catalog.
    for (const legacy of ['audit-log', 'bug-hunter', 'refactor-planner', 'security-scanner']) {
      expect(FLEET_ROSTER[legacy]).toBeDefined();
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

  it('shadow-agent has a modern one-shot budget without the old 4096 token cap', () => {
    const resolved = applyRosterBudget({ ...FLEET_ROSTER['shadow-agent']!, role: 'shadow-agent' });
    expect(resolved.maxTokens).toBe(30_000);
    expect(resolved.maxCostUsd).toBe(0.5);
    expect(resolved.timeoutMs).toBeUndefined();
    expect(resolved.idleTimeoutMs).toBeGreaterThan(0);
  });
});

describe('catalog spawnability (real Director + spawn tool)', () => {
  function makeDirector(): Director {
    const runner = async (
      _task: TaskSpec,
      _ctx: SubagentRunContext,
    ): Promise<SubagentRunOutcome> => ({ iterations: 1, toolCalls: 1 });
    return new Director({
      config: {
        coordinatorId: 'catalog',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 4,
      },
      runner,
    });
  }

  it('spawns every one of the 51 roster roles without error', async () => {
    const director = makeDirector();
    const spawn = makeSpawnTool(director, FLEET_ROSTER);
    const spawnedIds: string[] = [];

    for (const role of Object.keys(FLEET_ROSTER)) {
      const result = (await spawn.execute({ role })) as { subagentId?: string; error?: string };
      expect(result.error, `spawn error for role "${role}"`).toBeUndefined();
      expect(result.subagentId, `no subagentId for role "${role}"`).toBeTruthy();
      spawnedIds.push(result.subagentId!);
    }

    // All 51 produced distinct subagent ids (instantiateRosterConfig must not
    // reuse the template id) and the director registered each one.
    expect(new Set(spawnedIds).size).toBe(51);
    expect(director.status().subagents.length).toBe(51);
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

  const PLAYWRIGHT_TOOLS = [
    'playwright_navigate',
    'playwright_screenshot',
    'playwright_click',
    'playwright_type',
    'playwright_evaluate',
    'playwright_select_option',
    'playwright_hover',
    'playwright_fill_form',
    'playwright_wait_for',
    'playwright_press_key',
    'playwright_drag',
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

  it('browser agent has all 11 playwright tools', () => {
    const tools = browserDef!.config.tools!;
    for (const pt of PLAYWRIGHT_TOOLS) {
      expect(tools, `browser agent missing ${pt}`).toContain(pt);
    }
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

  it('e2e agent has all 11 playwright tools', () => {
    const tools = e2eDef!.config.tools!;
    for (const pt of PLAYWRIGHT_TOOLS) {
      expect(tools, `e2e agent missing ${pt}`).toContain(pt);
    }
  });

  it('e2e agent DOES have heavy tools (bash, exec, write, edit, ...)', () => {
    const tools = e2eDef!.config.tools!;
    for (const ht of HEAVY_TOOLS) {
      expect(tools, `e2e agent should have ${ht}`).toContain(ht);
    }
  });

  it('browser agent total tool count is reasonable (read + fetch + playwright, no heavy)', () => {
    const tools = browserDef!.config.tools!;
    // TOOLS.read (read, grep, glob, search, tree, mailbox) + fetch + 11 playwright = 18
    expect(tools.length).toBe(18);
  });
});
