import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { Context } from '../../src/core/context.js';
import { makeAgentSubagentRunner } from '../../src/coordination/agent-subagent-runner.js';
import { Director } from '../../src/coordination/director.js';
import { makeMutationTestTool } from '../../src/coordination/director-mutation-test-tool.js';
import { FLEET_ROSTER } from '../../src/coordination/fleet.js';
import { planMutations } from '../../src/coordination/mutation-engine.js';
import { makeSubagentResultTool } from '../../src/coordination/subagent-result-tool.js';
import { DefaultErrorHandler } from '../../src/execution/error-handler.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import { Container } from '../../src/kernel/container.js';
import { EventBus } from '../../src/kernel/events.js';
import { TOKENS } from '../../src/kernel/tokens.js';
import { ProviderRegistry } from '../../src/registry/provider-registry.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import type { Tool } from '../../src/types/tool.js';
import { type ScriptedResponse, MockProvider } from '../helpers/mock-provider.js';

/**
 * End-to-end Chaos Monkey integration: a REAL Agent.run() drives the chaos
 * task (scripted LLM: submit_result tool call → fenced-JSON final text),
 * through makeAgentSubagentRunner → real Director → mutation_test tool.
 * This is the proof that the flow works through the production adapters,
 * not stubs.
 */

const FIXTURE_REL = 'packages/core/tests/coordination/__mutation_fixture__/subject.ts';

let cleanupDirs: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  cleanupDirs = [];
});

/** Real Agent fixture mirroring tests/core/agent.test.ts buildAgent(). */
async function buildRealAgent(scriptedResponses: ScriptedResponse[]) {
  const provider = new MockProvider(scriptedResponses);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-chaos-'));
  cleanupDirs.push(tmp);
  const trustFile = path.join(tmp, 'trust.json');

  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error' }));
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.TokenCounter, () => new DefaultTokenCounter());
  container.bind(
    TOKENS.PermissionPolicy,
    () => new DefaultPermissionPolicy({ trustFile, yolo: true }),
  );

  const tools = new ToolRegistry();
  const submitResult: Tool = makeSubagentResultTool();
  tools.register(submitResult);

  const events = new EventBus();
  const sessionStore = new DefaultSessionStore({ dir: path.join(tmp, 'sessions') });
  const session = await sessionStore.create({ id: '', model: 'test', provider: 'mock' });
  const ctx = new Context({
    systemPrompt: [{ type: 'text', text: 'You are the Chaos Monkey test agent.' }],
    provider,
    session,
    signal: new AbortController().signal,
    tokenCounter: container.resolve(TOKENS.TokenCounter),
    cwd: tmp,
    projectRoot: tmp,
    model: 'test-model',
  });
  const toolExecutor = new ToolExecutor(tools, {
    permissionPolicy: container.resolve(TOKENS.PermissionPolicy),
    secretScrubber: container.resolve(TOKENS.SecretScrubber),
    events,
    confirmAwaiter: undefined,
    iterationTimeoutMs: 300_000,
    perIterationOutputCapBytes: 100_000,
    tracer: undefined,
  });
  const agent = new Agent({
    container,
    tools,
    providers: new ProviderRegistry(),
    events,
    pipelines: createDefaultPipelines(),
    context: ctx,
    maxIterations: 6,
    toolExecutor,
  });
  return { agent, events, provider };
}

describe('mutation_test through a real Agent.run()', () => {
  it('drives the chaos task end-to-end and reports an honest pass', async () => {
    const root = process.cwd();
    const source = await fs.readFile(path.join(root, FIXTURE_REL), 'utf8');
    const plan = planMutations(FIXTURE_REL, source, { maxPerFile: 10 });
    expect(plan.length).toBeGreaterThan(0);

    // Scripted chaos LLM: iteration 1 = submit_result call, iteration 2 =
    // final text with the fenced JSON mutants report (per chaos-monkey.md).
    const mutantsJson = JSON.stringify({
      summary: `${plan.length} killed / 0 survived`,
      mutants: plan.map((m) => ({
        id: m.id,
        file: m.file,
        line: m.line,
        kind: m.kind,
        status: 'killed',
        evidence: 'expected 5, received -1',
      })),
    });

    const { agent, events } = await buildRealAgent([
      {
        content: [
          {
            type: 'tool_use',
            id: 'tu-submit',
            name: 'submit_result',
            input: {
              summary: 'All mutants killed.',
              findings: plan.map((m) => `${m.id} killed`),
              files_examined: [FIXTURE_REL],
              confidence: 0.95,
              suggested_next_steps: [],
            },
          },
        ],
        stopReason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: `Mutation report:\n\`\`\`json\n${mutantsJson}\n\`\`\`` }],
        stopReason: 'end_turn',
      },
    ]);

    const runner = makeAgentSubagentRunner({
      factory: async () => ({ agent, events }),
    });
    const director = new Director({
      config: {
        coordinatorId: 'chaos-itest',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 2,
      },
      runner,
    });

    const tool = makeMutationTestTool(director, FLEET_ROSTER, { projectRoot: root });
    const out = (await tool.execute(
      { targets: [FIXTURE_REL], testCommand: 'echo chaos-pass', maxPerFile: 10 },
      { projectRoot: root } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;

    expect(out['verdict']).toBe('pass');
    expect(out['passed']).toBe(true);
    expect(out['planned']).toBe(plan.length);
    expect(out['killed']).toBe(plan.length);
    expect(out['survived']).toBe(0);
    expect(out['strengthenAttempts']).toBe(0);
    expect(out['nextAction']).toBe('accept');
  });

  it('drives a survivor through the strengthen loop with a real Agent', async () => {
    const root = process.cwd();
    const source = await fs.readFile(path.join(root, FIXTURE_REL), 'utf8');
    const plan = planMutations(FIXTURE_REL, source, { maxPerFile: 10 });
    expect(plan.length).toBeGreaterThan(0);

    // Iteration scripts, one per chaos/strengthen task. Survivors first pass
    // via a real Agent final text; then the strengthen agent (also a real
    // Agent) finishes; then the re-verify chaos pass kills the survivor.
    const reportFor = (statuses: (m: (typeof plan)[number]) => 'killed' | 'survived') =>
      JSON.stringify({
        summary: 'report',
        mutants: plan.map((m) => ({
          id: m.id,
          file: m.file,
          line: m.line,
          kind: m.kind,
          status: statuses(m),
        })),
      });

    // The factory must return a FRESH agent per task (isolation contract):
    // call 1 = chaos pass 1 (everything survives), call 2 = strengthen,
    // call 3 = chaos re-verify (survivors die). Each is a real Agent.run().
    let calls = 0;
    const runner = makeAgentSubagentRunner({
      factory: async () => {
        calls++;
        const script: ScriptedResponse[] =
          calls === 1
            ? [
                {
                  content: [
                    { type: 'text', text: 'Report\n```json\n' + reportFor(() => 'survived') + '\n```' },
                  ],
                  stopReason: 'end_turn',
                },
              ]
            : calls === 2
              ? [{ content: [{ type: 'text', text: 'Tests strengthened.' }], stopReason: 'end_turn' }]
              : [
                  {
                    content: [
                      { type: 'text', text: 'Report\n```json\n' + reportFor(() => 'killed') + '\n```' },
                    ],
                    stopReason: 'end_turn',
                  },
                ];
        return buildRealAgent(script);
      },
    });

    const director = new Director({
      config: {
        coordinatorId: 'chaos-itest-2',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 2,
      },
      runner,
    });
    const repairDirector = director;
    // Spawn the repair subagent explicitly so repairSubagentId exists.
    const repairId = await repairDirector.spawn({ name: 'Repair', role: 'generic' });

    const tool = makeMutationTestTool(director, FLEET_ROSTER, { projectRoot: root });
    const out = (await tool.execute(
      {
        targets: [FIXTURE_REL],
        testCommand: 'echo chaos-pass',
        maxPerFile: 10,
        repairSubagentId: repairId,
        maxStrengthenAttempts: 1,
      },
      { projectRoot: root } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;

    expect(out['survived']).toBe(plan.length);
    expect(out['strengthenAttempts']).toBe(1);
    expect(out['finalSurvivors']).toEqual([]);
    expect(out['passed']).toBe(true);
    expect(out['nextAction']).toBe('accept');
    // Three factory calls = three real Agent.run() executions.
    expect(calls).toBe(3);
  });
});
