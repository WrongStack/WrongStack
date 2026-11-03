import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolRegistry } from '@wrongstack/core/registry';
import { builtinToolsPack } from '@wrongstack/tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/arg-parser.js';
import { runToolsCli, type ToolsCliIo } from '../src/subcommands/handlers/tools-cli.js';
import { createToolGateway } from '../src/tool-gateway.js';

/** The exit codes are the machine contract — pinned as literals, not imported. */
const TOOLS_CLI_EXIT = { ok: 0, toolFailed: 1, usage: 2, notExposed: 3, confirmRequired: 4 };

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  r.registerAllOrThrow([...(builtinToolsPack.tools ?? [])], builtinToolsPack.name);
  return r;
}

let root: string;
let outside: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tools-cli-root-')));
  outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tools-cli-outside-')));
  await fs.writeFile(path.join(root, 'hello.txt'), 'hello from the project\n');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside the project\n');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

function capture(stdin = ''): ToolsCliIo & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    stdout: (t: string) => {
      io.out += t;
    },
    stderr: (t: string) => {
      io.err += t;
    },
    readStdin: async () => stdin,
  };
  return io;
}

function deps(flags: Record<string, string | boolean> = {}) {
  return {
    config: { tools: {}, features: {} },
    toolRegistry: registry(),
    cwd: root,
    projectRoot: root,
    flags,
    renderer: {},
  } as never;
}

/** Run `wstack tools <argv…>` through the real top-level parser, as the dispatcher does. */
async function wstackTools(argv: string[], io: ToolsCliIo): Promise<number> {
  const parsed = parseArgs(['tools', ...argv]);
  const [verb = '', ...rest] = parsed.positional.slice(1);
  return runToolsCli(verb, rest, deps(parsed.flags), io);
}

describe('tool gateway', () => {
  it('exports the registered catalog without granting execution or leaking functions', async () => {
    const io = capture();
    expect(await wstackTools(['catalog', '--json', '--check'], io)).toBe(0);
    const catalog = JSON.parse(io.out);
    expect(catalog).toMatchObject({ schemaVersion: 1, scope: 'registered' });
    expect(catalog.tools.find((tool: { name: string }) => tool.name === 'clarify')).toBeDefined();
    expect(catalog.tools.find((tool: { name: string }) => tool.name === 'write')).toMatchObject({
      permission: 'confirm',
      mutating: true,
    });
    expect(catalog.tools.every((tool: Record<string, unknown>) => !('execute' in tool))).toBe(true);
  });
  it('withholds exactly these session-bound built-ins (a rename must not re-expose one)', async () => {
    const reg = registry();
    const gateway = await createToolGateway({
      registry: reg,
      config: { tools: {} },
      cwd: root,
      projectRoot: root,
      yolo: true,
      whitelist: null,
      oneShot: true,
    });
    const sessionBound = reg
      .list()
      .map((t) => t.name)
      .filter((name) => gateway.withheldBy(name) === 'session')
      .sort();
    await gateway.close();
    expect(sessionBound).toEqual(
      [
        'clarify',
        'plan',
        'present_artifact',
        'todo',
        'tool_script',
        'tool_search',
        'tool_use',
      ].sort(),
    );
  });

  it('withholds session- and process-bound tools only for one-shot calls (mcp serve keeps its set)', async () => {
    const base = {
      registry: registry(),
      config: { tools: {} },
      cwd: root,
      projectRoot: root,
      yolo: false,
      whitelist: null,
    };
    const mcp = await createToolGateway(base);
    const cli = await createToolGateway({ ...base, oneShot: true });
    for (const name of ['present_artifact', 'browser_open']) {
      expect(mcp.get(name), name).toBeDefined();
      expect(cli.get(name), name).toBeUndefined();
    }
    expect(cli.get('read')).toBeDefined();
    expect(await cli.call('browser_open', {})).toEqual({ kind: 'not_exposed' });
    // The MCP path shares the Context: `read` used to die on the id-less stub
    // session ("Session id is required for agent event emission").
    expect(await mcp.call('read', { path: 'hello.txt' })).toMatchObject({
      kind: 'result',
      settlement: 'completed',
    });
    await mcp.close();
    await cli.close();
  });
});

describe('wstack tools agent-guide', () => {
  it('prints a short guide naming discovery, calls, the grant and the exposed tools', async () => {
    const io = capture();
    expect(await wstackTools(['agent-guide'], io)).toBe(TOOLS_CLI_EXIT.ok);
    expect(io.out).toContain('## WrongStack tools');
    expect(io.out).toContain('wstack tools describe <tool>');
    expect(io.out).toContain('`wstack tools run codebase-search -- --query <name>`');
    expect(io.out).toContain('--allow fs.write');
    expect(io.out).toMatch(/Tools exposed here \(\d+\): .*\bread\b/);
    expect(io.out).not.toMatch(/Tools exposed here.*\bwrite\b/);
    // Discovery stays on demand: no schema is embedded.
    expect(io.out).not.toContain('"properties"');
  });

  it('reflects a grant in the guide and in the exposed list', async () => {
    const io = capture();
    expect(await wstackTools(['agent-guide', '--allow', 'fs.write'], io)).toBe(TOOLS_CLI_EXIT.ok);
    expect(io.out).toContain('--allow fs.read,net.outbound,fs.write');
    expect(io.out).toMatch(/Tools exposed here.*\bwrite\b/);
  });
});

describe('wstack tools list / describe', () => {
  it('list --json exposes read-only tools and withholds write, bash and session-bound ones', async () => {
    const io = capture();
    expect(await wstackTools(['list', '--json'], io)).toBe(TOOLS_CLI_EXIT.ok);
    const listed = JSON.parse(io.out) as { mode: string; tools: { name: string }[] };
    const names = new Set(listed.tools.map((t) => t.name));
    expect(listed.mode).toBe('safe');
    expect(names.has('read')).toBe(true);
    expect(names.has('grep')).toBe(true);
    expect(names.has('write')).toBe(false);
    expect(names.has('bash')).toBe(false);
    expect(names.has('clarify')).toBe(false);
  });

  it('describe --json returns the input schema', async () => {
    const io = capture();
    expect(await wstackTools(['describe', 'read', '--json'], io)).toBe(TOOLS_CLI_EXIT.ok);
    const described = JSON.parse(io.out) as { name: string; inputSchema: { properties: object } };
    expect(described.name).toBe('read');
    expect(described.inputSchema.properties).toHaveProperty('path');
  });

  it('describe explains why a tool is not exposed', async () => {
    const write = capture();
    expect(await wstackTools(['describe', 'write'], write)).toBe(TOOLS_CLI_EXIT.notExposed);
    expect(write.err).toContain('--yolo');
    const clarify = capture();
    expect(await wstackTools(['describe', 'clarify'], clarify)).toBe(TOOLS_CLI_EXIT.notExposed);
    expect(clarify.err).toContain('agent session');
    const browser = capture();
    expect(await wstackTools(['describe', 'browser_open'], browser)).toBe(
      TOOLS_CLI_EXIT.notExposed,
    );
    expect(browser.err).toContain('mcp serve');
    const unknown = capture();
    expect(await wstackTools(['describe', 'no-such-tool'], unknown)).toBe(
      TOOLS_CLI_EXIT.notExposed,
    );
    expect(unknown.err).toContain('Unknown tool');
  });
});

describe('wstack tools run', () => {
  it('resolves aliases through the exposed set and keeps disabled or withheld targets inaccessible', async () => {
    const reg = registry();
    reg.wrap('read', (tool) => ({ ...tool, aliases: ['old_read'] }));
    reg.wrap('write', (tool) => ({ ...tool, aliases: ['old_write'] }));
    async function invoke(name: string, input: Record<string, unknown>) {
      const options = deps({ json: true, input: JSON.stringify(input) });
      (options as unknown as { toolRegistry: ToolRegistry }).toolRegistry = reg;
      const io = capture();
      return { code: await runToolsCli('run', [name], options, io), io };
    }
    expect((await invoke('read', { path: 'hello.txt' })).code).toBe(0);
    expect((await invoke('old_read', { path: 'hello.txt' })).code).toBe(0);
    expect((await invoke('old_write', { path: 'hello.txt', content: 'overwrite' })).code).toBe(3);
    expect(await fs.readFile(path.join(root, 'hello.txt'), 'utf8')).toBe(
      'hello from the project\n',
    );
    reg.disable('read');
    expect((await invoke('old_read', { path: 'hello.txt' })).code).toBe(3);
  });
  it('runs a tool from inline JSON and prints its result on stdout', async () => {
    const io = capture();
    const code = await wstackTools(['run', 'read', '--input', '{"path":"hello.txt"}'], io);
    expect(code).toBe(TOOLS_CLI_EXIT.ok);
    expect(io.out).toContain('hello from the project');
  });

  it('--json wraps the result in an envelope with the settlement', async () => {
    const io = capture();
    const code = await wstackTools(['run', 'read', '--input={"path":"hello.txt"}', '--json'], io);
    expect(code).toBe(TOOLS_CLI_EXIT.ok);
    const envelope = JSON.parse(io.out) as Record<string, unknown>;
    expect(envelope).toMatchObject({ ok: true, tool: 'read', settlement: 'completed' });
    expect(String(envelope['content'])).toContain('hello from the project');
  });

  it('reads input from stdin for a bare --input and for --input -', async () => {
    for (const argv of [
      ['run', 'read', '--input'],
      ['run', 'read', '--input', '-'],
    ]) {
      const io = capture('{"path":"hello.txt"}');
      expect(await wstackTools(argv, io)).toBe(TOOLS_CLI_EXIT.ok);
      expect(io.out).toContain('hello from the project');
    }
  });

  it('reads input from an @file relative to cwd, tolerating a BOM', async () => {
    await fs.writeFile(
      path.join(root, 'call.json'),
      `${String.fromCharCode(0xfeff)}{"path":"hello.txt"}`,
    );
    const io = capture();
    expect(await wstackTools(['run', 'read', '--input', '@call.json'], io)).toBe(TOOLS_CLI_EXIT.ok);
    expect(io.out).toContain('hello from the project');
  });

  it('rejects malformed or non-object input as a usage error without running the tool', async () => {
    for (const input of ['{not json', '[1,2]', '"text"', 'null']) {
      const io = capture();
      expect(await wstackTools(['run', 'read', `--input=${input}`], io), input).toBe(
        TOOLS_CLI_EXIT.usage,
      );
      expect(io.out).toBe('');
    }
  });

  it('keeps file tools inside the project root', async () => {
    const io = capture();
    const code = await wstackTools(
      ['run', 'read', `--input=${JSON.stringify({ path: path.join(outside, 'secret.txt') })}`],
      io,
    );
    expect(code).not.toBe(TOOLS_CLI_EXIT.ok);
    expect(io.out).not.toContain('outside the project');
    expect(io.err).not.toContain('outside the project');
  });

  it('refuses a withheld tool in safe mode with exit 3, never running it', async () => {
    const io = capture();
    const code = await wstackTools(
      ['run', 'write', '--input', '{"path":"new.txt","content":"x"}', '--json'],
      io,
    );
    expect(code).toBe(TOOLS_CLI_EXIT.notExposed);
    expect(JSON.parse(io.out)).toMatchObject({ ok: false, error: 'not_exposed' });
    await expect(fs.stat(path.join(root, 'new.txt'))).rejects.toThrow();
  });

  it('--yolo keeps the subagent locks: deleting outside the project is refused', async () => {
    // Same verdict as `mcp serve --yolo`: in-project exec is allowed, while
    // delete-outside / git-history / download-and-run are refused outright.
    const io = capture();
    const code = await wstackTools(
      ['run', 'bash', '--yolo', `--input=${JSON.stringify({ command: `rm -rf "${outside}"` })}`],
      io,
    );
    expect(code).toBe(TOOLS_CLI_EXIT.notExposed);
    await expect(fs.stat(path.join(outside, 'secret.txt'))).resolves.toBeDefined();
  });

  it('missing tool name is a usage error', async () => {
    const io = capture();
    expect(await wstackTools(['run'], io)).toBe(TOOLS_CLI_EXIT.usage);
  });

  it('treats an absent or blank input as an empty object', async () => {
    for (const argv of [
      ['run', 'tree'],
      ['run', 'tree', '--input'],
    ]) {
      const io = capture('   ');
      expect(await wstackTools(argv, io), argv.join(' ')).toBe(TOOLS_CLI_EXIT.ok);
      expect(io.out).toContain('hello.txt');
    }
  });
});
