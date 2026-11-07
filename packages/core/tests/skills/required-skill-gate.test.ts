import type { ToolUseBlock } from '@wrongstack/contracts/types/blocks';
import type { Message } from '@wrongstack/contracts/types/messages';
import type { SessionEvent } from '@wrongstack/contracts/types/session-events';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { describe, expect, it, vi } from 'vitest';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import {
  armRequiredSkills,
  markRequiredSkillLoaded,
  markRequiredSkillUnavailable,
  parseRequiredSkillsMarker,
  pendingRequiredSkills,
  REQUIRED_SKILLS_META_KEY,
  readRequiredSkillsState,
  restoreRequiredSkillsFromEvents,
} from '../../src/skills/required-skill-gate.js';
import { createMockTool } from '../helpers/test-harness.js';

const MARKER = '<!-- wrongstack:required-skills bug-hunter testing -->';

function metaCtx(): { meta: Record<string, unknown> } {
  return { meta: {} };
}

describe('required-skill marker', () => {
  it('parses the named skills, dropping invalid and duplicate names', () => {
    expect(
      parseRequiredSkillsMarker(
        'Hunt.\n<!-- wrongstack:required-skills bug-hunter Testing testing ../x bad_name -->',
      ),
    ).toEqual(['bug-hunter', 'testing']);
  });

  it('ignores text without a marker, an empty marker, and a mere mention', () => {
    expect(parseRequiredSkillsMarker('Load $bug-hunter first.')).toBeUndefined();
    expect(parseRequiredSkillsMarker('<!-- wrongstack:required-skills   -->')).toBeUndefined();
    expect(parseRequiredSkillsMarker('<!-- wrongstack-bug-hunt scope="" -->')).toBeUndefined();
  });

  it('parses across multiple markers and skips empty prefix markers', () => {
    expect(
      parseRequiredSkillsMarker(
        '<!-- wrongstack:required-skills -->\n<!-- wrongstack:required-skills bug-hunter -->\nSome text\n<!-- wrongstack:required-skills testing -->',
      ),
    ).toEqual(['bug-hunter', 'testing']);
  });
});

describe('required-skill state', () => {
  it('stays pending until each skill is loaded or reported unavailable', () => {
    const ctx = metaCtx();
    expect(armRequiredSkills(ctx, MARKER)).toBe(true);
    expect(pendingRequiredSkills(ctx)).toEqual(['bug-hunter', 'testing']);

    markRequiredSkillLoaded(ctx, 'Bug-Hunter');
    markRequiredSkillLoaded(ctx, 'debugging'); // not required: ignored
    expect(pendingRequiredSkills(ctx)).toEqual(['testing']);

    markRequiredSkillUnavailable(ctx, 'testing');
    expect(pendingRequiredSkills(ctx)).toEqual([]);
  });

  it('a new marker starts over, and a message without one leaves the gate alone', () => {
    const ctx = metaCtx();
    armRequiredSkills(ctx, MARKER);
    markRequiredSkillLoaded(ctx, 'bug-hunter');
    expect(armRequiredSkills(ctx, "This is round 2/3; we're continuing the bug hunt.")).toBe(false);
    expect(pendingRequiredSkills(ctx)).toEqual(['testing']);

    armRequiredSkills(ctx, MARKER);
    expect(pendingRequiredSkills(ctx)).toEqual(['bug-hunter', 'testing']);
  });

  it('marks nothing and gates nothing before a marker arms it', () => {
    const ctx = metaCtx();
    markRequiredSkillLoaded(ctx, 'bug-hunter');
    expect(ctx.meta[REQUIRED_SKILLS_META_KEY]).toBeUndefined();
    expect(pendingRequiredSkills(ctx)).toEqual([]);
    expect(pendingRequiredSkills(undefined)).toEqual([]);
  });

  it('rebuilds from the journal and drops the previous session gate', () => {
    const ctx = metaCtx();
    armRequiredSkills(ctx, '<!-- wrongstack:required-skills other-skill -->');
    const events: SessionEvent[] = [
      { type: 'user_input', ts: 't1', content: [{ type: 'text', text: `Hunt.\n${MARKER}` }] },
      { type: 'skill_activated', ts: 't2', skillName: 'bug-hunter' },
      { type: 'user_input', ts: 't3', content: 'This is round 2/3.' },
    ] as SessionEvent[];

    restoreRequiredSkillsFromEvents(ctx, events);
    expect(pendingRequiredSkills(ctx)).toEqual(['testing']);

    restoreRequiredSkillsFromEvents(ctx, []);
    expect(ctx.meta[REQUIRED_SKILLS_META_KEY]).toBeUndefined();
  });
});

describe('required-skill state against the transcript', () => {
  const skillCall = (id: string, name: string): Message => ({
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'skill', input: { name } }],
  });
  const skillResult = (id: string, content = 'body'): Message => ({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content }],
  });

  function loadedCtx(messages: Message[]) {
    const ctx = { meta: {} as Record<string, unknown>, messages };
    armRequiredSkills(ctx, '<!-- wrongstack:required-skills bug-hunter -->');
    markRequiredSkillLoaded(ctx, 'bug-hunter', 's1');
    return ctx;
  }

  it('keeps a skill loaded while its delivering call and result are intact', () => {
    expect(
      pendingRequiredSkills(loadedCtx([skillCall('s1', 'bug-hunter'), skillResult('s1')])),
    ).toEqual([]);
  });

  it('counts a delivery whose result is not appended yet (same batch) as loaded', () => {
    expect(pendingRequiredSkills(loadedCtx([skillCall('s1', 'bug-hunter')]))).toEqual([]);
  });

  it('makes a skill pending again once compaction removes its delivery', () => {
    const digest: Message = { role: 'system', content: '[prior_turns_digest: …]' };
    expect(pendingRequiredSkills(loadedCtx([digest]))).toEqual(['bug-hunter']);
  });

  it('makes a skill pending again once compaction elides its result or input', () => {
    expect(
      pendingRequiredSkills(
        loadedCtx([skillCall('s1', 'bug-hunter'), skillResult('s1', '[elided: ~4000 tokens]')]),
      ),
    ).toEqual(['bug-hunter']);
    const elidedInput: Message = {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 's1',
          name: 'skill',
          input: { __elided_tool_input: '~10 tokens', tool: 'skill', fields: {} },
        },
      ],
    };
    expect(pendingRequiredSkills(loadedCtx([elidedInput, skillResult('s1')]))).toEqual([
      'bug-hunter',
    ]);
  });

  it('a reload replaces the recorded delivery', () => {
    const messages: Message[] = [];
    const ctx = loadedCtx(messages);
    expect(pendingRequiredSkills(ctx)).toEqual(['bug-hunter']);
    messages.push(skillCall('s2', 'bug-hunter'), skillResult('s2'));
    markRequiredSkillLoaded(ctx, 'bug-hunter', 's2');
    expect(pendingRequiredSkills(ctx)).toEqual([]);
  });

  it('after a resume, finds the delivery by skill name in the restored transcript', () => {
    const events = [
      { type: 'user_input', ts: 't1', content: '<!-- wrongstack:required-skills bug-hunter -->' },
      { type: 'skill_activated', ts: 't2', skillName: 'bug-hunter' },
    ] as SessionEvent[];
    const withDelivery = {
      meta: {} as Record<string, unknown>,
      messages: [skillCall('old', 'bug-hunter'), skillResult('old')],
    };
    restoreRequiredSkillsFromEvents(withDelivery, events);
    expect(pendingRequiredSkills(withDelivery)).toEqual([]);

    const compacted = { meta: {} as Record<string, unknown>, messages: [] as Message[] };
    restoreRequiredSkillsFromEvents(compacted, events);
    expect(pendingRequiredSkills(compacted)).toEqual(['bug-hunter']);
  });

  it('clears unavailable status when a skill is loaded and restores gating after compaction', () => {
    const ctx = loadedCtx([skillCall('s1', 'bug-hunter'), skillResult('s1')]);
    markRequiredSkillUnavailable(ctx, 'bug-hunter');
    expect(pendingRequiredSkills(ctx)).toEqual([]);

    markRequiredSkillLoaded(ctx, 'bug-hunter', 's1');
    expect(readRequiredSkillsState(ctx)?.unavailable).toEqual([]);
    expect(pendingRequiredSkills(ctx)).toEqual([]);

    ctx.messages = [{ role: 'system', content: '[prior_turns_digest: ...]' }];
    expect(pendingRequiredSkills(ctx)).toEqual(['bug-hunter']);
  });

  it('recognizes a skill loaded through the tool_use gateway with a nested ~1 id', () => {
    const gatewayCall: Message = {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'u1',
          name: 'tool_use',
          input: { tool: 'skill', input: { name: 'bug-hunter' } },
        },
      ],
    };
    const gatewayResult: Message = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'body' }],
    };
    const ctx = { meta: {} as Record<string, unknown>, messages: [gatewayCall, gatewayResult] };
    armRequiredSkills(ctx, '<!-- wrongstack:required-skills bug-hunter -->');
    markRequiredSkillLoaded(ctx, 'bug-hunter', 'u1~1');
    expect(pendingRequiredSkills(ctx)).toEqual([]);
  });

  it('does not treat a gateway call for another skill as satisfying a required skill, rejects parent-traversal in declaredPathMatch, and recognizes gateway file edits in skillSpeedBump (F96)', async () => {
    const { declaredPathMatch } = await import('../../src/skills/skill-path-rules.js');
    const { recommendSkills, skillSpeedBump } = await import(
      '../../src/skills/skill-speed-bump.js'
    );

    const otherSkillCall: Message = {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'u1',
          name: 'tool_use',
          input: { tool: 'skill', input: { name: 'other-skill' } },
        },
      ],
    };
    const otherSkillResult: Message = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'body' }],
    };
    const gateCtx = {
      meta: {} as Record<string, unknown>,
      messages: [otherSkillCall, otherSkillResult],
    };
    armRequiredSkills(gateCtx, '<!-- wrongstack:required-skills target-skill -->');
    markRequiredSkillLoaded(gateCtx, 'target-skill', 'u1~2');
    expect(pendingRequiredSkills(gateCtx)).toEqual(['target-skill']);

    expect(
      declaredPathMatch({ paths: ['**/*.ts'] }, '../outside/secret.ts', '/proj'),
    ).toBeUndefined();
    expect(
      declaredPathMatch({ paths: ['**/*.ts'] }, '../outside/secret.ts', undefined),
    ).toBeUndefined();
    expect(declaredPathMatch({ paths: ['src/**/*.ts'] }, 'src/index.ts', '/proj')).toBe(
      'src/**/*.ts',
    );

    const bumpCtx = {
      meta: {} as Record<string, unknown>,
      session: { id: 'sess-bump-f96' },
      messages: [
        { role: 'user', content: 'edit file' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'gw-edit-1',
              name: 'tool_use',
              input: { tool: 'edit', input: { file_path: 'a.ts' } },
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'gw-edit-1', content: 'ok' }],
        },
      ] as Message[],
    };
    recommendSkills(bumpCtx, 'sess-bump-f96', [
      { name: 'code-quality', reason: 'late recommendation' },
    ]);
    expect(
      skillSpeedBump(bumpCtx, { id: 'edit-2', name: 'edit', targets: ['a.ts'] }),
    ).toBeUndefined();
  });
});

describe('ToolExecutor — required-skill gate', () => {
  const noopScrubber = { scrub: (s: string) => s };

  function use(name: string, id: string): ToolUseBlock {
    return { type: 'tool_use', id, name, input: {} };
  }

  function setup(options: { withSkillTool?: boolean } = {}) {
    const edit = createMockTool({ name: 'edit', result: 'edited' });
    edit.mutating = true;
    const read = createMockTool({ name: 'read', result: 'content' });
    const skill = createMockTool({ name: 'skill', result: 'body' });
    const tools: Tool[] = [edit, read, ...(options.withSkillTool === false ? [] : [skill])];
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const exec = new ToolExecutor({ get: (n: string) => byName.get(n), list: () => tools }, {
      permissionPolicy: {
        evaluate: vi.fn().mockResolvedValue({ permission: 'auto', source: 'default' }),
      },
      secretScrubber: noopScrubber,
    } as never);
    const ctx = {
      meta: {} as Record<string, unknown>,
      session: { id: 'gate-session' },
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    return { exec, ctx, editSpy: vi.spyOn(edit, 'execute') };
  }

  it('refuses a mutating tool until the required skills are loaded, and allows reads', async () => {
    const { exec, ctx, editSpy } = setup();
    armRequiredSkills(ctx, MARKER);

    const blocked = await exec.executeBatch(
      [use('edit', 'e1'), use('read', 'r1')],
      ctx as never,
      'sequential',
    );
    const [editOut, readOut] = blocked.outputs;
    expect(editSpy).not.toHaveBeenCalled();
    expect(editOut?.settlement).toBe('denied_by_policy');
    expect(editOut?.result.type === 'tool_result' && editOut.result.content).toContain(
      'bug-hunter, testing',
    );
    expect(readOut?.result.type === 'tool_result' && readOut.result.is_error).toBe(false);

    markRequiredSkillLoaded(ctx, 'bug-hunter');
    markRequiredSkillUnavailable(ctx, 'testing');
    const allowed = await exec.executeBatch([use('edit', 'e2')], ctx as never, 'sequential');
    expect(editSpy).toHaveBeenCalledTimes(1);
    expect(allowed.outputs[0]?.settlement).not.toBe('denied_by_policy');
  });

  it('does not gate a runtime that has no skill tool to satisfy it', async () => {
    const { exec, ctx, editSpy } = setup({ withSkillTool: false });
    armRequiredSkills(ctx, MARKER);
    await exec.executeBatch([use('edit', 'e1')], ctx as never, 'sequential');
    expect(editSpy).toHaveBeenCalledTimes(1);
  });

  it('allows tool_use to invoke skill while required skills are pending, but blocks tool_use on mutating tools', async () => {
    const edit = createMockTool({ name: 'edit', result: 'edited' });
    edit.mutating = true;
    const skill = createMockTool({ name: 'skill', result: 'body' });
    skill.mutating = false;
    const gateway = createMockTool({ name: 'tool_use', result: 'ok' });
    gateway.mutating = true;
    const tools: Tool[] = [edit, skill, gateway];
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const exec = new ToolExecutor({ get: (n: string) => byName.get(n), list: () => tools }, {
      permissionPolicy: {
        evaluate: vi.fn().mockResolvedValue({ permission: 'auto', source: 'default' }),
      },
      secretScrubber: noopScrubber,
    } as never);
    const ctx = {
      meta: {} as Record<string, unknown>,
      session: { id: 'gate-session' },
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    armRequiredSkills(ctx, '<!-- wrongstack:required-skills bug-hunter -->');

    const batch = await exec.executeBatch(
      [
        {
          type: 'tool_use',
          id: 'g-edit',
          name: 'tool_use',
          input: { tool: 'edit', input: {} },
        },
        {
          type: 'tool_use',
          id: 'g-skill',
          name: 'tool_use',
          input: { tool: 'skill', input: { name: 'bug-hunter' } },
        },
      ],
      ctx as never,
      'sequential',
    );
    expect(batch.outputs[0]?.settlement).toBe('denied_by_policy');
    expect(batch.outputs[1]?.settlement).not.toBe('denied_by_policy');
    expect(
      batch.outputs[1]?.result.type === 'tool_result' && batch.outputs[1]?.result.is_error,
    ).toBe(false);
  });
});
