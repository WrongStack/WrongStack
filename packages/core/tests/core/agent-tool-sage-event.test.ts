/**
 * The `tool.executed` event must carry SAGE-injected memory in its own field,
 * never folded into the `output` preview.
 *
 * Regression: the SAGE middleware appends its block to `result.content`, and
 * the event preview then capped the combined string at 400 chars. For a tool
 * whose own output was short (glob/grep/tree hits), the cut landed INSIDE the
 * appended memory line — the `</memory>` fence was gone, every surface's
 * memory-line regex rejected the block, and the mangled `--- SAGE: … ---` text
 * rendered as ordinary tool output in the WebUI and TUI.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { Context } from '../../src/core/context.js';
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
import { MockProvider } from '../helpers/mock-provider.js';

const HEADER = '--- SAGE: related project knowledge (Memory Injector) ---';
/** Long enough that appending it to any body overruns the 400-char preview. */
const MEMORY_LINE = `- [pattern][high] <memory id="mem_glob_1">${'kanban writes go through the project daemon; '.repeat(6)}</memory> (packages/core/src/kanban.ts) [relation=about_file; tags=kanban,daemon]`;
/** What the SAGE middleware leaves on `result.content` after injecting. */
const SAGE_BLOCK = `${HEADER}\n${MEMORY_LINE}`;

/** Same regex the TUI / WebUI / SimpleUI use to recognise a memory line. */
const SAGE_MEMORY_LINE = /^- \[[^\]]+\](?:\[[^\]]+\])* <memory id="[^"]+">.*<\/memory>(?: .*)?$/;

async function buildAgent(provider: MockProvider, extraTools: Tool[]) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-sage-ev-'));
  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error' }));
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.TokenCounter, () => new DefaultTokenCounter());
  container.bind(
    TOKENS.PermissionPolicy,
    () => new DefaultPermissionPolicy({ trustFile: path.join(tmp, 'trust.json'), yolo: true }),
  );

  const tools = new ToolRegistry();
  for (const tool of extraTools) tools.register(tool);
  const events = new EventBus();
  const sessionStore = new DefaultSessionStore({ dir: path.join(tmp, 'sessions') });
  const session = await sessionStore.create({ id: '', model: 'test', provider: 'mock' });

  const ctx = new Context({
    systemPrompt: [{ type: 'text', text: 'You are a test agent.' }],
    provider,
    session,
    signal: new AbortController().signal,
    tokenCounter: container.resolve(TOKENS.TokenCounter),
    cwd: tmp,
    projectRoot: tmp,
    model: 'test-model',
  });

  const agent = new Agent({
    container,
    tools,
    providers: new ProviderRegistry(),
    events,
    pipelines: createDefaultPipelines(),
    context: ctx,
    maxIterations: 10,
    toolExecutor: new ToolExecutor(tools, {
      permissionPolicy: container.resolve(TOKENS.PermissionPolicy),
      secretScrubber: container.resolve(TOKENS.SecretScrubber),
      events,
      confirmAwaiter: undefined,
      iterationTimeoutMs: 300_000,
      perIterationOutputCapBytes: 100_000,
      tracer: undefined,
    }),
  });
  return { agent, events, tmp };
}

/** A tool whose result already carries the injected block, as the middleware leaves it. */
function toolReturning(name: string, content: string): Tool {
  return {
    name,
    description: '',
    inputSchema: { type: 'object' },
    permission: 'auto',
    mutating: false,
    async execute() {
      return content;
    },
  };
}

interface Executed {
  name: string;
  output?: string | undefined;
  sage?: string[] | undefined;
}

async function runTool(name: string, content: string): Promise<Executed> {
  const provider = new MockProvider([
    { content: [{ type: 'tool_use', id: 'u1', name, input: {} }], stopReason: 'tool_use' },
    { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
  ]);
  const { agent, events, tmp } = await buildAgent(provider, [toolReturning(name, content)]);
  dirs.push(tmp);
  const seen: Executed[] = [];
  events.on('tool.executed', (e) => {
    seen.push({
      name: e.name,
      output: e.output,
      sage: (e as { sage?: string[] | undefined }).sage,
    });
  });
  await agent.run('go');
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

let dirs: string[] = [];
beforeEach(() => {
  dirs = [];
});
afterEach(async () => {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
});

describe('tool.executed SAGE injection field', () => {
  it('keeps the memory block out of the output preview and intact in `sage`', async () => {
    const body = 'packages/a.ts\npackages/b.ts\npackages/c.ts';
    const executed = await runTool('glob', `${body}\n\n${SAGE_BLOCK}`);

    expect(executed.output).toBe(body);
    expect(executed.output).not.toContain('SAGE');
    expect(executed.sage).toEqual([HEADER, MEMORY_LINE]);
  });

  it('never emits a memory line the preview cap sliced open', async () => {
    // A short body + a long memory line is exactly the shape that used to
    // straddle the 400-char cut.
    const executed = await runTool('grep', `hit: packages/a.ts:12\n\n${SAGE_BLOCK}`);
    const lines = executed.sage ?? [];

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) {
      expect(line).toMatch(SAGE_MEMORY_LINE);
      expect(line.endsWith('…')).toBe(false);
    }
  });

  it('omits `sage` when nothing was injected', async () => {
    const executed = await runTool('glob', 'packages/a.ts\npackages/b.ts');
    expect(executed.sage).toBeUndefined();
    expect(executed.output).toBe('packages/a.ts\npackages/b.ts');
  });

  it('still caps the tool body — the SAGE budget is separate, not a bypass', async () => {
    const body = 'x'.repeat(2_000);
    const executed = await runTool('glob', `${body}\n\n${SAGE_BLOCK}`);

    expect(executed.output?.length).toBeLessThanOrEqual(400);
    expect(executed.output?.endsWith('…')).toBe(true);
    // The block survives the body being truncated away entirely.
    expect(executed.sage).toEqual([HEADER, MEMORY_LINE]);
  });

  it('leaves a SAGE-shaped header in real tool output alone', async () => {
    // grep for the heading itself: the "block" has no memory lines, so it is
    // ordinary output and must not be hoisted into `sage`.
    const content = `packages/x.ts:4: ${HEADER}`;
    const executed = await runTool('grep', content);

    expect(executed.sage).toBeUndefined();
    expect(executed.output).toBe(content);
  });
});
