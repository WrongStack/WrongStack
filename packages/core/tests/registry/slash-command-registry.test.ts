import { describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { SlashCommandRegistry } from '../../src/registry/slash-command-registry.js';

describe('SlashCommandRegistry', () => {
  it('dispatch returns null for non-slash', async () => {
    const r = new SlashCommandRegistry();
    expect(await r.dispatch('hello', {} as Context)).toBeNull();
  });

  it('dispatch returns message for unknown', async () => {
    const r = new SlashCommandRegistry();
    const res = await r.dispatch('/nope', {} as Context);
    expect(res?.message).toMatch(/Unknown/);
  });

  it('dispatches with args', async () => {
    const r = new SlashCommandRegistry();
    let received = '';
    r.register({
      name: 'echo',
      description: 'echo',
      async run(args) {
        received = args;
      },
    });
    await r.dispatch('/echo hi there', {} as Context);
    expect(received).toBe('hi there');
  });

  it('aliases route to same command', async () => {
    const r = new SlashCommandRegistry();
    let calls = 0;
    r.register({
      name: 'exit',
      aliases: ['q', 'quit'],
      description: 'exit',
      async run() {
        calls++;
      },
    });
    await r.dispatch('/exit', {} as Context);
    await r.dispatch('/q', {} as Context);
    await r.dispatch('/quit', {} as Context);
    expect(calls).toBe(3);
  });

  it('an external plugin reusing a builtin name is namespaced, not rejected', async () => {
    const r = new SlashCommandRegistry();
    let builtinRan = false;
    let pluginRan = false;
    r.register({
      name: 'x',
      description: '',
      async run() {
        builtinRan = true;
      },
    });
    // External plugin (no official flag) registering the same bare name does
    // NOT throw — it is isolated under its namespace and cannot shadow `/x`.
    expect(() =>
      r.register(
        {
          name: 'x',
          description: '',
          async run() {
            pluginRan = true;
          },
        },
        'plugin',
      ),
    ).not.toThrow();
    // Bare `/x` still routes to the builtin.
    await r.dispatch('/x', {} as Context);
    expect(builtinRan).toBe(true);
    expect(pluginRan).toBe(false);
    // The plugin's copy is only reachable namespaced.
    await r.dispatch('/plugin:x', {} as Context);
    expect(pluginRan).toBe(true);
  });

  it('an official plugin overrides a builtin by bare name (last write wins)', async () => {
    const r = new SlashCommandRegistry();
    let which = '';
    r.register({
      name: 'commit',
      description: '',
      async run() {
        which = 'builtin';
      },
    });
    r.register(
      {
        name: 'commit',
        description: '',
        async run() {
          which = 'official';
        },
      },
      'wstack-git',
      { official: true },
    );
    await r.dispatch('/commit', {} as Context);
    expect(which).toBe('official');
    // Still reachable under its namespace too.
    await r.dispatch('/wstack-git:commit', {} as Context);
    expect(which).toBe('official');
  });

  it('a builtin does not clobber a bare name already claimed by an official plugin', async () => {
    const r = new SlashCommandRegistry();
    let which = '';
    // Official plugin registers first...
    r.register(
      {
        name: 'sync',
        description: '',
        async run() {
          which = 'official';
        },
      },
      'wstack-sync',
      { official: true },
    );
    // ...then a builtin with the same name loads — the plugin's override holds.
    r.register({
      name: 'sync',
      description: '',
      async run() {
        which = 'builtin';
      },
    });
    await r.dispatch('/sync', {} as Context);
    expect(which).toBe('official');
  });

  it('plugin commands get namespaced names', async () => {
    const r = new SlashCommandRegistry();
    let ran = false;
    r.register(
      {
        name: 'cmd',
        aliases: ['c'],
        description: 'plugin cmd',
        async run() {
          ran = true;
        },
      },
      'my-plugin',
    );
    // Registered as `my-plugin:cmd`
    expect(r.get('my-plugin:cmd')?.name).toBe('cmd');
    // Direct lookup
    expect(r.ownerOf('my-plugin:cmd')).toBe('my-plugin');
    // Alias registered as `my-plugin:c`
    expect(r.get('my-plugin:c')?.name).toBe('cmd');
    // /my-plugin:cmd args
    await r.dispatch('/my-plugin:cmd', {} as Context);
    expect(ran).toBe(true);
  });

  it('builtin commands do not get prefix', () => {
    const r = new SlashCommandRegistry();
    r.register({ name: 'status', description: 'status', async run() {} });
    expect(r.get('status')?.name).toBe('status');
    expect(r.get('core:status')).toBeUndefined();
  });

  it('dispatches builtin name with colon in it', async () => {
    const r = new SlashCommandRegistry();
    r.register({ name: 'git:status', description: 'git status', async run() {} }, 'core');
    // A builtin called "git:status" — parsed as builtin (owner=core)
    await r.dispatch('/git:status', {} as Context);
    expect(r.ownerOf('git:status')).toBe('core');
  });

  it('same plugin can re-register its own commands', async () => {
    const r = new SlashCommandRegistry();
    r.register({ name: 'deploy', description: 'deploy', async run() {} }, 'k8s');
    // No throw
    r.register({ name: 'deploy', description: 'deploy v2', async run() {} }, 'k8s');
    expect(r.get('k8s:deploy')?.description).toBe('deploy v2');
  });

  it('listWithOwner includes fullName', async () => {
    const r = new SlashCommandRegistry();
    r.register({ name: 'status', description: 's', async run() {} });
    r.register({ name: 'log', description: 'l', async run() {} }, 'cloud');
    const entries = r.listWithOwner();
    expect(entries.find((e) => e.owner === 'core')?.fullName).toBe('status');
    expect(entries.find((e) => e.owner === 'cloud')?.fullName).toBe('cloud:log');
  });

  // ─── Additional coverage tests ─────────────────────────────────────

  it('unregister returns false for unknown name', () => {
    const r = new SlashCommandRegistry();
    expect(r.unregister('nope')).toBe(false);
  });

  it('unregister removes command and its aliases', () => {
    const r = new SlashCommandRegistry();
    r.register({ name: 'cmd', aliases: ['c', 'close'], description: '', async run() {} }, 'plug');
    expect(r.get('plug:cmd')).toBeDefined();
    expect(r.get('plug:c')).toBeDefined();
    expect(r.get('plug:close')).toBeDefined();

    const removed = r.unregister('plug:cmd');

    expect(removed).toBe(true);
    expect(r.get('plug:cmd')).toBeUndefined();
    expect(r.get('plug:c')).toBeUndefined();
    expect(r.get('plug:close')).toBeUndefined();
  });

  it('unregister removes builtin without alias', () => {
    const r = new SlashCommandRegistry();
    r.register({ name: 'bye', description: '', async run() {} });
    expect(r.unregister('bye')).toBe(true);
    expect(r.get('bye')).toBeUndefined();
  });

  it('registerAll bulk-registers commands', () => {
    const r = new SlashCommandRegistry();
    r.registerAll([
      { name: 'a', description: '', async run() {} },
      { name: 'b', description: '', async run() {} },
    ]);
    expect(r.get('a')).toBeDefined();
    expect(r.get('b')).toBeDefined();
  });

  it('list returns unique commands (deduped by aliases)', () => {
    const r = new SlashCommandRegistry();
    r.register({ name: 'cmd', aliases: ['c'], description: '', async run() {} }, 'plug');
    r.register({ name: 'status', description: '', async run() {} });
    const all = r.list();
    expect(all.map((c) => c.name)).toEqual(['cmd', 'status']);
  });

  it('list returns empty when no commands registered', () => {
    const r = new SlashCommandRegistry();
    expect(r.list()).toEqual([]);
  });

  it('dispatch returns null for empty slash', async () => {
    const r = new SlashCommandRegistry();
    // "/" — line.slice(1) gives empty string; trimmed="" has no space/colons
    // name will be "" and no entry found, returns unknown message
    const res = await r.dispatch('/', {} as Context);
    expect(res?.message).toMatch(/Unknown/);
  });

  it('dispatch passes config to run and returns its result', async () => {
    const r = new SlashCommandRegistry();
    r.register({
      name: 'check',
      description: '',
      async run(args, _ctx) {
        return { exit: true, message: `args="${args}"` };
      },
    });
    const res = await r.dispatch('/check foo', {} as Context);
    expect(res).toEqual({ exit: true, message: 'args="foo"' });
  });

  it('dispatch returns empty object when run returns undefined', async () => {
    const r = new SlashCommandRegistry();
    r.register({ name: 'silent', description: '', async run() {} });
    const res = await r.dispatch('/silent', {} as Context);
    expect(res).toEqual({});
  });

  it('dispatch parses /owner:cmd args with space', async () => {
    const r = new SlashCommandRegistry();
    let receivedArgs = '';
    r.register(
      {
        name: 'deploy',
        description: '',
        async run(args) {
          receivedArgs = args;
        },
      },
      'k8s',
    );
    await r.dispatch('/k8s:deploy staging --replicas=3', {} as Context);
    expect(receivedArgs).toBe('staging --replicas=3');
  });

  it('dispatch falls back to builtin when plugin prefix does not match any owner', async () => {
    const r = new SlashCommandRegistry();
    let ran = false;
    // Register a builtin called "other:cmd"
    r.register(
      {
        name: 'other:cmd',
        description: '',
        async run() {
          ran = true;
        },
      },
      'core',
    );
    // Now dispatch /other:cmd — since 'other' owner exists and name matches,
    // it should work
    await r.dispatch('/other:cmd', {} as Context);
    expect(ran).toBe(true);
    expect(r.ownerOf('other:cmd')).toBe('core');
  });

  it('an official plugin command is invocable by bare name and namespaced', async () => {
    const r = new SlashCommandRegistry();
    let received = '';
    // Mirrors how built-in plugins (wstack-prompts, wstack-sync) register:
    // official => bare name claimed, plus the namespaced alias.
    r.register(
      {
        name: 'prompts',
        description: '',
        async run(args) {
          received = args;
        },
      },
      'wstack-prompts',
      { official: true },
    );
    // Reachable bare...
    expect(r.get('prompts')?.name).toBe('prompts');
    const res = await r.dispatch('/prompts list', {} as Context);
    expect(res).toEqual({});
    expect(received).toBe('list');
    // ...and namespaced.
    await r.dispatch('/wstack-prompts:prompts view', {} as Context);
    expect(received).toBe('view');
  });

  it('an external plugin command is NOT invocable by bare name', async () => {
    const r = new SlashCommandRegistry();
    let ran = false;
    r.register(
      {
        name: 'deploy',
        description: '',
        async run() {
          ran = true;
        },
      },
      'acme',
    );
    // Bare `/deploy` is unknown — external plugins are namespaced only.
    const res = await r.dispatch('/deploy', {} as Context);
    expect(res?.message).toMatch(/Unknown/);
    expect(ran).toBe(false);
    // Only the namespaced form works.
    await r.dispatch('/acme:deploy', {} as Context);
    expect(ran).toBe(true);
  });

  it('dispatch parses /owner:cmd without args', async () => {
    const r = new SlashCommandRegistry();
    let ran = false;
    r.register(
      {
        name: 'test',
        description: '',
        async run() {
          ran = true;
        },
      },
      'myplug',
    );
    await r.dispatch('/myplug:test', {} as Context);
    expect(ran).toBe(true);
  });

  it('dispatch over plugin with args and colon in command name that matches owner case', async () => {
    const r = new SlashCommandRegistry();
    let ran = false;
    r.register(
      {
        name: 'start',
        description: '',
        async run() {
          ran = true;
        },
      },
      'svc',
    );
    await r.dispatch('/svc:start', {} as Context);
    expect(ran).toBe(true);
  });

  it('builtin re-registration is a silent no-op', () => {
    const r = new SlashCommandRegistry();
    r.register({ name: 'help', description: '', async run() {} }, 'core');
    // Same owner re-registering is intentionally a no-op (supports React
    // Strict Mode double-mount and plugin hot-reload in dev). The second
    // call does not throw and does not replace the original command.
    expect(() =>
      r.register({ name: 'help', description: '', async run() {} }, 'core'),
    ).not.toThrow();
    // Original registration is still there
    expect(r.get('help')).toBeDefined();
  });

  it('an external plugin cannot shadow a builtin bare name', async () => {
    const r = new SlashCommandRegistry();
    let builtinRan = false;
    r.register(
      {
        name: 'help',
        description: '',
        async run() {
          builtinRan = true;
        },
      },
      'core',
    );
    // An external plugin with the same name is namespaced, not rejected, and
    // cannot take over the bare `/help`.
    expect(() =>
      r.register({ name: 'help', description: '', async run() {} }, 'some-plugin'),
    ).not.toThrow();
    await r.dispatch('/help', {} as Context);
    expect(builtinRan).toBe(true);
    expect(r.ownerOf('help')).toBe('core');
    // The plugin's variant lives only under its namespace.
    expect(r.ownerOf('some-plugin:help')).toBe('some-plugin');
  });

  it('an official plugin bare name does not clobber a builtin alias', async () => {
    const r = new SlashCommandRegistry();
    let builtinRan = false;
    // Built-in `/interrupt`, reachable as `/stop` through its alias.
    r.register({
      name: 'interrupt',
      aliases: ['stop', 'int'],
      description: '',
      async run() {
        builtinRan = true;
      },
    });
    // plug-lsp is an official first-party plugin that registers a BARE command
    // literally named `stop`, so the two collide on the `stop` key. The
    // built-in alias must survive the plugin's registration.
    r.register({ name: 'stop', description: '', async run() {} }, '@wrongstack/plug-lsp', {
      official: true,
    });
    await r.dispatch('/stop', {} as Context);
    expect(builtinRan).toBe(true);
    // The built-in is still what `/stop` resolves to...
    expect(r.ownerOf('stop')).toBe('core');
    // ...and the plugin stays reachable under its own namespace.
    expect(r.ownerOf('@wrongstack/plug-lsp:stop')).toBe('@wrongstack/plug-lsp');
  });

  it('a refused plugin teardown does not remove the builtin whose alias it collided with', async () => {
    const r = new SlashCommandRegistry();
    let builtinRan = false;
    r.register({
      name: 'interrupt',
      aliases: ['stop', 'int'],
      description: '',
      async run() {
        builtinRan = true;
      },
    });
    r.register({ name: 'stop', description: '', async run() {} }, '@wrongstack/plug-lsp', {
      official: true,
    });
    // This is what plug-lsp's teardown actually calls
    // (`plug-lsp/src/index.ts:148`): the namespaced key DOES exist — register
    // refuses the plugin only the colliding bare name — so the removal is
    // allowed. What it must not do is take the built-in's keys with it.
    expect(r.unregister('@wrongstack/plug-lsp:stop', '@wrongstack/plug-lsp')).toBe(true);
    await r.dispatch('/stop', {} as Context);
    await r.dispatch('/interrupt', {} as Context);
    await r.dispatch('/int', {} as Context);
    expect(builtinRan).toBe(true);
    expect(r.ownerOf('stop')).toBe('core');
    expect(r.get('@wrongstack/plug-lsp:stop')).toBeUndefined();
    // A built-in unregistering its own command still removes its aliases.
    expect(r.unregister('interrupt')).toBe(true);
    expect(r.get('stop')).toBeUndefined();
  });

  it('a plugin cannot remove a core-owned alias by handing over the bare name', () => {
    const r = new SlashCommandRegistry();
    r.register({
      name: 'interrupt',
      aliases: ['stop', 'int'],
      description: '',
      async run() {},
    });
    r.register({ name: 'stop', description: '', async run() {} }, '@wrongstack/plug-lsp', {
      official: true,
    });
    // The bare `stop` resolves to the *built-in's* entry. Key spelling cannot
    // tell the two callers apart, so the tier does: the built-in's keys stay,
    // and the call only clears the plugin's own namespaced key (otherwise it
    // would keep dispatching to an unloaded plugin).
    expect(r.unregister('stop', '@wrongstack/plug-lsp')).toBe(true);
    expect(r.get('stop')).toBeDefined();
    expect(r.ownerOf('stop')).toBe('core');
    expect(r.ownerOf('int')).toBe('core');
    expect(r.get('@wrongstack/plug-lsp:stop')).toBeUndefined();
    // A second call has nothing left of its own to remove.
    expect(r.unregister('stop', '@wrongstack/plug-lsp')).toBe(false);
    // An owner-less call is the core/host path. Taking the `stop` key back is
    // a removal of the whole `/interrupt` command, not just the alias: the
    // identity sweep clears `stop`, `int` and `interrupt` together.
    expect(r.unregister('stop')).toBe(true);
    expect(r.get('stop')).toBeUndefined();
    expect(r.get('int')).toBeUndefined();
    expect(r.get('interrupt')).toBeUndefined();
  });

  it('a plugin whose ALIAS collides with a core-owned alias cannot take it', async () => {
    const r = new SlashCommandRegistry();
    let builtinRan = false;
    let attackerRan = false;
    r.register({
      name: 'interrupt',
      aliases: ['stop', 'int'],
      description: '',
      async run() {
        builtinRan = true;
      },
    });
    // Its bare name is unique, so only the alias loop can reach the `stop` key.
    r.register(
      {
        name: 'evil',
        aliases: ['stop'],
        description: '',
        async run() {
          attackerRan = true;
        },
      },
      'evil-plugin',
      { official: true },
    );
    await r.dispatch('/stop', {} as Context);
    expect(builtinRan).toBe(true);
    expect(attackerRan).toBe(false);
    expect(r.ownerOf('stop')).toBe('core');
    // The attacker's own two spellings still work.
    await r.dispatch('/evil', {} as Context);
    expect(attackerRan).toBe(true);
    expect(r.ownerOf('evil-plugin:stop')).toBe('evil-plugin');
  });

  it('a built-in alias cannot clobber an official plugin bare-name key', async () => {
    const r = new SlashCommandRegistry();
    let pluginRan = false;
    let builtinRan = false;
    // The plugin legitimately owns the bare `/stop` — no built-in alias is in
    // the way yet, so this is not the plug-lsp case.
    r.register(
      {
        name: 'stop',
        description: '',
        async run() {
          pluginRan = true;
        },
      },
      'first-party',
      { official: true },
    );
    // A built-in added later must not steal it through its alias loop. Before
    // this guard the alias write was unconditional for core, so `/stop` flipped
    // to the built-in with no diagnostic.
    r.register({
      name: 'interrupt',
      aliases: ['stop', 'int'],
      description: '',
      async run() {
        builtinRan = true;
      },
    });
    await r.dispatch('/stop', {} as Context);
    expect(pluginRan).toBe(true);
    expect(builtinRan).toBe(false);
    expect(r.ownerOf('stop')).toBe('first-party');
    // The built-in keeps its own name and its uncontested alias.
    await r.dispatch('/interrupt', {} as Context);
    await r.dispatch('/int', {} as Context);
    expect(builtinRan).toBe(true);
  });

  it('an official override rebinds the built-in aliases of the command it replaces', async () => {
    const r = new SlashCommandRegistry();
    let coreRan = false;
    let overrideRan = false;
    r.register({
      name: 'exit',
      aliases: ['quit', 'q'],
      description: '',
      async run() {
        coreRan = true;
      },
    });
    // The TUI registers `exit` (aliases `quit`, `q`) with owner `tui` and
    // `official: true`. Claiming the bare name must not stop at half an
    // override: if the aliases kept pointing at the core command, `/q` would
    // run the superseded implementation.
    r.register(
      {
        name: 'exit',
        aliases: ['quit', 'q'],
        description: '',
        async run() {
          overrideRan = true;
        },
      },
      'tui',
      { official: true },
    );
    await r.dispatch('/exit', {} as Context);
    await r.dispatch('/quit', {} as Context);
    await r.dispatch('/q', {} as Context);
    expect(overrideRan).toBe(true);
    expect(coreRan).toBe(false);
    expect(r.ownerOf('q')).toBe('tui');
    expect(r.ownerOf('quit')).toBe('tui');
    // Re-registering the same built-in stays a silent no-op (the pre-existing
    // strict-mode guard bails before any write), so neither the name nor the
    // alias is rebound — that path is unchanged by the alias guard.
    const r2 = new SlashCommandRegistry();
    let first = false;
    r2.register({
      name: 'exit',
      aliases: ['q'],
      description: '',
      async run() {
        first = true;
      },
    });
    r2.register({ name: 'exit', aliases: ['q'], description: '', async run() {} });
    await r2.dispatch('/q', {} as Context);
    expect(first).toBe(true);
  });

  it("an attributed caller cannot remove another owner's bare command", async () => {
    const r = new SlashCommandRegistry();
    let kept = false;
    r.register(
      {
        name: 'alpha',
        description: '',
        async run() {
          kept = true;
        },
      },
      'plug-a',
      { official: true },
    );
    // `callerOwner` exists so an attributed teardown can only ever reach its
    // own entries. Guarding solely `entry.owner === 'core'` would let plugin B
    // unregister plugin A's command through the same bare key.
    expect(r.unregister('alpha', 'plug-b')).toBe(false);
    await r.dispatch('/alpha', {} as Context);
    expect(kept).toBe(true);
    // The owner may still tear itself down.
    expect(r.unregister('alpha', 'plug-a')).toBe(true);
    expect(r.get('alpha')).toBeUndefined();
  });

  it('a refused collision emits a one-time, truthful diagnostic', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      // A collision unique to this test: notices are deduped per process and
      // the functional tests above already spend `/stop` vs `/interrupt`.
      const r = new SlashCommandRegistry();
      r.register({
        name: 'savepoint',
        aliases: ['snapshot'],
        description: '',
        async run() {},
      });
      r.register({ name: 'snapshot', description: '', async run() {} }, 'diag-plugin', {
        official: true,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const [text, opts] = warn.mock.calls[0] as unknown as [string, { code?: string }];
      expect(opts.code).toBe('WRONGSTACK_SLASH_COMMAND_REFUSED_WRITE');
      expect(text).toContain('/diag-plugin:snapshot');
      expect(text).toContain('/savepoint');
      expect(r.get('diag-plugin:snapshot')).toBeDefined();

      // Hot reload and React strict mode re-run `register`; the notice must not
      // become the stream of noise it exists to prevent.
      r.register({ name: 'snapshot', description: '', async run() {} }, 'diag-plugin', {
        official: true,
      });
      expect(warn).toHaveBeenCalledTimes(1);

      // The fallback form advertised must actually exist. Core has no
      // `core:name` key, and its own bare name was already written.
      const r2 = new SlashCommandRegistry();
      r2.register({ name: 'restore', description: '', async run() {} }, 'first-party', {
        official: true,
      });
      r2.register({ name: 'checkpoint', aliases: ['restore'], description: '', async run() {} });
      const coreText = (warn.mock.calls[1] as unknown as [string])[0];
      expect(coreText).toContain('/checkpoint');
      expect(coreText).not.toContain('/core:');
      expect(r2.get('checkpoint')).toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('a refused alias write emits the same diagnostic', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      // A DISTINCT collision: notices are deduped per process, so repeating the
      // /stop-vs-/interrupt pair used above would correctly emit nothing here.
      const r = new SlashCommandRegistry();
      r.register({ name: 'savepoint', aliases: ['backup'], description: '', async run() {} });
      // Its bare name is unique, so only the alias loop can be refused here.
      r.register(
        { name: 'undo-tool', aliases: ['backup'], description: '', async run() {} },
        'my-plugin',
        { official: true },
      );
      expect(warn).toHaveBeenCalledTimes(1);
      const text = (warn.mock.calls[0] as unknown as [string])[0];
      expect(text).toContain('an alias of "/savepoint"');
      expect(text).toContain('/my-plugin:undo-tool');
      // The losing command still answers under its namespace.
      expect(r.get('my-plugin:undo-tool')).toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('allowed rebinds and legitimate overrides stay quiet', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      // (a) an official override rebinding the aliases of the command it holds
      const r = new SlashCommandRegistry();
      r.register({ name: 'exit', aliases: ['quit', 'q'], description: '', async run() {} });
      r.register({ name: 'exit', aliases: ['quit', 'q'], description: '', async run() {} }, 'tui', {
        official: true,
      });
      expect(r.ownerOf('q')).toBe('tui');
      // (b) a built-in claiming a fresh name, (c) an official plugin overriding
      // that built-in's BARE name (legitimate last-write-wins), (d) an external
      // plugin, which is namespaced and can never collide bare.
      const r2 = new SlashCommandRegistry();
      r2.register({ name: 'commit', aliases: ['c'], description: '', async run() {} });
      r2.register({ name: 'commit', description: '', async run() {} }, 'wstack-git', {
        official: true,
      });
      r2.register({ name: 'solo', description: '', async run() {} }, 'third-party');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('an injected host sink receives the notice instead of stderr', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const notices: string[] = [];
    try {
      const r = new SlashCommandRegistry({ onNotice: (m) => notices.push(m) });
      r.register({ name: 'halt', aliases: ['stop'], description: '', async run() {} });
      r.register({ name: 'stop', description: '', async run() {} }, 'notice-plugin', {
        official: true,
      });
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('/notice-plugin:stop');
      expect(notices[0]).toContain('/halt');
      // The sink replaces stderr rather than duplicating the notice.
      expect(warn).not.toHaveBeenCalled();

      // Without a sink the same class of collision still reaches stderr: the
      // fallback is what keeps tests and minimal hosts unregressed.
      const r2 = new SlashCommandRegistry();
      r2.register({ name: 'shutdown', aliases: ['kill-now'], description: '', async run() {} });
      r2.register({ name: 'kill-now', description: '', async run() {} }, 'fallback-plugin', {
        official: true,
      });
      expect(notices).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      const [fallbackText, opts] = warn.mock.calls[0] as unknown as [string, { code?: string }];
      expect(opts.code).toBe('WRONGSTACK_SLASH_COMMAND_REFUSED_WRITE');
      expect(fallbackText).toContain('/fallback-plugin:kill-now');
    } finally {
      warn.mockRestore();
    }
  });

  it('listWithOwner returns empty when no commands', () => {
    const r = new SlashCommandRegistry();
    expect(r.listWithOwner()).toEqual([]);
  });

  it('ownerOf returns undefined for unknown', () => {
    const r = new SlashCommandRegistry();
    expect(r.ownerOf('nope')).toBeUndefined();
  });
});
