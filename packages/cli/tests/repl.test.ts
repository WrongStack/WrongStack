import type {
  Agent,
  AttachmentStore,
  Context,
  RunResult,
  SlashCommandRegistry,
  TokenCounter,
  TodoItem,
} from '@wrongstack/core';
import { AgentError } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import type { ReadlineInputReader } from '../src/input-reader.js';
import type { TerminalRenderer } from '../src/renderer.js';
import { runRepl } from '../src/repl.js';
import { clearSuggestions } from '../src/slash-commands/suggestion-store.js';

function makeFakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    ctx: {} as Context,
    run: vi.fn(
      async (): Promise<RunResult> => ({ status: 'done', iterations: 1, finalText: 'ok' }),
    ),
    ...overrides,
  } as never as Agent;
}

function makeFakeReader(lines: string[]): ReadlineInputReader {
  let i = 0;
  return {
    // Real readers throw on EOF (Ctrl+D); the REPL relies on that to break
    // its read loop. Returning '' instead would skip-empty and spin forever
    // → V8 heap exhaustion in CI. Throw once the script is exhausted.
    readLine: vi.fn(async () => {
      if (i >= lines.length) throw new Error('EOF');
      return lines[i++] ?? '';
    }),
    close: vi.fn(async () => {}),
  } as never as ReadlineInputReader;
}

function makeFakeRenderer(): TerminalRenderer {
  return {
    write: vi.fn(),
    writeLine: vi.fn(),
    writeBlock: vi.fn(),
    writeToolCall: vi.fn(),
    writeToolResult: vi.fn(),
    writeDiff: vi.fn(),
    writeWarning: vi.fn(),
    writeError: vi.fn(),
    writeInfo: vi.fn(),
    clear: vi.fn(),
    render: vi.fn(),
  } as never as TerminalRenderer;
}

function makeFakeSlashRegistry(): SlashCommandRegistry {
  return {
    dispatch: vi.fn(async () => null),
    register: vi.fn(),
    unregister: vi.fn(),
    list: vi.fn(() => []),
    resolve: vi.fn(),
  } as never as SlashCommandRegistry;
}

function makeFakeAttachmentStore(): AttachmentStore {
  return {
    add: vi.fn(async () => 'fake-id'),
    get: vi.fn(async () => undefined),
    list: vi.fn(() => []),
    remove: vi.fn(async () => {}),
    resolve: vi.fn(),
    clear: vi.fn(async () => {}),
    // expand turns "[pasted #N]" placeholders into ContentBlock[]. For tests
    // we never insert placeholders, so a plain text-block passthrough is
    // sufficient and keeps the InputBuilder.submit path satisfied.
    expand: vi.fn(async (text: string) => [{ type: 'text', text }]),
  } as never as AttachmentStore;
}

function makeFakeTokenCounter(): TokenCounter {
  return {
    reset: vi.fn(),
    add: vi.fn(),
    total: vi.fn(() => ({ input: 100, output: 50, cached: 0 })),
    estimateCost: vi.fn(() => ({ total: 0.01, breakdown: {} })),
    snapshot: vi.fn(),
  } as never as TokenCounter;
}

describe('runRepl', () => {
  it('prints banner when banner option is true', async () => {
    const agent = makeFakeAgent();
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['/exit\n']);
    const slashRegistry = makeFakeSlashRegistry();

    await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: makeFakeAttachmentStore(),
      banner: true,
    });

    expect(renderer.write).toHaveBeenCalled();
    const firstWrite = (renderer.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? '';
    expect(firstWrite).toContain('WrongStack');
  });

  it('dispatches slash commands via registry', async () => {
    const agent = makeFakeAgent();
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['/help\n', '/exit\n']);
    const slashRegistry = makeFakeSlashRegistry();

    await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: makeFakeAttachmentStore(),
      banner: false,
    });

    expect(slashRegistry.dispatch).toHaveBeenCalledWith('/help', agent.ctx);
  });

  it('runs agent with user input', async () => {
    const run = vi.fn(
      async (): Promise<RunResult> => ({
        status: 'done',
        iterations: 2,
        finalText: 'hello world',
      }),
    );
    const agent = makeFakeAgent({ run });
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['hello\n', '/exit\n']);
    const slashRegistry = makeFakeSlashRegistry();

    await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: makeFakeAttachmentStore(),
      banner: false,
    });

    expect(run).toHaveBeenCalled();
  });

  it('asks before sending an unanchored bare continue and cancels on no', async () => {
    clearSuggestions();
    const run = vi.fn();
    const agent = makeFakeAgent({
      run,
      ctx: { todos: [] as TodoItem[] } as Context,
    });
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['continue\n', 'n\n', '/exit\n']);
    const slashRegistry = makeFakeSlashRegistry();

    await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: makeFakeAttachmentStore(),
      banner: false,
    });

    expect(run).not.toHaveBeenCalled();
    expect(reader.readLine).toHaveBeenCalledWith(expect.stringContaining('Proceed anyway?'));
    const writes = (renderer.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0] ?? ''));
    expect(writes.join('')).toContain("'continue' has no anchor");
    expect(writes.join('')).toContain('Cancelled');
  });

  it('uses the dynamic supportsVision resolver when routing image blocks', async () => {
    const image = {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/png', data: 'AAAA' },
    };
    const run = vi.fn(
      async (): Promise<RunResult> => ({
        status: 'done',
        iterations: 1,
        finalText: 'ok',
      }),
    );
    const agent = makeFakeAgent({
      run,
      ctx: {
        provider: { id: 'p', capabilities: { vision: false } },
        model: 'm',
      } as never as Context,
    });
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['see this\n']);
    const slashRegistry = makeFakeSlashRegistry();
    const supportsVision = vi.fn(async () => true);

    await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: {
        ...makeFakeAttachmentStore(),
        expand: vi.fn(async () => [image]),
      } as never as AttachmentStore,
      banner: false,
      supportsVision,
    });

    expect(supportsVision).toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith([image], expect.anything());
  });

  it('skips empty lines without running agent', async () => {
    const run = vi.fn();
    const agent = makeFakeAgent({ run });
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['', '', 'hello\n', '/exit\n']);
    const slashRegistry = makeFakeSlashRegistry();

    await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: makeFakeAttachmentStore(),
      banner: false,
    });

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('shows token stats after agent run when tokenCounter provided', async () => {
    const run = vi.fn(
      async (): Promise<RunResult> => ({
        status: 'done',
        iterations: 1,
        finalText: 'result',
      }),
    );
    const agent = makeFakeAgent({ run });
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['hello\n', '/exit\n']);
    const slashRegistry = makeFakeSlashRegistry();
    const tokenCounter = makeFakeTokenCounter();

    await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: makeFakeAttachmentStore(),
      banner: false,
      tokenCounter,
      effectiveMaxContext: 200_000,
      getEffectiveMaxContext: () => 1_000_000,
    });

    const writes = (renderer.write as ReturnType<typeof vi.fn>).mock.calls;
    const statsLine = writes.find(
      (c: unknown[]) => String(c[0] ?? '').includes('in:') && String(c[0] ?? '').includes('out:'),
    );
    expect(statsLine).toBeDefined();
    expect(String(statsLine?.[0] ?? '')).toContain('/1.0M');
  });

  it('writes error on agent failure', async () => {
    const run = vi.fn(
      async (): Promise<RunResult> => ({
        status: 'failed',
        error: new AgentError({ message: 'oops', code: 'AGENT_RUN_FAILED' }),
        iterations: 1,
      }),
    );
    const agent = makeFakeAgent({ run });
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['hello\n', '/exit\n']);
    const slashRegistry = makeFakeSlashRegistry();

    await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: makeFakeAttachmentStore(),
      banner: false,
    });

    expect(renderer.writeError).toHaveBeenCalledWith(expect.stringContaining('oops'));
  });

  it('writes warning on aborted status', async () => {
    const run = vi.fn(
      async (): Promise<RunResult> => ({
        status: 'aborted',
        iterations: 0,
      }),
    );
    const agent = makeFakeAgent({ run });
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['hello\n', '/exit\n']);
    const slashRegistry = makeFakeSlashRegistry();

    await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: makeFakeAttachmentStore(),
      banner: false,
    });

    expect(renderer.writeWarning).toHaveBeenCalledWith('Aborted.');
  });

  it('writes warning on max_iterations', async () => {
    const run = vi.fn(
      async (): Promise<RunResult> => ({
        status: 'max_iterations',
        iterations: 5,
      }),
    );
    const agent = makeFakeAgent({ run });
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['hello\n', '/exit\n']);
    const slashRegistry = makeFakeSlashRegistry();

    await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: makeFakeAttachmentStore(),
      banner: false,
    });

    expect(renderer.writeWarning).toHaveBeenCalledWith(expect.stringContaining('max iterations'));
  });

  it('closes reader and returns 0 on /exit', async () => {
    const agent = makeFakeAgent();
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['/exit\n']);
    const slashRegistry = makeFakeSlashRegistry();

    const exitCode = await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: makeFakeAttachmentStore(),
      banner: false,
    });

    expect(exitCode).toBe(0);
    expect(reader.close).toHaveBeenCalled();
  });

  it('returns 0 on EOF (Ctrl+D)', async () => {
    const agent = makeFakeAgent();
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['']);
    const slashRegistry = makeFakeSlashRegistry();

    const exitCode = await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: makeFakeAttachmentStore(),
      banner: false,
    });

    expect(exitCode).toBe(0);
  });

  // ── Auto-proceed / suggest autonomy tests ────────────────────────────

  describe('autonomy auto-proceed', () => {
    function makeExitRegistry(): SlashCommandRegistry {
      return {
        dispatch: vi.fn(async (cmd: string) => {
          if (cmd === '/exit' || cmd === '/quit') return { exit: true as const };
          return null;
        }),
        register: vi.fn(),
        unregister: vi.fn(),
        list: vi.fn(() => []),
        resolve: vi.fn(),
      } as never as SlashCommandRegistry;
    }

    it('suggest mode displays suggestions without auto-proceeding', async () => {
      const run = vi.fn(
        async (): Promise<RunResult> => ({
          status: 'done',
          iterations: 1,
          finalText: '<nextsteps>\n1. Run tests\n2. Review diff\n</nextsteps>',
        }),
      );
      const agent = makeFakeAgent({ run });
      const renderer = makeFakeRenderer();
      const reader = makeFakeReader(['hello\n', '/exit\n']);
      const slashRegistry = makeExitRegistry();
      const suggestions: string[] = [];

      await runRepl({
        agent,
        renderer,
        reader,
        slashRegistry,
        attachments: makeFakeAttachmentStore(),
        banner: false,
        getAutonomy: () => 'suggest',
        onSuggestionsParsed: (parsed) => {
          suggestions.length = 0;
          if (parsed) suggestions.push(...parsed);
        },
        getSuggestions: () => suggestions,
      });

      // Key assertion: suggest mode never auto-proceeds.
      // Verify the suggestion text was NOT fed as agent input.
      const allTexts = run.mock.calls
        .map((c: unknown[]) => {
          const blocks = c[0] as Array<{ type: string; text?: string }> | undefined;
          return blocks?.map((b) => b.text ?? '').join(' ') ?? '';
        });
      expect(allTexts.some((t) => t.includes('Run tests'))).toBe(false);
      // Suggestions were displayed
      const writes = (renderer.write as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => String(c[0] ?? ''));
      expect(writes.some((w) => w.includes('Suggested next steps'))).toBe(true);
    });

    it('auto mode with validation=true proceeds after countdown', async () => {
      const finalTexts = [
        '<nextsteps>\n1. Run pnpm test\n2. Commit changes\n</nextsteps>',
        '✅ Tests passed. Ready to commit.\n',
      ];
      let turn = 0;
      const run = vi.fn(
        async (): Promise<RunResult> => ({
          status: 'done',
          iterations: 1,
          finalText: finalTexts[turn++] ?? 'done',
        }),
      );
      const agent = makeFakeAgent({ run });
      const renderer = makeFakeRenderer();
      const reader = makeFakeReader(['hello\n', '/exit\n']);
      const slashRegistry = makeExitRegistry();
      const suggestions: string[] = [];

      await runRepl({
        agent,
        renderer,
        reader,
        slashRegistry,
        attachments: makeFakeAttachmentStore(),
        banner: false,
        getAutonomy: () => 'auto',
        autoProceedDelayMs: 0,
        onSuggestionsParsed: (parsed) => {
          suggestions.length = 0;
          if (parsed) suggestions.push(...parsed);
        },
        getSuggestions: () => suggestions,
      });

      // Suggestion fed directly — no validation gate needed in auto mode
      const allTexts = run.mock.calls
        .map((c: unknown[]) => {
          const blocks = c[0] as Array<{ type: string; text?: string }> | undefined;
          return blocks?.map((b) => b.text ?? '').join(' ') ?? '';
        });
      expect(allTexts.some((t) => t.includes('Run pnpm test'))).toBe(true);
    });

    it('auto mode ignores onValidateAutoProceed — feeds suggestion regardless', async () => {
      const run = vi.fn(
        async (): Promise<RunResult> => ({
          status: 'done',
          iterations: 1,
          finalText: '<nextsteps>\n1. Risky migration\n2. Safe lint\n</nextsteps>',
        }),
      );
      const agent = makeFakeAgent({ run });
      const renderer = makeFakeRenderer();
      const reader = makeFakeReader(['hello\n', '/exit\n']);
      const slashRegistry = makeExitRegistry();
      const suggestions: string[] = [];

      await runRepl({
        agent,
        renderer,
        reader,
        slashRegistry,
        attachments: makeFakeAttachmentStore(),
        banner: false,
        getAutonomy: () => 'auto',
        autoProceedDelayMs: 0,
        onSuggestionsParsed: (parsed) => {
          suggestions.length = 0;
          if (parsed) suggestions.push(...parsed);
        },
        getSuggestions: () => suggestions,
      });

      // The suggestion IS fed — validation gate was removed, auto mode feeds directly
      const allTexts = run.mock.calls
        .map((c: unknown[]) => {
          const blocks = c[0] as Array<{ type: string; text?: string }> | undefined;
          return blocks?.map((b) => b.text ?? '').join(' ') ?? '';
        });
      expect(allTexts.some((t) => t.includes('Risky migration'))).toBe(true);
    });

    it('auto mode stops after the consecutive auto-proceed cap', async () => {
      // The agent suggests next steps on EVERY turn — without the cap this
      // self-feeding loop never returns to the reader (it has spun real
      // sessions at full speed and flooded stdout until OOM).
      const run = vi.fn(
        async (): Promise<RunResult> => ({
          status: 'done',
          iterations: 1,
          finalText: '<nextsteps>\n1. Keep going\n</nextsteps>',
        }),
      );
      const agent = makeFakeAgent({ run });
      const renderer = makeFakeRenderer();
      const reader = makeFakeReader(['hello\n', '/exit\n']);
      const slashRegistry = makeExitRegistry();
      const suggestions: string[] = [];

      await runRepl({
        agent,
        renderer,
        reader,
        slashRegistry,
        attachments: makeFakeAttachmentStore(),
        banner: false,
        getAutonomy: () => 'auto',
        autoProceedDelayMs: 0,
        autoProceedMaxIterations: 25,
        onSuggestionsParsed: (parsed) => {
          suggestions.length = 0;
          if (parsed) suggestions.push(...parsed);
        },
        getSuggestions: () => suggestions,
      });

      // 1 manual turn + 1 post-turn autonomy "continue" run + at most 25
      // auto-proceed turns (the configured cap), then control returns to the
      // reader ('/exit' ends the loop). Unbounded would be ∞ / EOF-throw.
      expect(run.mock.calls.length).toBe(27);
      const warns = (renderer.writeWarning as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
        String(c[0] ?? ''),
      );
      expect(warns.some((w) => w.includes('Auto-proceed paused'))).toBe(true);
    });

    it('auto mode with no validator proceeds directly', async () => {
      const finalTexts = [
        '<nextsteps>\n1. Clean up\n</nextsteps>',
        'Done cleaning.\n',
      ];
      let turn = 0;
      const run = vi.fn(
        async (): Promise<RunResult> => ({
          status: 'done',
          iterations: 1,
          finalText: finalTexts[turn++] ?? 'ok',
        }),
      );
      const agent = makeFakeAgent({ run });
      const renderer = makeFakeRenderer();
      const reader = makeFakeReader(['hello\n', '/exit\n']);
      const slashRegistry = makeExitRegistry();
      const suggestions: string[] = [];

      await runRepl({
        agent,
        renderer,
        reader,
        slashRegistry,
        attachments: makeFakeAttachmentStore(),
        banner: false,
        getAutonomy: () => 'auto',
        autoProceedDelayMs: 0,
        onSuggestionsParsed: (parsed) => {
          suggestions.length = 0;
          if (parsed) suggestions.push(...parsed);
        },
        getSuggestions: () => suggestions,
      });

      // Suggestion "Clean up" was auto-fed (no validator → proceeds directly)
      const allTexts = run.mock.calls
        .map((c: unknown[]) => {
          const blocks = c[0] as Array<{ type: string; text?: string }> | undefined;
          return blocks?.map((b) => b.text ?? '').join(' ') ?? '';
        });
      expect(allTexts.some((t) => t.includes('Clean up'))).toBe(true);
    });

    it('auto mode loops until no more suggestions', async () => {
      const finalTexts = [
        '<nextsteps>\n1. Step one\n2. Step two\n</nextsteps>',
        '<nextsteps>\n1. Step two\n</nextsteps>',
        'No pending actions — everything is up to date.\n',
      ];
      let turn = 0;
      const run = vi.fn(
        async (): Promise<RunResult> => ({
          status: 'done',
          iterations: 1,
          finalText: finalTexts[turn++] ?? 'ok',
        }),
      );
      const agent = makeFakeAgent({ run });
      const renderer = makeFakeRenderer();
      const reader = makeFakeReader(['hello\n', '/exit\n']);
      const slashRegistry = makeExitRegistry();
      const suggestions: string[] = [];

      await runRepl({
        agent,
        renderer,
        reader,
        slashRegistry,
        attachments: makeFakeAttachmentStore(),
        banner: false,
        getAutonomy: () => 'auto',
        autoProceedDelayMs: 0,
        onSuggestionsParsed: (parsed) => {
          suggestions.length = 0;
          if (parsed) suggestions.push(...parsed);
        },
        getSuggestions: () => suggestions,
      });

      // 3 runs: "hello" + auto-proceed "Step one" + auto-proceed "Step two"
      expect(run).toHaveBeenCalledTimes(3);
    });

    it('off mode does not auto-proceed', async () => {
      const run = vi.fn(
        async (): Promise<RunResult> => ({
          status: 'done',
          iterations: 1,
          finalText: '💡 Next steps\n1. Run tests\n',
        }),
      );
      const agent = makeFakeAgent({ run });
      const renderer = makeFakeRenderer();
      const reader = makeFakeReader(['hello\n', '/exit\n']);
      const slashRegistry = makeFakeSlashRegistry();
      const suggestions: string[] = [];

      await runRepl({
        agent,
        renderer,
        reader,
        slashRegistry,
        attachments: makeFakeAttachmentStore(),
        banner: false,
        getAutonomy: () => 'off',
        onSuggestionsParsed: (parsed) => {
          suggestions.length = 0;
          if (parsed) suggestions.push(...parsed);
        },
        getSuggestions: () => suggestions,
      });

      // Only one agent run: user's "hello" input
      expect(run).toHaveBeenCalledTimes(1);
    });
  });

  describe('SIGINT — active SDD parallel run', () => {
    // A `/sdd parallel` run blocks the prompt while it awaits completion, so the
    // first Ctrl+C is the only mid-run stop path. The handler must call the
    // active run's stop() and not fall through to "press again to exit".
    it('stops the active SDD run on the first Ctrl+C', async () => {
      const stop = vi.fn();
      const sddRun = { isRunning: () => true, stop } as never;
      const renderer = makeFakeRenderer();
      const slashRegistry = makeFakeSlashRegistry();
      // The (blocking) `/sdd parallel` dispatch synchronously fires SIGINT to
      // mimic the user pressing Ctrl+C mid-run, then resolves.
      (slashRegistry.dispatch as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        process.emit('SIGINT');
        return null;
      });
      const reader = makeFakeReader(['/sdd parallel\n']);

      await runRepl({
        agent: makeFakeAgent(),
        renderer,
        reader,
        slashRegistry,
        attachments: makeFakeAttachmentStore(),
        banner: false,
        getAutonomy: () => 'off',
        getSddRun: () => sddRun,
      });

      expect(stop).toHaveBeenCalledTimes(1);
    });

    it('does not throw when no SDD run is active', async () => {
      const renderer = makeFakeRenderer();
      const slashRegistry = makeFakeSlashRegistry();
      (slashRegistry.dispatch as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        process.emit('SIGINT');
        return null;
      });
      const reader = makeFakeReader(['/help\n']);

      await expect(
        runRepl({
          agent: makeFakeAgent(),
          renderer,
          reader,
          slashRegistry,
          attachments: makeFakeAttachmentStore(),
          banner: false,
          getAutonomy: () => 'off',
          getSddRun: () => null,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('open todos gate on <nextsteps> handling', () => {
    // The runtime gate on ctx.todos is the single source of truth for
    // <nextsteps> suppression: as long as any todo is pending or
    // in_progress, the in-flight task list takes priority over new prompt
    // suggestions, regardless of autonomy mode.

    function makeAgentWithTodos(
      run: Agent['run'],
      todos: TodoItem[],
    ): Agent {
      return {
        ctx: { todos } as unknown as Context,
        run,
      } as never as Agent;
    }

    it('does not store parsed <nextsteps> when ctx.todos has a pending item', async () => {
      const run = vi.fn(
        async (): Promise<RunResult> => ({
          status: 'done',
          iterations: 1,
          finalText: '<nextsteps>\n1. Run tests\n2. Commit changes\n</nextsteps>',
        }),
      );
      const agent = makeAgentWithTodos(run, [
        { id: '1', content: 'finish refactor', status: 'in_progress' },
      ]);
      const renderer = makeFakeRenderer();
      const reader = makeFakeReader(['hello\n', '/exit\n']);
      const slashRegistry = makeFakeSlashRegistry();
      let stored: string[] | null = ['stale'];
      const getStored = vi.fn(() => stored);

      await runRepl({
        agent,
        renderer,
        reader,
        slashRegistry,
        attachments: makeFakeAttachmentStore(),
        banner: false,
        getAutonomy: () => 'off',
        onSuggestionsParsed: (parsed) => {
          // Mirror what the CLI host does — replace, not append.
          stored = parsed ?? [];
        },
        getSuggestions: getStored,
      });

      // The runtime gated the parse on the open todo, so onSuggestionsParsed
      // received null and the store was cleared to []. Without the gate the
      // store would contain ['Run tests', 'Commit changes'].
      expect(stored).toEqual([]);
    });

    it('stores parsed <nextsteps> when ctx.todos is empty', async () => {
      const run = vi.fn(
        async (): Promise<RunResult> => ({
          status: 'done',
          iterations: 1,
          finalText: '<nextsteps>\n1. Run tests\n2. Commit changes\n</nextsteps>',
        }),
      );
      const agent = makeAgentWithTodos(run, []);
      const renderer = makeFakeRenderer();
      const reader = makeFakeReader(['hello\n', '/exit\n']);
      const slashRegistry = makeFakeSlashRegistry();
      let stored: string[] | null = null;

      await runRepl({
        agent,
        renderer,
        reader,
        slashRegistry,
        attachments: makeFakeAttachmentStore(),
        banner: false,
        getAutonomy: () => 'off',
        onSuggestionsParsed: (parsed) => {
          stored = parsed ?? [];
        },
        getSuggestions: () => stored ?? [],
      });

      expect(stored).toEqual(['Run tests', 'Commit changes']);
    });

    it('stores parsed <nextsteps> when every todo is completed', async () => {
      const run = vi.fn(
        async (): Promise<RunResult> => ({
          status: 'done',
          iterations: 1,
          finalText: '<nextsteps>\n1. Open PR\n</nextsteps>',
        }),
      );
      const agent = makeAgentWithTodos(run, [
        { id: '1', content: 'a', status: 'completed' },
        { id: '2', content: 'b', status: 'completed' },
      ]);
      const renderer = makeFakeRenderer();
      const reader = makeFakeReader(['hello\n', '/exit\n']);
      const slashRegistry = makeFakeSlashRegistry();
      let stored: string[] | null = null;

      await runRepl({
        agent,
        renderer,
        reader,
        slashRegistry,
        attachments: makeFakeAttachmentStore(),
        banner: false,
        getAutonomy: () => 'off',
        onSuggestionsParsed: (parsed) => {
          stored = parsed ?? [];
        },
        getSuggestions: () => stored ?? [],
      });

      expect(stored).toEqual(['Open PR']);
    });

    it('autonomy suggest mode skips the re-prompt + display when todos are open', async () => {
      const run = vi.fn(
        async (): Promise<RunResult> => ({
          status: 'done',
          iterations: 1,
          finalText: 'Did some work.',
        }),
      );
      const agent = makeAgentWithTodos(run, [
        { id: '1', content: 'finish refactor', status: 'pending' },
      ]);
      const renderer = makeFakeRenderer();
      const reader = makeFakeReader(['hello\n', '/exit\n']);
      const slashRegistry = makeFakeSlashRegistry();

      await runRepl({
        agent,
        renderer,
        reader,
        slashRegistry,
        attachments: makeFakeAttachmentStore(),
        banner: false,
        getAutonomy: () => 'suggest',
        onSuggestionsParsed: () => {},
        getSuggestions: () => [],
      });

      // Only one agent run — the user input. The autonomy re-prompt did
      // not fire because the todo list is still in flight.
      expect(run).toHaveBeenCalledTimes(1);

      // Nothing was written about "Suggested next steps".
      const writes = (renderer.write as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) =>
        String(c[0] ?? ''),
      );
      expect(writes.some((w) => w.includes('Suggested next steps'))).toBe(false);
    });

    it('autonomy auto mode keeps re-prompting even when todos are open', async () => {
      // The re-prompt is the auto driver — gating it would silently kill
      // auto mode mid-tasklist. The countdown at the top of the loop is
      // already gated (it consumes getSuggestions(), which is empty while
      // a todo list is in flight), so the two mechanisms don't
      // double-drive the agent.
      const run = vi.fn(
        async (): Promise<RunResult> => ({
          status: 'done',
          iterations: 1,
          finalText: 'worked on it',
        }),
      );
      const agent = makeAgentWithTodos(run, [
        { id: '1', content: 'finish refactor', status: 'in_progress' },
      ]);
      const renderer = makeFakeRenderer();
      const reader = makeFakeReader(['hello\n', '/exit\n']);
      const slashRegistry = makeFakeSlashRegistry();

      await runRepl({
        agent,
        renderer,
        reader,
        slashRegistry,
        attachments: makeFakeAttachmentStore(),
        banner: false,
        getAutonomy: () => 'auto',
        autoProceedDelayMs: 0,
        onSuggestionsParsed: () => {},
        getSuggestions: () => [],
      });

      // At least 2 runs: the user's input + the auto re-prompt.
      expect(run.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
