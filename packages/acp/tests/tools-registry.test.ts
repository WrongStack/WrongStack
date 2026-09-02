import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '@wrongstack/core/types';
import { ACPToolsRegistry } from '../src/agent/tools-registry.js';

/** Build a minimal Tool-like object; only the fields the registry reads matter. */
function mkTool(partial: Partial<Tool> & { name: string }): Tool {
  return {
    description: `desc-${partial.name}`,
    inputSchema: { type: 'object', properties: {} },
    permission: 'auto',
    execute: async () => 'ok',
    ...partial,
  } as never as Tool;
}

describe('ACPToolsRegistry', () => {
  describe('registration & lookup', () => {
    it('register adds tools and get/has/list reflect them', () => {
      const reg = new ACPToolsRegistry();
      const a = mkTool({ name: 'a' });
      const b = mkTool({ name: 'b' });
      reg.register([a, b]);

      expect(reg.has('a')).toBe(true);
      expect(reg.has('missing')).toBe(false);
      expect(reg.get('a')).toBe(a);
      expect(reg.get('missing')).toBeUndefined();
      expect(reg.list()).toEqual([a, b]);
    });

    it('register overwrites a duplicate name', () => {
      const reg = new ACPToolsRegistry();
      const first = mkTool({ name: 'dup', description: 'first' });
      const second = mkTool({ name: 'dup', description: 'second' });
      reg.register([first]);
      reg.register([second]);
      expect(reg.list()).toHaveLength(1);
      expect(reg.get('dup')).toBe(second);
    });

    it('setTools replaces the whole set', () => {
      const reg = new ACPToolsRegistry();
      reg.register([mkTool({ name: 'old' })]);
      reg.setTools([mkTool({ name: 'new1' }), mkTool({ name: 'new2' })]);
      expect(reg.has('old')).toBe(false);
      expect(reg.list().map((t) => t.name)).toEqual(['new1', 'new2']);
    });
  });

  describe('buildToolList', () => {
    it('maps tools to ACP definitions with annotations and converted schema', () => {
      const reg = new ACPToolsRegistry('my-owner');
      reg.register([
        mkTool({
          name: 'read',
          description: 'Read a file',
          usageHint: 'use to read',
          permission: 'auto',
          inputSchema: {
            type: 'object',
            description: 'read input',
            properties: {
              path: { type: 'string', description: 'the path', default: '.' },
              lines: { type: 'number', minimum: 1, maximum: 100 },
              tags: { type: 'array', items: { type: 'string' } },
              mode: { type: 'string', enum: ['r', 'w'] },
            },
            required: ['path'],
          },
        } as Partial<Tool> & { name: string }),
      ]);

      const list = reg.buildToolList();
      expect(list.tools).toHaveLength(1);
      const def = list.tools[0]!;
      expect(def.name).toBe('read');
      expect(def.description).toBe('Read a file');
      expect(def.annotations?.title).toBe('read');
      expect(def.annotations?.description).toBe('use to read');
      expect(def.annotations?.alwaysAccept).toBe(true);
      expect(def.annotations?.priority).toBe('low');

      // Schema conversion: nested properties, items, enum, min/max, default, required.
      expect(def.inputSchema.type).toBe('object');
      expect(def.inputSchema.description).toBe('read input');
      expect(def.inputSchema.required).toEqual(['path']);
      const props = def.inputSchema.properties!;
      expect(props.path).toMatchObject({ type: 'string', description: 'the path', default: '.' });
      expect(props.lines).toMatchObject({ type: 'number', minimum: 1, maximum: 100 });
      expect(props.tags?.items).toMatchObject({ type: 'string' });
      expect(props.mode?.enum).toEqual(['r', 'w']);
    });

    it('falls back to tool.description when usageHint is absent', () => {
      const reg = new ACPToolsRegistry();
      reg.register([mkTool({ name: 'x', description: 'the desc' })]);
      const def = reg.buildToolList().tools[0]!;
      expect(def.annotations?.description).toBe('the desc');
    });

    it('priority: destructive→high, standard→medium, confirm→medium, else→low', () => {
      const reg = new ACPToolsRegistry();
      reg.register([
        mkTool({ name: 'destroy', riskTier: 'destructive' } as Partial<Tool> & { name: string }),
        mkTool({ name: 'std', riskTier: 'standard' } as Partial<Tool> & { name: string }),
        mkTool({ name: 'conf', permission: 'confirm' } as Partial<Tool> & { name: string }),
        mkTool({ name: 'safe', permission: 'auto' }),
      ]);
      const byName = Object.fromEntries(
        reg.buildToolList().tools.map((t) => [t.name, t.annotations?.priority]),
      );
      expect(byName).toEqual({ destroy: 'high', std: 'medium', conf: 'medium', safe: 'low' });
      // confirm tool is not auto → alwaysAccept false
      const conf = reg.buildToolList().tools.find((t) => t.name === 'conf')!;
      expect(conf.annotations?.alwaysAccept).toBe(false);
    });

    it('converts properties that omit a type and skips required when absent', () => {
      const reg = new ACPToolsRegistry();
      reg.register([
        mkTool({
          name: 'loose',
          inputSchema: {
            // object schema with no top-level `type` and a typeless property,
            // and no `required` array.
            properties: {
              note: { description: 'free text', enum: ['x', 'y'] },
            },
          },
        } as Partial<Tool> & { name: string }),
      ]);
      const schema = reg.buildToolList().tools[0]!.inputSchema;
      expect(schema.type).toBeUndefined();
      expect(schema.required).toBeUndefined();
      expect(schema.properties!.note).toEqual({ description: 'free text', enum: ['x', 'y'] });
    });

    it('non-object inputSchema converts to an empty schema', () => {
      const reg = new ACPToolsRegistry();
      reg.register([
        mkTool({ name: 'weird', inputSchema: 'not-an-object' as never as Tool['inputSchema'] }),
      ]);
      expect(reg.buildToolList().tools[0]!.inputSchema).toEqual({});
    });
  });

  describe('execute', () => {
    const ABORT = new AbortController().signal;

    it('returns null for an unknown tool', async () => {
      const reg = new ACPToolsRegistry();
      expect(await reg.execute('nope', {}, {}, ABORT)).toBeNull();
    });

    it('wraps a string result as a text block', async () => {
      const reg = new ACPToolsRegistry();
      reg.register([mkTool({ name: 't', execute: async () => 'hello' })]);
      const res = await reg.execute('t', {}, {}, ABORT);
      expect(res).toEqual({ content: [{ type: 'text', text: 'hello' }] });
    });

    it('serialises an object result as pretty JSON', async () => {
      const reg = new ACPToolsRegistry();
      reg.register([mkTool({ name: 't', execute: async () => ({ a: 1 }) })]);
      const res = await reg.execute('t', {}, {}, ABORT);
      expect(res?.content[0]).toEqual({ type: 'text', text: JSON.stringify({ a: 1 }, null, 2) });
    });

    it('renders null/undefined result as "ok"', async () => {
      const reg = new ACPToolsRegistry();
      reg.register([mkTool({ name: 'n', execute: async () => null })]);
      reg.register([mkTool({ name: 'u', execute: async () => undefined })]);
      expect((await reg.execute('n', {}, {}, ABORT))?.content[0]).toEqual({
        type: 'text',
        text: 'ok',
      });
      expect((await reg.execute('u', {}, {}, ABORT))?.content[0]).toEqual({
        type: 'text',
        text: 'ok',
      });
    });

    it('stringifies a primitive (number) result', async () => {
      const reg = new ACPToolsRegistry();
      reg.register([mkTool({ name: 'num', execute: async () => 42 as never as string })]);
      expect((await reg.execute('num', {}, {}, ABORT))?.content[0]).toEqual({
        type: 'text',
        text: '42',
      });
    });

    it('captures a thrown Error as an isError result', async () => {
      const reg = new ACPToolsRegistry();
      reg.register([
        mkTool({
          name: 'boom',
          execute: async () => {
            throw new Error('kaboom');
          },
        }),
      ]);
      const res = await reg.execute('boom', {}, {}, ABORT);
      expect(res).toEqual({ content: [{ type: 'text', text: 'kaboom' }], isError: true });
    });

    it('captures a thrown non-Error as an isError result', async () => {
      const reg = new ACPToolsRegistry();
      reg.register([
        mkTool({
          name: 'boom',
          execute: async () => {
            throw 'plain string';
          },
        }),
      ]);
      const res = await reg.execute('boom', {}, {}, ABORT);
      expect(res?.isError).toBe(true);
      expect(res?.content[0]).toEqual({ type: 'text', text: 'plain string' });
    });

    it('passes args, context and signal through to the tool', async () => {
      const reg = new ACPToolsRegistry();
      const execute = vi.fn(async () => 'done');
      reg.register([mkTool({ name: 't', execute })]);
      const ctx = { cwd: '/x' };
      await reg.execute('t', { k: 'v' }, ctx, ABORT);
      expect(execute).toHaveBeenCalledWith({ k: 'v' }, ctx, { signal: ABORT });
    });
  });
});
