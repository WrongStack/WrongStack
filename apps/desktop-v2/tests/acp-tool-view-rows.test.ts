/**
 * An ACP agent's own tool call arrives named by the agent's title ("Read D:\app\src\a.ts") with
 * the agent's raw input; the engine adds `view`, the WrongStack tool it matches. The conversation
 * showed the raw title, an empty target and no diff counts; it now shows the matching tool.
 */
import { describe, expect, it } from 'vitest';
import { chatSteps } from '../src/chat-steps-model';
import type { EngineEvent } from '../src/engine-state';
import { activityRows } from '../src/session-activity-model';
import { turnToolSummary } from '../src/turn-tools';

const title = 'Edit D:\\app\\src\\Sidebar.tsx';
const events: EngineEvent[] = [
  {
    type: 'tool.started',
    payload: {
      id: 'c1',
      agentId: 'leader',
      name: title,
      input: { file_path: 'D:\\app\\src\\Sidebar.tsx', old_string: 'a', new_string: 'b\nc' },
      view: {
        name: 'edit',
        input: { path: 'src/Sidebar.tsx', old_string: 'a', new_string: 'b\nc' },
      },
    },
  },
  {
    type: 'tool.executed',
    payload: {
      id: 'c1',
      agentId: 'leader',
      name: title,
      ok: true,
      outsideConversation: true,
      view: { name: 'edit' },
    },
  },
  {
    type: 'tool.started',
    payload: {
      id: 'c2',
      name: 'mcp__wrongstack__codebase_search',
      view: { name: 'codebase_search', input: { query: 'x' }, server: 'wrongstack' },
    },
  },
] as EngineEvent[];

describe('ACP tool views in the conversation', () => {
  it('rows take the view name and input, keeping the agent title and MCP server aside', () => {
    const rows = activityRows(events);
    expect(rows[0]).toMatchObject({
      title: 'edit',
      agentTitle: title,
      input: { path: 'src/Sidebar.tsx', old_string: 'a', new_string: 'b\nc' },
      status: 'done',
    });
    expect(rows[1]).toMatchObject({ title: 'codebase_search', server: 'wrongstack' });
    const [edit] = chatSteps(rows, false);
    expect(edit).toMatchObject({
      kind: 'tool',
      verb: 'edited',
      target: 'src/Sidebar.tsx',
      added: 2,
      removed: 1,
    });
  });

  it("the turn summary counts the view's tool", () => {
    expect(turnToolSummary(events).text).toBe('edit');
  });
});
