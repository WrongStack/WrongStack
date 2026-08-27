import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { createBoard, getBoard } from '@wrongstack/kanban';
import { addCheckToTask, addTask } from '@wrongstack/kanban/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kanbanTool } from '../src/kanban.js';
import { newSignal } from './fixtures.js';

/** Session that owns the board events these tests write. */
const TEST_CONTEXT_SESSION_ID = '2026-08-26/sess_01TESTTOOLSCONTEXT0000000';

/**
 * The card contract map, reachable at last.
 *
 * Seven domain operations (`configureContractGraph`, `upsertContractNode`,
 * `addContractEdge`, `removeContractNode`, `removeContractEdge`,
 * `getContractGraph`, `evaluateTaskContractGraph`) sat on the IPC wire
 * allowlist with no caller anywhere: no tool action, no WebSocket route, no CLI
 * subcommand. The three WebUI panels that render `board.contractGraph`
 * therefore always showed the empty state, and no surface could populate one.
 *
 * These tests pin the agent-facing half of that surface, and specifically that
 * the map stays ADVISORY: writing one must never become a precondition for
 * starting work.
 */
describe('kanban tool — contract map', () => {
  let dir: string;
  const ctx = () =>
    ({ eventSessionId: () => TEST_CONTEXT_SESSION_ID, projectRoot: dir }) as unknown as Context;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-contract-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function seed() {
    const board = await createBoard(dir, {
      title: 'Contract board',
      columns: [{ id: 'todo', title: 'Todo', order: 0 }],
    });
    const added = await addTask(dir, board.id, { title: 'Card under contract' });
    return { boardId: board.id, taskId: added!.task.id };
  }

  const run = (input: Record<string, unknown>) =>
    kanbanTool.execute(input as never, ctx(), { signal: newSignal() });

  const graphOf = async (boardId: string) => (await getBoard(dir, boardId))?.contractGraph;

  it('reports the absent map with the action that starts one', async () => {
    const { boardId } = await seed();
    const result = await run({ action: 'get_contract_graph', boardId });
    expect(result.ok).toBe(true);
    expect(result.contractGraph ?? null).toBeNull();
    expect(result.message).toContain('configure_contract_graph');
  });

  it('configure_contract_graph creates the map, defaulting to advisory', async () => {
    const { boardId } = await seed();
    const result = await run({ action: 'configure_contract_graph', boardId });
    expect(result.ok).toBe(true);
    expect((await graphOf(boardId))?.enforcement).toBe('advisory');
  });

  it('upsert_contract_node adds a node and its relation edge to the card', async () => {
    const { boardId, taskId } = await seed();
    const result = await run({
      action: 'upsert_contract_node',
      boardId,
      taskId,
      contractNodeKind: 'guardrail',
      contractNodeTitle: 'Existing parser behaviour keeps working',
      author: 'agent-1',
    });
    expect(result.ok).toBe(true);

    const graph = await graphOf(boardId);
    expect(graph?.nodes).toHaveLength(1);
    expect(graph?.nodes[0]?.kind).toBe('guardrail');
    // A guardrail node is auto-related to its card with `must_preserve`, so the
    // map is connected without the caller wiring the obvious edge by hand.
    expect(graph?.edges.some((edge) => edge.type === 'must_preserve')).toBe(true);
  });

  it('updates a node in place when given its id', async () => {
    const { boardId, taskId } = await seed();
    const created = await run({
      action: 'upsert_contract_node',
      boardId,
      taskId,
      contractNodeKind: 'risk',
      contractNodeTitle: 'Could regress unicode handling',
    });
    expect(created.ok).toBe(true);
    const nodeId = (await graphOf(boardId))?.nodes[0]?.id;

    const updated = await run({
      action: 'upsert_contract_node',
      boardId,
      taskId,
      contractNodeId: nodeId,
      contractNodeKind: 'risk',
      contractNodeTitle: 'Could regress unicode handling',
      contractNodeState: 'resolved',
    });
    expect(updated.ok).toBe(true);
    const graph = await graphOf(boardId);
    expect(graph?.nodes).toHaveLength(1);
    expect(graph?.nodes[0]?.state).toBe('resolved');
  });

  it('binds a verification node to a real acceptance criterion', async () => {
    const { boardId, taskId } = await seed();
    const board = await addCheckToTask(dir, boardId, taskId, {
      description: 'Parser suite passes',
      type: 'test',
      notes: 'packages/core/tests/parser',
    });
    const checkId = board!.tasks.find((t) => t.id === taskId)!.successCriteria![0]!.id;

    const result = await run({
      action: 'upsert_contract_node',
      boardId,
      taskId,
      contractNodeKind: 'verification',
      contractNodeTitle: 'Parser suite',
      contractCheckId: checkId,
    });
    expect(result.ok).toBe(true);
    expect((await graphOf(boardId))?.nodes[0]?.checkId).toBe(checkId);
  });

  it('rejects a binding to a criterion that is not on the task', async () => {
    const { boardId, taskId } = await seed();
    const result = await run({
      action: 'upsert_contract_node',
      boardId,
      taskId,
      contractNodeKind: 'verification',
      contractNodeTitle: 'Phantom check',
      contractCheckId: 'no-such-check',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('binding not found');
  });

  it('requires a reason before waiving a node', async () => {
    const { boardId, taskId } = await seed();
    const result = await run({
      action: 'upsert_contract_node',
      boardId,
      taskId,
      contractNodeKind: 'guardrail',
      contractNodeTitle: 'Deprecated path stays available',
      contractNodeState: 'waived',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('contractWaiverReason');
  });

  it('adds and removes an edge between two nodes', async () => {
    const { boardId, taskId } = await seed();
    await run({
      action: 'upsert_contract_node',
      boardId,
      taskId,
      contractNodeKind: 'objective',
      contractNodeTitle: 'Ship the new parser',
    });
    await run({
      action: 'upsert_contract_node',
      boardId,
      taskId,
      contractNodeKind: 'verification',
      contractNodeTitle: 'Parser suite',
    });
    const nodes = (await graphOf(boardId))!.nodes;
    const objective = nodes.find((n) => n.kind === 'objective')!;
    const verification = nodes.find((n) => n.kind === 'verification')!;

    const added = await run({
      action: 'add_contract_edge',
      boardId,
      contractEdgeFrom: objective.id,
      contractEdgeTo: verification.id,
      contractEdgeType: 'verified_by',
    });
    expect(added.ok).toBe(true);

    const edge = (await graphOf(boardId))!.edges.find((e) => e.type === 'verified_by')!;
    expect(edge).toBeDefined();

    const removed = await run({
      action: 'remove_contract_edge',
      boardId,
      contractEdgeId: edge.id,
    });
    expect(removed.ok).toBe(true);
    expect((await graphOf(boardId))!.edges.some((e) => e.id === edge.id)).toBe(false);
  });

  it('accepts a bare task id as the card endpoint of an edge', async () => {
    const { boardId, taskId } = await seed();
    await run({
      action: 'upsert_contract_node',
      boardId,
      taskId,
      contractNodeKind: 'artifact',
      contractNodeTitle: 'parser.ts',
    });
    const nodeId = (await graphOf(boardId))!.nodes[0]!.id;

    const result = await run({
      action: 'add_contract_edge',
      boardId,
      contractEdgeFrom: taskId,
      contractEdgeTo: nodeId,
      contractEdgeType: 'affects',
    });
    expect(result.ok).toBe(true);
    expect((await graphOf(boardId))!.edges.some((e) => e.from === `task:${taskId}`)).toBe(true);
  });

  it('removing a node takes its incident edges with it', async () => {
    const { boardId, taskId } = await seed();
    await run({
      action: 'upsert_contract_node',
      boardId,
      taskId,
      contractNodeKind: 'risk',
      contractNodeTitle: 'Throughput regression',
    });
    const nodeId = (await graphOf(boardId))!.nodes[0]!.id;
    expect((await graphOf(boardId))!.edges.length).toBeGreaterThan(0);

    const removed = await run({ action: 'remove_contract_node', boardId, contractNodeId: nodeId });
    expect(removed.ok).toBe(true);
    const graph = await graphOf(boardId);
    expect(graph!.nodes).toHaveLength(0);
    expect(graph!.edges.some((e) => e.from === nodeId || e.to === nodeId)).toBe(false);
  });

  it('get_contract_graph evaluates one card when given a taskId', async () => {
    const { boardId, taskId } = await seed();
    await run({
      action: 'upsert_contract_node',
      boardId,
      taskId,
      contractNodeKind: 'objective',
      contractNodeTitle: 'Ship it',
    });
    const result = await run({ action: 'get_contract_graph', boardId, taskId });
    expect(result.ok).toBe(true);
    expect(result.contractEvaluation).toBeDefined();
    expect(result.contractEvaluation?.taskId).toBe(taskId);
  });

  it('a strict map never becomes a precondition for starting work', async () => {
    // The readiness gate deliberately excludes map structure. Making a strict
    // but empty map block `start_task` would turn an operator review aid into
    // work the model must perform before it may implement anything.
    const { boardId, taskId } = await seed();
    await run({ action: 'configure_contract_graph', boardId, contractEnforcement: 'strict' });

    const started = await run({
      action: 'start_task',
      boardId,
      taskId,
      author: 'agent-1',
      transitionComment: 'Starting despite an empty strict map.',
    });
    expect(started.ok).toBe(true);
  });
});
