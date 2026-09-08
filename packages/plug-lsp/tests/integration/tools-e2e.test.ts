import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBus } from '@wrongstack/core/kernel';
import type { Logger } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { DocumentTracker } from '../../src/document-tracker.js';
import { LSPRegistry } from '../../src/registry.js';
import { makeLSPTools } from '../../src/tools/index.js';
import type { PlugLSPConfig } from '../../src/types.js';

const fixtureServer = fileURLToPath(new URL('./fixtures/mock-lsp-server.mjs', import.meta.url));

const log: Logger = {
  level: 'error',
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
  child() {
    return this;
  },
};

describe('LSP tools with mock server', () => {
  it('runs semantic read-only tools over JSON-RPC stdio', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-'));
    await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    const source = path.join(root, 'sample.ts');
    await fs.writeFile(source, 'const answer = 42;\nanswer;\n');

    const cfg: PlugLSPConfig = {
      servers: {
        mock: {
          command: process.execPath,
          args: [fixtureServer],
          languages: ['typescript'],
          rootPatterns: ['package.json'],
          startupTimeoutMs: 5000,
          enabled: true,
        },
      },
      autoStart: 'lazy',
      diagnosticsAfterEdit: 'background',
      diagnosticsWaitMs: 100,
      severityFilter: ['error', 'warning'],
      maxDiagnosticsPerFile: 10,
      maxDiagnosticsTotal: 20,
      autoDiscover: false,
      logServerOutput: false,
    };

    const holder: { registry?: LSPRegistry } = {};
    const tracker = new DocumentTracker(() => holder.registry!, log, root);
    const registry = new LSPRegistry(cfg, tracker, { cwd: root, log, events: new EventBus() });
    holder.registry = registry;
    await registry.bind(root, 'lazy');

    const tools = new Map(
      makeLSPTools({ registry, tracker, cfg, log }).map((tool) => [tool.name, tool]),
    );
    const ctx = { cwd: root, projectRoot: root } as Parameters<
      NonNullable<typeof tools.get>['call']
    >[0] & { cwd: string; projectRoot: string };
    const signal = new AbortController().signal;

    const diagnostics = await tools
      .get('lsp_diagnostics')!
      .execute({ path: source }, ctx as never, { signal });
    expect(String(diagnostics)).toContain('MOCK001');

    const definition = await tools
      .get('lsp_definition')!
      .execute({ path: source, line: 1, character: 7 }, ctx as never, { signal });
    expect(String(definition)).toContain('sample.ts:1:1');

    const references = await tools
      .get('lsp_references')!
      .execute({ path: source, line: 1, character: 7 }, ctx as never, { signal });
    expect(String(references)).toContain('sample.ts:2:1');

    const hover = await tools
      .get('lsp_hover')!
      .execute({ path: source, line: 1, character: 7 }, ctx as never, { signal });
    expect(String(hover)).toContain('const answer: number');

    const completion = await tools
      .get('lsp_completion')!
      .execute({ path: source, line: 1, character: 7, limit: 5 }, ctx as never, { signal });
    expect(String(completion)).toContain('answer [Variable]');
    expect(String(completion)).toContain('const answer: number');

    const symbols = await tools
      .get('lsp_symbols')!
      .execute({ path: source }, ctx as never, { signal });
    expect(String(symbols)).toContain('answer [13] line 1');

    const actions = await tools
      .get('lsp_code_actions')!
      .execute({ path: source, line: 1, character: 7 }, ctx as never, { signal });
    expect(String(actions)).toContain('Replace answer [quickfix]');

    const command = await tools
      .get('lsp_execute_command')!
      .execute({ path: source, command: 'mock.command' }, ctx as never, { signal });
    expect(String(command)).toBe('Command completed.');

    const custom = await tools
      .get('lsp_request')!
      .execute({ path: source, method: 'custom/echo', params: { useful: true } }, ctx as never, {
        signal,
      });
    expect(JSON.parse(String(custom))).toEqual({ useful: true });

    const blocked = await tools
      .get('lsp_request')!
      .execute({ path: source, method: 'shutdown' }, ctx as never, { signal });
    expect(String(blocked)).toContain('LSP_INVALID_REQUEST');

    const rename = await tools
      .get('lsp_rename')!
      .execute({ path: source, line: 1, character: 7, new_name: 'renamed' }, ctx as never, {
        signal,
      });
    expect(String(rename)).toContain('Applied: 1 edits');
    expect(await fs.readFile(source, 'utf8')).toContain('const renamed = 42');

    await registry.shutdown();
  });
});
