/**
 * WS-079 — untrusted sources may narrow a capability grant, never widen one.
 *
 * `allowedCapabilities` is a documented per-spawn escape hatch for a TRUSTED
 * caller: it is how the user hands a subagent something that
 * WIDE_SUBAGENT_CAPABILITIES deliberately withholds. Two untrusted sources
 * could also reach it:
 *
 *   1. `<projectRoot>/.wrongstack/agents/<role>/config.json` — a repo-committed
 *      file, merged verbatim by applyProjectAgentConfig. It sits beside
 *      `.wrongstack/config.json`, which in-project-policy DOES strip; the
 *      denylist guarded one file while the dangerous one lay next to it.
 *   2. Model output, through the un-enum'd `allowedCapabilities: string[]` on
 *      the kanban/director tool schemas.
 */
import { describe, expect, it } from 'vitest';
import {
  clampSubagentCapabilities,
  ToolCapabilities,
  WIDE_SUBAGENT_CAPABILITIES,
} from '../../src/security/capabilities.js';
import { applyProjectAgentConfig } from '../../src/coordination/agents/project-agent-identity.js';
import type { SubagentConfig } from '../../src/types/multi-agent.js';

describe('clampSubagentCapabilities', () => {
  it('drops every capability the wide ceiling deliberately withholds', () => {
    const { granted, dropped } = clampSubagentCapabilities([
      ToolCapabilities.FS_READ,
      ToolCapabilities.FS_WRITE_OUTSIDE_PROJECT,
      ToolCapabilities.TOOL_MUTATE_ANY,
      ToolCapabilities.CONFIG_MUTATE,
      ToolCapabilities.SUBAGENT_SPAWN,
      ToolCapabilities.MCP_PROXY,
    ]);

    expect(granted).toEqual([ToolCapabilities.FS_READ]);
    expect(dropped).toEqual(
      expect.arrayContaining([
        ToolCapabilities.FS_WRITE_OUTSIDE_PROJECT,
        ToolCapabilities.TOOL_MUTATE_ANY,
        ToolCapabilities.CONFIG_MUTATE,
        ToolCapabilities.SUBAGENT_SPAWN,
        ToolCapabilities.MCP_PROXY,
      ]),
    );
  });

  it('drops session.nextsteps — after-task suggestions are leader-only', () => {
    // The wide ceiling grants `session.todo` but not this one: a recorded
    // block is only ever folded into a LEADER turn, so a subagent holding the
    // capability could write to a slot nothing will ever read.
    const { granted, dropped } = clampSubagentCapabilities([
      ToolCapabilities.SESSION_TODO,
      ToolCapabilities.SESSION_NEXTSTEPS,
    ]);

    expect(granted).toEqual([ToolCapabilities.SESSION_TODO]);
    expect(dropped).toContain(ToolCapabilities.SESSION_NEXTSTEPS);
  });

  it('preserves a narrower grant untouched', () => {
    const requested = [ToolCapabilities.FS_READ, ToolCapabilities.NET_OUTBOUND];
    const { granted, dropped } = clampSubagentCapabilities(requested);
    expect(new Set(granted)).toEqual(new Set(requested));
    expect(dropped).toEqual([]);
  });

  it('is a no-op on the ceiling itself', () => {
    const { granted, dropped } = clampSubagentCapabilities([...WIDE_SUBAGENT_CAPABILITIES]);
    expect(granted).toEqual([...WIDE_SUBAGENT_CAPABILITIES]);
    expect(dropped).toEqual([]);
  });

  it('ignores unknown capability strings rather than passing them through', () => {
    const { granted, dropped } = clampSubagentCapabilities(['not.a.real.capability']);
    expect(granted).toEqual([]);
    expect(dropped).toEqual(['not.a.real.capability']);
  });
});

describe('applyProjectAgentConfig — repo-committed config cannot escalate', () => {
  const base: SubagentConfig = { name: 'worker' } as SubagentConfig;

  it('clamps a custom role that asks for everything', () => {
    // The clone-and-run case: a hostile repo ships an agent config granting the
    // capabilities that escape the task's blast radius.
    const result = applyProjectAgentConfig(base, {
      allowedCapabilities: [
        ToolCapabilities.FS_READ,
        ToolCapabilities.FS_WRITE_OUTSIDE_PROJECT,
        ToolCapabilities.CONFIG_MUTATE,
        ToolCapabilities.TOOL_MUTATE_ANY,
      ],
    } as never);

    expect(result.allowedCapabilities).toEqual([ToolCapabilities.FS_READ]);
    expect(result.allowedCapabilities).not.toContain(ToolCapabilities.FS_WRITE_OUTSIDE_PROJECT);
    expect(result.allowedCapabilities).not.toContain(ToolCapabilities.CONFIG_MUTATE);
  });

  it('clamps even under protectSystemRole, which UNIONS rather than restricts', () => {
    // protectSystemRole guards the role's identity, not its blast radius: it
    // merges the project's list into the base one. That is a widening, so it is
    // not a substitute for the clamp.
    const protectedBase: SubagentConfig = {
      name: 'reviewer',
      allowedCapabilities: [ToolCapabilities.FS_READ],
    } as SubagentConfig;

    const result = applyProjectAgentConfig(
      protectedBase,
      { allowedCapabilities: [ToolCapabilities.CONFIG_MUTATE] } as never,
      { protectSystemRole: true },
    );

    expect(result.allowedCapabilities).toEqual([ToolCapabilities.FS_READ]);
  });

  it('still lets a repo config NARROW a grant', () => {
    const wideBase: SubagentConfig = {
      name: 'worker',
      allowedCapabilities: [...WIDE_SUBAGENT_CAPABILITIES],
    } as SubagentConfig;

    const result = applyProjectAgentConfig(wideBase, {
      allowedCapabilities: [ToolCapabilities.FS_READ],
    } as never);

    expect(result.allowedCapabilities).toEqual([ToolCapabilities.FS_READ]);
  });
});
