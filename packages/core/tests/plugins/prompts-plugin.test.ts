import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultPromptLoader } from '../../src/execution/prompt-loader.js';
import type { Context, SlashCommand } from '../../src/index.js';
import { createPromptsPlugin } from '../../src/plugins/prompts-plugin.js';
import { DefaultPromptStore } from '../../src/storage/prompt-store.js';
import { PromptUsageStore } from '../../src/storage/prompt-usage-store.js';

let dir: string;
let store: DefaultPromptStore;

function makeApi(llm?: unknown) {
  const registered: SlashCommand[] = [];
  const unregister = vi.fn();
  return {
    api: {
      config: {},
      slashCommands: { register: (c: SlashCommand) => registered.push(c), unregister },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      llm,
    } as never,
    registered,
    unregister,
  };
}

const ctx = (over: Record<string, unknown> = {}): Context =>
  ({ model: 'm', ...over }) as never as Context;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompts-plugin-'));
  store = new DefaultPromptStore({ globalPrompts: dir } as never);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

async function withCommand(llm?: unknown): Promise<{
  cmd: SlashCommand;
  unregister: ReturnType<typeof vi.fn>;
  plugin: ReturnType<typeof createPromptsPlugin>;
}> {
  const { api, registered, unregister } = makeApi(llm);
  const plugin = createPromptsPlugin({ store });
  plugin.setup!(api);
  return { cmd: registered[0]!, unregister, plugin };
}

/** SlashCommand.run returns void | result; tests always expect the result branch. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runCmd(cmd: SlashCommand, args: string, c: Context): Promise<any> {
  return cmd.run!(args, c);
}

describe('createPromptsPlugin lifecycle', () => {
  it('registers /prompts on setup and unregisters on teardown; health is ok', async () => {
    const { api, registered, unregister } = makeApi();
    const plugin = createPromptsPlugin({ store });
    plugin.setup!(api);
    expect(registered[0]?.name).toBe('prompts');
    expect(registered.map((command) => command.name)).toEqual([
      'prompts',
      'prompt',
      'prompt-gen',
      'bughunt',
      'perf',
    ]);
    plugin.teardown!(api);
    expect(unregister).toHaveBeenCalledWith('prompts');
    expect(unregister).toHaveBeenCalledWith('bughunt');
    expect(unregister).toHaveBeenCalledWith('perf');
    expect(await plugin.health!()).toMatchObject({ ok: true });
  });

  it('builds a store from paths in plugin options', async () => {
    const { api, registered } = makeApi();
    createPromptsPlugin({ paths: { globalPrompts: dir } as never }).setup!(api);
    expect(await registered[0]!.run!('list', ctx())).toMatchObject({
      message: expect.stringContaining('empty'),
    });
  });

  it('builds a store from api.config.paths', async () => {
    const { registered } = makeApi();
    const api = {
      config: { paths: { globalPrompts: dir } },
      slashCommands: { register: (c: SlashCommand) => registered.push(c), unregister: vi.fn() },
      log: { info: vi.fn() },
    } as never;
    createPromptsPlugin().setup!(api);
    expect(await registered[0]!.run!('', ctx())).toMatchObject({
      message: expect.stringContaining('empty'),
    });
  });

  it('reports unavailable when no store or paths are configured', async () => {
    const { api, registered } = makeApi();
    createPromptsPlugin().setup!(api);
    expect(await registered[0]!.run!('list', ctx())).toMatchObject({
      message: expect.stringContaining('not available'),
    });
  });
});

describe('/prompts command verbs', () => {
  it('list: empty then populated', async () => {
    const { cmd } = await withCommand();
    expect((await runCmd(cmd, 'list', ctx())).message).toContain('empty');
    const entry = store.createNew('My Title', 'body');
    await store.save(entry);
    const out = await runCmd(cmd, '', ctx());
    expect(out.message).toContain('My Title');
    expect(out.message).toContain('Prompt library (1)');
  });

  it('view: usage, no-match, and a match', async () => {
    const { cmd } = await withCommand();
    expect((await runCmd(cmd, 'view', ctx())).message).toContain('Usage');
    expect((await runCmd(cmd, 'view nope', ctx())).message).toContain('No prompt matching');
    await store.save(store.createNew('Hello', 'world'));
    expect((await runCmd(cmd, 'view Hello', ctx())).message).toContain('world');
  });

  it('add: usage and success with quoted title/content', async () => {
    const { cmd } = await withCommand();
    expect((await runCmd(cmd, 'add', ctx())).message).toContain('Usage');
    const out = await runCmd(cmd, 'add "Greeting" "say hi"', ctx());
    expect(out.message).toContain('Added prompt "Greeting"');
    expect((await store.list()).map((e) => e.title)).toContain('Greeting');
  });

  it('delete: usage, no-match, and success', async () => {
    const { cmd } = await withCommand();
    expect((await runCmd(cmd, 'delete', ctx())).message).toContain('Usage');
    expect((await runCmd(cmd, 'rm ghost', ctx())).message).toContain('No prompt matching');
    await store.save(store.createNew('Trash', 'x'));
    expect((await runCmd(cmd, 'delete Trash', ctx())).message).toContain('Deleted');
  });

  it('edit: usage, no-match, and success', async () => {
    const { cmd } = await withCommand();
    expect((await runCmd(cmd, 'edit', ctx())).message).toContain('Usage');
    expect((await runCmd(cmd, 'edit "ghost" "x"', ctx())).message).toContain('No prompt matching');
    await store.save(store.createNew('Doc', 'old'));
    expect((await runCmd(cmd, 'update "Doc" "new content"', ctx())).message).toContain('Updated');
    expect((await store.find('Doc'))[0]?.content).toBe('new content');
  });

  it('extend: usage, missing provider, and LLM enhancement', async () => {
    const { cmd } = await withCommand();
    expect((await runCmd(cmd, 'extend', ctx())).message).toContain('Usage');
    expect((await runCmd(cmd, "extend 'Ghost' make it better", ctx())).message).toContain(
      'No prompt matching',
    );
    await store.save(store.createNew('Letter', 'Dear team'));
    expect((await runCmd(cmd, "extend 'Letter' be formal", ctx())).message).toContain(
      'LLM not available',
    );
    const { cmd: failingLlmCmd } = await withCommand({
      defaults: () => ({ provider: 'test-provider', model: 'test-model' }),
      complete: vi.fn().mockRejectedValue(new Error('provider offline')),
    });
    expect((await runCmd(failingLlmCmd, "extend 'Letter' be formal", ctx())).message).toContain(
      'not changed',
    );
    expect((await store.find('Letter'))[0]?.content).toBe('Dear team');
    const complete = vi.fn(async () => ({
      text: '  Dear esteemed team  ',
      model: 'test-model',
      provider: 'test-provider',
      usage: { input: 1, output: 1 },
      stopReason: 'end_turn',
    }));
    const { cmd: llmCmd } = await withCommand({
      defaults: () => ({ provider: 'test-provider', model: 'test-model' }),
      complete,
    });
    const out = await runCmd(llmCmd, "extend 'Letter' be formal", ctx());
    expect(out.message).toContain('Extended "Letter"');
    expect(complete).toHaveBeenCalledWith(expect.stringContaining('Dear team'), {
      system: 'You improve reusable prompts while preserving their intent and variables.',
      role: 'prompt-refiner',
      maxTokens: 2_048,
    });
    expect((await store.find('Letter'))[0]?.content).toBe('Dear esteemed team');
  });

  it('unknown subcommand reports the available verbs', async () => {
    const { cmd } = await withCommand();
    expect((await runCmd(cmd, 'frobnicate', ctx())).message).toContain('Unknown subcommand');
  });
});

describe('/prompts add structured flags', () => {
  it('parses --category, --description, --tags and --var', async () => {
    const { cmd } = await withCommand();
    const out = await runCmd(
      cmd,
      'add --category coding --description "does a thing" --tags a,b --var name:who "Greet" "Hello {{name}}"',
      ctx(),
    );
    expect(out.message).toContain('Added prompt "Greet"');
    const entry = (await store.list())[0]!;
    expect(entry.category).toBe('coding');
    expect(entry.description).toBe('does a thing');
    expect(entry.tags).toEqual(['a', 'b']);
    expect(entry.variables).toEqual([{ name: 'name', description: 'who', required: true }]);
  });

  it('parses --var ::multiline and ::enum= richness suffixes', async () => {
    const { cmd } = await withCommand();
    await runCmd(
      cmd,
      'add --var "code:Paste it::multiline,flavor:Regex flavor::enum=PCRE|JS|Python" "Rich" "Use {{flavor}} on {{code}}"',
      ctx(),
    );
    const entry = (await store.list())[0]!;
    expect(entry.variables).toEqual([
      { name: 'code', description: 'Paste it', required: true, multiline: true },
      {
        name: 'flavor',
        description: 'Regex flavor',
        required: true,
        enum: ['PCRE', 'JS', 'Python'],
      },
    ]);
  });

  it('favorite verb sets favorite via the store fallback', async () => {
    const { cmd } = await withCommand();
    await store.save(store.createNew('Star Me', 'x'));
    const out = await runCmd(cmd, 'favorite Star Me', ctx());
    expect(out.message).toContain('Favorited');
    expect((await store.find('Star Me'))[0]?.favorite).toBe(true);
  });
});

describe('/prompt, /prompt-gen, and /bughunt', () => {
  async function withLoaderCommands(): Promise<{
    search: SlashCommand;
    gen: SlashCommand;
    bughunt: SlashCommand;
    loader: DefaultPromptLoader;
    usage: PromptUsageStore;
  }> {
    // Point the loader's user layer at the same dir the store writes to.
    const loader = new DefaultPromptLoader({
      paths: { globalPrompts: dir, inProjectPrompts: path.join(dir, '__noproject') } as never,
    });
    const usage = new PromptUsageStore(path.join(dir, 'prompt-usage.json'));
    // seed a user-layer prompt with a variable
    await store.save(
      store.createNew('Deploy Helper', 'Deploy {{service}} now', ['devops'], {
        category: 'devops',
        description: 'Ship a service',
        variables: [{ name: 'service', required: true }],
      }),
    );
    loader.invalidateCache();
    const { api, registered } = makeApi();
    createPromptsPlugin({ store, loader, usage }).setup!(api);
    return {
      search: registered[1]!,
      gen: registered[2]!,
      bughunt: registered[3]!,
      loader,
      usage,
    };
  }

  it('/prompt with a query returns ranked results', async () => {
    const { search } = await withLoaderCommands();
    const out = await search.run!('deploy', ctx());
    expect(out.message).toContain('Deploy Helper');
    expect(out.message).toContain('deploy-helper');
  });

  it('/prompt insert reports missing required variables', async () => {
    const { search } = await withLoaderCommands();
    const out = await search.run!('insert deploy-helper', ctx());
    expect(out.message).toContain('needs values for: service');
    expect(out.runText).toBeUndefined();
  });

  it('/prompt insert renders and returns runText when vars supplied', async () => {
    const { search } = await withLoaderCommands();
    const out = await search.run!('insert deploy-helper service=api', ctx());
    expect(out.runText).toBe('Deploy api now');
  });

  it('/prompt insert records usage and /prompt recent surfaces it', async () => {
    const { search, usage } = await withLoaderCommands();
    expect((await search.run!('recent', ctx())).message).toContain('No prompt usage yet');
    await search.run!('insert deploy-helper service=api', ctx());
    expect((await usage.get('deploy-helper'))?.count).toBe(1);
    const recent = await search.run!('recent', ctx());
    expect(recent.message).toContain('Deploy Helper');
    expect(recent.message).toContain('×1');
  });

  it('/prompt favorites lists only starred prompts', async () => {
    const { search, loader } = await withLoaderCommands();
    expect((await search.run!('favorites', ctx())).message).toContain('No favorites yet');
    await loader.setFavorite('deploy-helper', true);
    const out = await search.run!('fav', ctx());
    expect(out.message).toContain('Deploy Helper');
    expect(out.message).toContain('Favorites (1)');
  });

  it('/prompt with no loader reports unavailable', async () => {
    const { api, registered } = makeApi();
    createPromptsPlugin({ store }).setup!(api);
    expect((await registered[1]!.run!('anything', ctx())).message).toContain('not available');
  });

  it('/prompts export then import round-trips user prompts', async () => {
    const loader = new DefaultPromptLoader({
      paths: { globalPrompts: dir, inProjectPrompts: path.join(dir, '__noproject') } as never,
    });
    await store.save(store.createNew('Backup Me', 'keep {{x}}', ['t'], { category: 'coding' }));
    loader.invalidateCache();
    const { api, registered } = makeApi();
    createPromptsPlugin({ store, loader }).setup!(api);
    const prompts = registered[0]!;

    const exp = await prompts.run!('export backup.json', ctx({ projectRoot: dir }));
    expect(exp.message).toContain('Exported 1 prompt');

    // Wipe the user store, then import the backup back in.
    for (const e of await store.list()) await store.delete(e.id);
    loader.invalidateCache();
    expect((await loader.list()).filter((e) => e.source !== 'builtin')).toHaveLength(0);

    const imp = await prompts.run!('import backup.json', ctx({ projectRoot: dir }));
    expect(imp.message).toContain('Imported 1 prompt');
    const restored = (await loader.list()).find((e) => e.slug === 'backup-me');
    expect(restored?.content).toBe('keep {{x}}');
    expect(restored?.category).toBe('coding');
  });

  it('/prompt-gen returns runText to drive the agent', async () => {
    const { gen } = await withLoaderCommands();
    const out = await gen.run!('', ctx());
    expect(out.runText).toContain('prompt-engineering');
    expect(out.runText).toContain('/prompts add');
  });

  it('/prompt-gen list shows library entries', async () => {
    const { gen } = await withLoaderCommands();
    const out = await gen.run!('list', ctx());
    expect(out.message).toContain('Deploy Helper');
  });

  it('/bughunt runs the canonical prompt and appends an optional target', async () => {
    await store.save(
      store.createNew('Proof-Driven Bug Hunter', 'Hunt exactly one proven bug.', ['bug'], {
        category: 'debugging',
      }),
    );
    const { bughunt, usage } = await withLoaderCommands();
    const session = { id: 'bughunt-session', append: vi.fn(async () => undefined) };
    const commandContext = ctx({ messages: [], meta: {}, session });

    const wholeProject = await bughunt.run!('', commandContext);
    expect(wholeProject.runText).toBe('Hunt exactly one proven bug.');
    expect(wholeProject.message).toContain('current project');
    expect(session.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subagent_policy', allowed: false }),
    );

    const targeted = await bughunt.run!('packages/core/storage', commandContext);
    expect(targeted.runText).toContain('Hunt exactly one proven bug.');
    expect(targeted.runText).toContain('packages/core/storage');
    expect(targeted.message).toContain('packages/core/storage');
    expect((await usage.get('proof-driven-bug-hunter'))?.count).toBe(2);
  });

  it('/bughunt parses an optional 1-25 TUI round limit without treating it as scope', async () => {
    await store.save(
      store.createNew('Proof-Driven Bug Hunter', 'Hunt exactly one proven bug.', ['bug'], {
        category: 'debugging',
      }),
    );
    const { bughunt } = await withLoaderCommands();
    const session = { id: 'bughunt-rounds', append: vi.fn(async () => undefined) };
    const out = await bughunt.run!(
      '--rounds 25 packages/tui',
      ctx({ messages: [], meta: {}, session }),
    );
    expect(out.runText).toContain('packages/tui');
    expect(out.runText).not.toContain('--rounds 25');

    const invalid = await bughunt.run!('--rounds 26', ctx({ messages: [], meta: {}, session }));
    expect(invalid.message).toContain('1..25');
    expect(invalid.runText).toBeUndefined();
  });

  it('/bughunt refuses to start after a non-solo session is locked', async () => {
    await store.save(
      store.createNew('Proof-Driven Bug Hunter', 'Hunt exactly one proven bug.', ['bug'], {
        category: 'debugging',
      }),
    );
    const { bughunt, usage } = await withLoaderCommands();
    const session = { id: 'bughunt-locked', append: vi.fn(async () => undefined) };

    const out = await bughunt.run!(
      '',
      ctx({
        messages: [{ role: 'user', content: 'already started' }],
        meta: {},
        session,
      }),
    );

    expect(out.runText).toBeUndefined();
    expect(out.message).toContain('could not start');
    expect(out.message).toContain('locked after the session starts');
    expect(session.append).not.toHaveBeenCalled();
    expect(await usage.get('proof-driven-bug-hunter')).toBeUndefined();
  });

  it('/bughunt reports an unavailable canonical prompt without running', async () => {
    const { bughunt } = await withLoaderCommands();
    const out = await bughunt.run!('', ctx());
    expect(out.runText).toBeUndefined();
    expect(out.message).toContain('proof-driven-bug-hunter');
  });
});

describe('parseTitleContent (via add)', () => {
  it('handles single-quotes, single-quote+rest, bare word, and space split', async () => {
    const { cmd } = await withCommand();
    await runCmd(cmd, "add 'Quoted' 'single content'", ctx());
    await runCmd(cmd, "add 'Mixed' the rest is content", ctx());
    await runCmd(cmd, 'add BareWord', ctx()); // no space → title only, empty content
    await runCmd(cmd, 'add Spaced rest of the content', ctx()); // first space splits
    const titles = (await store.list()).map((e) => e.title).sort();
    expect(titles).toEqual(['BareWord', 'Mixed', 'Quoted', 'Spaced']);
  });
});
