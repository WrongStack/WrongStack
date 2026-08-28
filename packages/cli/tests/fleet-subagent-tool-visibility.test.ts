import type { Tool } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUBAGENT_HIDDEN_TOOLS,
  NEVER_SUBAGENT_TOOLS,
  selectSubagentTools,
} from '../src/fleet/host-helpers.js';

/**
 * Two different strictness levels guard the subagent tool slice, and the
 * difference matters:
 *
 *   - `DEFAULT_SUBAGENT_HIDDEN_TOOLS` hides orchestration controls from the
 *     unrestricted default slice, but a spawn that names one gets it.
 *   - `NEVER_SUBAGENT_TOOLS` is absolute. `nextsteps` lives here because the
 *     runtime only folds a recorded block into a LEADER turn, so handing it to
 *     a subagent yields a permission rejection or a silent no-op — never the
 *     thing the caller was asking for.
 */

function tool(name: string, capabilities: string[] = []): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    permission: 'auto',
    mutating: false,
    capabilities,
    async execute() {
      return 'ok';
    },
  };
}

const ALL_TOOLS: Tool[] = [
  tool('read', ['fs.read']),
  tool('write', ['fs.write']),
  tool('delegate', ['subagent.spawn']),
  tool('nextsteps', ['session.nextsteps']),
];

const NO_DIRECTOR_TOOLS = new Map<string, Tool>();

function names(tools: readonly Tool[]): string[] {
  return tools.map((t) => t.name);
}

describe('subagent tool visibility', () => {
  it('keeps nextsteps out of the unrestricted default slice', () => {
    const selected = names(selectSubagentTools(ALL_TOOLS, NO_DIRECTOR_TOOLS));

    expect(selected).not.toContain('nextsteps');
    // Real work tools still come through — this is a targeted exclusion, not a
    // narrowing of what a subagent can do.
    expect(selected).toEqual(expect.arrayContaining(['read', 'write']));
    expect(selected).toContain('session_note');
    expect(selected).toContain('submit_result');
  });

  it('keeps nextsteps out even when a spawn names it explicitly', () => {
    const selected = names(
      selectSubagentTools(ALL_TOOLS, NO_DIRECTOR_TOOLS, ['read', 'nextsteps']),
    );

    expect(selected).not.toContain('nextsteps');
    expect(selected).toContain('read');
  });

  it('fails closed when a requested roster tool is not registered', () => {
    expect(() =>
      selectSubagentTools(ALL_TOOLS, NO_DIRECTOR_TOOLS, ['read', 'missing_tool']),
    ).toThrow(/Subagent tool contract is not registered: missing_tool/);
  });

  it('still honors an explicit request for a merely default-hidden tool', () => {
    // The contrast that makes the two sets meaningful: `delegate` is hidden by
    // default but grantable on request, whereas `nextsteps` is neither.
    const selected = names(selectSubagentTools(ALL_TOOLS, NO_DIRECTOR_TOOLS, ['delegate']));

    expect(selected).toContain('delegate');
    expect(names(selectSubagentTools(ALL_TOOLS, NO_DIRECTOR_TOOLS))).not.toContain('delegate');
  });

  it('does not let a never-granted name pull in a director tool of the same name', () => {
    const directorTools = new Map<string, Tool>([['nextsteps', tool('nextsteps')]]);

    expect(names(selectSubagentTools(ALL_TOOLS, directorTools, ['nextsteps']))).not.toContain(
      'nextsteps',
    );
  });

  it('keeps the two sets disjoint so each name has one strictness level', () => {
    for (const name of NEVER_SUBAGENT_TOOLS) {
      expect(DEFAULT_SUBAGENT_HIDDEN_TOOLS.has(name)).toBe(false);
    }
  });
});
