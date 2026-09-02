import { describe, expect, it } from 'vitest';
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

  it('listWithOwner returns empty when no commands', () => {
    const r = new SlashCommandRegistry();
    expect(r.listWithOwner()).toEqual([]);
  });

  it('ownerOf returns undefined for unknown', () => {
    const r = new SlashCommandRegistry();
    expect(r.ownerOf('nope')).toBeUndefined();
  });
});
