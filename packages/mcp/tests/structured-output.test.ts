/**
 * Structured tool output (`outputSchema` / `structuredContent`, spec
 * 2025-06-18): kept from `tools/list`, read from every `tools/call` response,
 * shown to the model when the text blocks do not already carry it, and checked
 * against the tool's declared schema.
 */
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { ToolRegistry } from '@wrongstack/core/registry';
import { afterEach, describe, expect, it } from 'vitest';
import { MCPRegistry } from '../src/registry.js';
import { renderStructuredResult } from '../src/structured-result.js';
import { normalizeMCPTools, toToolCallResult } from '../src/tool-schema.js';

const WEATHER_SCHEMA = {
  type: 'object',
  properties: { city: { type: 'string' }, celsius: { type: 'number' } },
  required: ['city', 'celsius'],
};

describe('reading structured output off the wire', () => {
  it('keeps a declared outputSchema and ignores one that is not an object', () => {
    const [withSchema, withoutSchema] = normalizeMCPTools([
      { name: 'weather', inputSchema: { type: 'object' }, outputSchema: WEATHER_SCHEMA },
      { name: 'echo', inputSchema: { type: 'object' }, outputSchema: 'nope' },
    ]);
    expect(withSchema?.outputSchema).toEqual(WEATHER_SCHEMA);
    expect(withoutSchema && 'outputSchema' in withoutSchema).toBe(false);
  });

  it('reads structuredContent from a call result only when it is an object', () => {
    expect(
      toToolCallResult({
        result: { content: [], structuredContent: { city: 'Oslo', celsius: 3 } },
      }),
    ).toEqual({ content: [], isError: false, structuredContent: { city: 'Oslo', celsius: 3 } });
    expect(toToolCallResult({ result: { content: 'x', structuredContent: [1, 2] } })).toEqual({
      content: 'x',
      isError: false,
    });
    expect(toToolCallResult({ error: { message: 'boom' } })).toEqual({
      content: 'boom',
      isError: true,
    });
  });
});

describe('renderStructuredResult', () => {
  const data = { city: 'Oslo', celsius: 3 };

  it('adds the structured result when the text is only a summary', () => {
    const content = [{ type: 'text', text: 'Weather fetched.' }];
    expect(renderStructuredResult('Weather fetched.', content, data, WEATHER_SCHEMA)).toBe(
      `Weather fetched.\n\nStructured result:\n${JSON.stringify(data, null, 2)}`,
    );
  });

  it('does not repeat it when a text block already carries the same JSON', () => {
    const text = '{ "celsius": 3, "city": "Oslo" }';
    const content = [{ type: 'text', text }];
    expect(renderStructuredResult(text, content, data, WEATHER_SCHEMA)).toBe(text);
  });

  it('flags a result that breaks the declared schema', () => {
    const rendered = renderStructuredResult('ok', 'ok', { city: 'Oslo' }, WEATHER_SCHEMA);
    expect(rendered).toContain('Structured result:');
    expect(rendered).toMatch(/does not match the tool's declared output schema — .*celsius/);
  });

  it('leaves plain results untouched', () => {
    expect(renderStructuredResult('plain', 'plain', undefined, WEATHER_SCHEMA)).toBe('plain');
  });
});

// ── A real stdio server ────────────────────────────────────────────────────

const silentLog = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLog,
} as never as Logger;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function writeServer(): string {
  const script = `'use strict';
const rl = require('readline');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const SCHEMA = ${JSON.stringify(WEATHER_SCHEMA)};
rl.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'wx', version: '1' } } });
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [
      { name: 'weather', inputSchema: { type: 'object' }, outputSchema: SCHEMA },
      { name: 'broken', inputSchema: { type: 'object' }, outputSchema: SCHEMA },
    ] } });
  } else if (m.method === 'tools/call') {
    const good = m.params.name === 'weather';
    send({ jsonrpc: '2.0', id: m.id, result: {
      content: [{ type: 'text', text: good ? 'Fetched the weather for Oslo.' : 'Done.' }],
      structuredContent: good ? { city: 'Oslo', celsius: 3 } : { city: 42 },
    } });
  }
});
`;
  const path = join(
    tmpdir(),
    `structured-mcp-${process.pid}-${Math.random().toString(36).slice(2)}.cjs`,
  );
  writeFileSync(path, script, 'utf8');
  return path;
}

describe('structured output end to end over stdio', () => {
  it('gives the model the typed result and flags one that breaks its schema', {
    timeout: 30_000,
  }, async () => {
    const scriptPath = writeServer();
    cleanups.push(() => unlinkSync(scriptPath));
    const toolRegistry = new ToolRegistry();
    const registry = new MCPRegistry({ toolRegistry, events: new EventBus(), log: silentLog });
    cleanups.push(() => registry.stopAll());
    await registry.start({
      name: 'wx',
      transport: 'stdio',
      command: process.execPath,
      args: [scriptPath],
      startupTimeoutMs: 30_000,
    });
    const call = async (name: string) => {
      const tool = toolRegistry.list().find((t) => t.name === `mcp__wx__${name}`);
      if (!tool) throw new Error(`${name} not registered`);
      const signal = new AbortController().signal;
      return String(await tool.execute({}, { signal } as never, { signal }));
    };

    const good = await call('weather');
    expect(good).toContain('Fetched the weather for Oslo.');
    expect(good).toContain('"celsius": 3');
    expect(good).not.toContain('does not match');

    const broken = await call('broken');
    expect(broken).toContain("does not match the tool's declared output schema");
  });
});
