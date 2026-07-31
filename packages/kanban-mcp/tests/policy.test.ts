import { kanbanTool } from '@wrongstack/tools/kanban';
import { describe, expect, it } from 'vitest';
import {
  KANBAN_DESTRUCTIVE_ACTIONS,
  KANBAN_MANAGE_ACTIONS,
  KANBAN_READ_ACTIONS,
  selectKanbanMcpTools,
} from '../src/policy.js';

function schemaActions(): string[] {
  const schema = kanbanTool.inputSchema as unknown as {
    properties?: { action?: { enum?: string[] } };
  };
  return schema.properties?.action?.enum ?? [];
}

describe('Kanban MCP policy', () => {
  it('classifies every public Kanban tool action exactly once', () => {
    const classified = [
      ...KANBAN_READ_ACTIONS,
      ...KANBAN_MANAGE_ACTIONS,
      ...KANBAN_DESTRUCTIVE_ACTIONS,
    ];
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual([...schemaActions()].sort());
  });

  it('is read-only with live watch by default', () => {
    expect(selectKanbanMcpTools().map((tool) => tool.name)).toEqual([
      'kanban_read',
      'kanban_watch',
    ]);
  });

  it('adds management without destructive operations for writable mode', () => {
    expect(selectKanbanMcpTools({ writable: true }).map((tool) => tool.name)).toEqual([
      'kanban_read',
      'kanban_watch',
      'kanban_manage',
    ]);
  });

  it('makes destructive mode a superset of writable mode', () => {
    expect(selectKanbanMcpTools({ destructive: true }).map((tool) => tool.name)).toEqual([
      'kanban_read',
      'kanban_watch',
      'kanban_manage',
      'kanban_destructive',
    ]);
  });
});
