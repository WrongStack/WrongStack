import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/core/kernel';
import type { Logger } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { DocumentTracker } from '../../src/document-tracker.js';
import { LSPRegistry } from '../../src/registry.js';
import { makeLSPTools } from '../../src/tools/index.js';
import type { PlugLSPConfig } from '../../src/types.js';
import { workspaceTypeScriptMajor } from '../../src/typescript-flavor.js';
import { resolveServerCommand } from '../../src/utils/command-resolver.js';

// TypeScript 7's native binary IS the language server (`tsc --lsp --stdio`);
// it ships no tsserver.js, so typescript-language-server cannot drive it. This
// is the path every TS 7 workspace takes, including this repo.
const major = await workspaceTypeScriptMajor(process.cwd());
const command = await resolveServerCommand('tsc', process.cwd());
const runnable = command !== null && major !== undefined && major >= 7;

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

describe.skipIf(!runnable)('native TypeScript language server E2E', () => {
  it('returns definitions and diagnostics from tsc --lsp', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-tsgo-'));
    await fs.writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext' } }),
    );
    const source = path.join(root, 'index.ts');
    await fs.writeFile(source, 'export const answer: number = "nope";\nanswer;\n');

    const cfg: PlugLSPConfig = {
      servers: {
        'typescript-native': {
          command: command!,
          args: ['--lsp', '--stdio'],
          languages: ['typescript', 'typescriptreact'],
          rootPatterns: ['tsconfig.json'],
          startupTimeoutMs: 20_000,
          enabled: true,
        },
      },
      autoStart: 'lazy',
      diagnosticsAfterEdit: 'background',
      // A cold server takes a moment to analyse the project.
      diagnosticsWaitMs: 20_000,
      severityFilter: ['error', 'warning'],
      maxDiagnosticsPerFile: 20,
      maxDiagnosticsTotal: 50,
      autoDiscover: false,
      logServerOutput: false,
    };

    const holder: { registry?: LSPRegistry } = {};
    const tracker = new DocumentTracker(() => holder.registry!, log, root);
    const registry = new LSPRegistry(cfg, tracker, { cwd: root, log, events: new EventBus() });
    holder.registry = registry;
    await registry.bind(root, 'lazy');
    await tracker.open(source);

    const tools = new Map(
      makeLSPTools({ registry, tracker, cfg, log }).map((tool) => [tool.name, tool]),
    );
    const ctx = { cwd: root, projectRoot: root } as never;
    const signal = new AbortController().signal;

    const definition = await tools
      .get('lsp_definition')!
      .execute({ path: source, line: 1, character: 14 }, ctx, { signal });
    expect(String(definition)).toContain('index.ts:1:14');

    // This only passes because the client answers the server's
    // `client/registerCapability` request — the native server registers a
    // configuration watcher during `initialized` and blocks on the reply.
    const diagnostics = await tools
      .get('lsp_diagnostics')!
      .execute({ path: source }, ctx, { signal });
    expect(String(diagnostics).toLowerCase()).toContain('string');

    await registry.shutdown();
    // No rm: the server process may still hold the directory on Windows
    // (EBUSY), and the OS reclaims the temp dir anyway.
  }, 60_000);
});
