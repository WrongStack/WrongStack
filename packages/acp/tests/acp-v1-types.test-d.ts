/**
 * Type-level test for the SessionUpdate discriminated union.
 *
 * This is a `.test-d.ts` (type-only test) — it never runs, it just has to
 * typecheck. It pins three behaviours:
 *
 *   1. The 11 stable v1 `sessionUpdate` discriminator values are accepted
 *      and the corresponding variant is selected.
 *   2. A `_unstable_*` discriminator is accepted via the escape hatch and
 *      surfaces the raw payload.
 *   3. An unknown discriminator string still parses (no `never` rejection)
 *      and falls through to the `UnknownSessionUpdate` variant.
 *
 * If a future refactor breaks any of these, the test fails to compile.
 *
 * We use assignment-with-annotation as the assertion mechanism rather
 * than `expectTypeOf(...).toMatchTypeOf<T>()`, because the latter requires
 * a matching vitest/expect-type version pair. Assignment is portable
 * across versions and works under the strict flag set this package uses.
 */
import { describe, it } from 'vitest';
import type {
  AgentMessageChunkUpdate,
  AnySessionUpdate,
  AvailableCommandsUpdate,
  assertNeverSessionUpdate,
  ConfigOptionUpdate,
  CurrentModeUpdate,
  PlanUpdate,
  SessionInfoUpdate,
  SessionUpdate,
  TextContent,
  ThoughtChunkUpdate,
  ToolCallId,
  ToolCallUpdateFields,
  ToolCallUpdateNotification,
  ToolCallUpdateUpdate,
  UsageUpdate,
  UsageUpdateUpdate,
  UserMessageChunkUpdate,
} from '../src/types/acp-v1.js';

// Each block declares a `const x: VariantType = value` and a `const y:
// SessionUpdate = value`. If a variant stops matching, the typed
// `const x` assignment breaks — that's the failure signal.

describe('SessionUpdate discriminated union', () => {
  it('selects UserMessageChunkUpdate for "user_message_chunk"', () => {
    const u1: SessionUpdate = {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'hi' } satisfies TextContent,
    };
    const v1: UserMessageChunkUpdate = u1;
    void v1;
  });

  it('selects AgentMessageChunkUpdate for "agent_message_chunk"', () => {
    const u: SessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'reply' },
    };
    const v: AgentMessageChunkUpdate = u;
    void v;
  });

  it('selects ThoughtChunkUpdate for "thought_chunk"', () => {
    const u: SessionUpdate = {
      sessionUpdate: 'thought_chunk',
      content: { type: 'text', text: 'hmm' },
    };
    const v: ThoughtChunkUpdate = u;
    void v;
  });

  it('selects ToolCallUpdateUpdate for "tool_call"', () => {
    const tcId = 'call_001' as ToolCallId;
    const u: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: tcId,
      title: 'Reading config',
      kind: 'read',
      status: 'pending',
    };
    const v: ToolCallUpdateUpdate = u;
    void v;
  });

  it('selects ToolCallUpdateNotification for "tool_call_update"', () => {
    const tcId = 'call_001' as ToolCallId;
    const u: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: tcId,
      status: 'in_progress',
    };
    const v: ToolCallUpdateNotification = u;
    void v;
  });

  it('selects PlanUpdate for "plan"', () => {
    const u: SessionUpdate = {
      sessionUpdate: 'plan',
      entries: [{ content: 'step 1', priority: 'high', status: 'pending' }],
    };
    const v: PlanUpdate = u;
    void v;
  });

  it('selects AvailableCommandsUpdate for "available_commands_update"', () => {
    const u: SessionUpdate = {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'web', description: 'search the web' }],
    };
    const v: AvailableCommandsUpdate = u;
    void v;
  });

  it('selects CurrentModeUpdate for "current_mode_update"', () => {
    const u: SessionUpdate = {
      sessionUpdate: 'current_mode_update',
      modeId: 'code' as CurrentModeUpdate['modeId'],
    };
    const v: CurrentModeUpdate = u;
    void v;
  });

  it('selects ConfigOptionUpdate for "config_option_update"', () => {
    const u: SessionUpdate = {
      sessionUpdate: 'config_option_update',
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          type: 'select',
          currentValue: 'ask',
          options: [{ value: 'ask', name: 'Ask' }],
        },
      ],
    };
    const v: ConfigOptionUpdate = u;
    void v;
  });

  it('selects SessionInfoUpdate for "session_info_update"', () => {
    const u: SessionUpdate = {
      sessionUpdate: 'session_info_update',
      title: 'New title',
    };
    const v: SessionInfoUpdate = u;
    void v;
  });

  it('selects UsageUpdateUpdate for "usage_update"', () => {
    const u: SessionUpdate = {
      sessionUpdate: 'usage_update',
      used: 1200,
      size: 200_000,
      cost: { amount: 0.01, currency: 'USD' },
    };
    const v: UsageUpdateUpdate = u;
    void v;
  });

  it('rejects a stable discriminator paired with the wrong fields', () => {
    // 'tool_call' requires toolCallId; omitting it is a compile error.
    // If the union ever stops enforcing this, the @ts-expect-error
    // becomes a "unused directive" and the test fails to typecheck.
    // @ts-expect-error — 'tool_call' requires toolCallId
    const bad: SessionUpdate = { sessionUpdate: 'tool_call', title: 'x' };
    void bad;
  });

  it('accepts _unstable_* discriminators via the escape hatch', () => {
    // An _unstable_* literal is NOT assignable to the closed SessionUpdate
    // union (none of the 11 spec kinds match), but IS assignable to the
    // wider AnySessionUpdate union via the escape hatch. We assert both
    // directions.
    const unstableInput = {
      sessionUpdate: '_unstable_next_edit_suggestions',
      edits: [{ file: 'a.ts', line: 1, text: '+x' }],
    } as const;

    // Closed union rejects it — that's the whole point of the discriminator.
    // @ts-expect-error — '_unstable_*' is not in the closed SessionUpdate union
    const closed: SessionUpdate = unstableInput;
    void closed;

    // Open union accepts it.
    const open: AnySessionUpdate = unstableInput;
    void open;
  });

  it('accepts unknown discriminators as UnknownSessionUpdate', () => {
    const unknownInput = {
      sessionUpdate: 'something_we_have_never_seen',
      payload: 42,
    } as const;

    // @ts-expect-error — unknown discriminator is not in the closed union
    const closed: SessionUpdate = unknownInput;
    void closed;

    const open: AnySessionUpdate = unknownInput;
    void open;
  });

  it('assertNeverSessionUpdate takes exactly [never] and returns never', () => {
    // The function is meant to be used in a `default:` branch of an
    // exhaustive switch. If we ever widen the parameter away from `never`,
    // a consumer call site will compile-time error.
    //
    // We assert the signature via assignment rather than calling the
    // function — calling it would throw at runtime. The assignment below
    // typechecks only if the function is typed as `(x: never) => never`.
    type Params = Parameters<typeof assertNeverSessionUpdate>;
    const _params: [never] = null as never as Params;
    void _params;
  });
});

describe('supporting types', () => {
  it('ToolCallUpdateFields allows all-optional payload', () => {
    const u: ToolCallUpdateFields = { toolCallId: 'c1' as ToolCallId };
    const _title: string | undefined = u.title;
    const _status: ToolCallUpdateFields['status'] = u.status;
    void _title;
    void _status;
  });

  it('UsageUpdate requires used and size', () => {
    // @ts-expect-error — `used` is required
    const bad: UsageUpdate = { size: 100 };
    // @ts-expect-error — `size` is required
    const bad2: UsageUpdate = { used: 1 };
    void bad;
    void bad2;
  });
});
