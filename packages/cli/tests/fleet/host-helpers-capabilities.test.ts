/**
 * The fleet dispatch path is the third door into `allowedCapabilities`, and it
 * was the one without a clamp.
 *
 * `capability-clamp.test.ts` in core covers the two parsers that DID clamp
 * (`applyProjectAgentConfig` and `kanban-task-inputs`). `resolveSubagentCapabilities`
 * is what `host-subagent-factory.ts:308` actually calls when the director or
 * `kanban_queue` dispatches a subagent, and on that path `subCfg` is model
 * output: `allowedCapabilities` is un-enum'd on those tool schemas and `tools`
 * is a free-form string array.
 *
 * Attacker goal for each test below: get a capability that
 * WIDE_SUBAGENT_CAPABILITIES deliberately withholds into the permission policy
 * of a spawned subagent — directly by naming it, or transitively by naming a
 * tool that carries it. Both must fail closed.
 */
import { describe, expect, it } from 'vitest';
import { ToolCapabilities, WIDE_SUBAGENT_CAPABILITIES } from '@wrongstack/core/security';
import type { SubagentConfig, Tool } from '@wrongstack/core/types';
import { resolveSubagentCapabilities } from '../../src/fleet/host-helpers.js';

const noTools = () => [] as readonly Tool[];

describe('resolveSubagentCapabilities', () => {
  it('drops model-named capabilities that sit above the wide ceiling', () => {
    const granted = resolveSubagentCapabilities(
      {
        allowedCapabilities: [
          ToolCapabilities.FS_READ,
          ToolCapabilities.CONFIG_MUTATE,
          ToolCapabilities.SUBAGENT_SPAWN,
          ToolCapabilities.TOOL_MUTATE_ANY,
        ],
      } as unknown as SubagentConfig,
      noTools,
    );

    expect(granted).toContain(ToolCapabilities.FS_READ);
    expect(granted).not.toContain(ToolCapabilities.CONFIG_MUTATE);
    expect(granted).not.toContain(ToolCapabilities.SUBAGENT_SPAWN);
    expect(granted).not.toContain(ToolCapabilities.TOOL_MUTATE_ANY);
  });

  it('still grants COORDINATION_RESULT_SUBMIT so a clamped subagent can report back', () => {
    // The clamp must not strand a subagent: RESULT_SUBMIT is inside the
    // ceiling, so narrowing an over-broad request never costs it the ability
    // to return its result.
    const granted = resolveSubagentCapabilities(
      { allowedCapabilities: [ToolCapabilities.CONFIG_MUTATE] } as unknown as SubagentConfig,
      noTools,
    );

    expect(granted).toContain(ToolCapabilities.COORDINATION_RESULT_SUBMIT);
  });

  it('does not let a named tool smuggle its capabilities past the ceiling', () => {
    // The transitive route: `tools: ['plugin_manager']` used to union that
    // tool's CONFIG_MUTATE into the grant, which reaches `npx -y <pkg>`.
    const pluginManager = {
      name: 'plugin_manager',
      capabilities: [ToolCapabilities.CONFIG_MUTATE, ToolCapabilities.FS_READ],
    } as unknown as Tool;

    const granted = resolveSubagentCapabilities(
      { tools: ['plugin_manager'] } as unknown as SubagentConfig,
      () => [pluginManager],
    );

    expect(granted).not.toContain(ToolCapabilities.CONFIG_MUTATE);
    expect(granted).toContain(ToolCapabilities.FS_READ);
  });

  it('leaves the default grant untouched when the config names nothing', () => {
    expect(resolveSubagentCapabilities({} as unknown as SubagentConfig, noTools)).toEqual(
      WIDE_SUBAGENT_CAPABILITIES,
    );
  });
});
