import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
import { resolveServerCommand } from '../../src/utils/command-resolver.js';

// Runs whenever the server binary resolves. `typescript-language-server` is a
// root devDependency precisely so this runs on every `pnpm test`: it is the
// only check that exercises a real JSON-RPC handshake, and the four bugs it
// caught on first execution (bare-name spawn on Windows, URI spelling
// mismatch, unwaited push diagnostics, undeclared publishDiagnostics
// capability) were all invisible to the mock-server tests.
const hasTypeScriptLanguageServer = commandExists('typescript-language-server');

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

describe.skipIf(!hasTypeScriptLanguageServer)('typescript-language-server E2E', () => {
  it('returns diagnostics and hover from a real TypeScript server', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-ts-'));
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ type: 'module', devDependencies: { typescript: '*' } }),
    );
    await fs.writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext' } }),
    );
    const source = path.join(root, 'index.ts');
    await fs.writeFile(source, 'export const answer: number = "nope";\nanswer;\n');

    // Resolve the way the plugin does at runtime. A bare name is not
    // spawnable on Windows even when `where.exe` finds it, so a test that
    // hardcodes the name would pass on POSIX and lie about Windows.
    const command = await resolveServerCommand('typescript-language-server', root);
    expect(command).toBeTruthy();

    const cfg: PlugLSPConfig = {
      servers: {
        typescript: {
          command: command ?? 'typescript-language-server',
          args: ['--stdio'],
          languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
          rootPatterns: ['tsconfig.json', 'package.json'],
          // The temp workspace has no node_modules, and this repo's own
          // TypeScript is the 6.x native build with no tsserver.js. Point the
          // server at the aliased 5.x devDependency instead.
          initializationOptions: { tsserver: { path: tsserverPath() } },
          startupTimeoutMs: 15_000,
          enabled: true,
        },
      },
      autoStart: 'lazy',
      diagnosticsAfterEdit: 'background',
      // A cold tsserver takes seconds to publish its first analysis.
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
    expect(String(definition)).toContain('index.ts:1:1');

    const diagnostics = await tools
      .get('lsp_diagnostics')!
      .execute({ path: source }, ctx, { signal });
    expect(String(diagnostics).toLowerCase()).toContain('string');

    await registry.shutdown();
  }, 30_000);
});

function tsserverPath(): string {
  // Walk up: vitest runs this file from the repo root and from the package.
  let dir = path.resolve(import.meta.dirname);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', 'typescript5', 'lib', 'tsserver.js');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return candidate;
    dir = parent;
  }
}

function commandExists(command: string): boolean {
  const result =
    process.platform === 'win32'
      ? spawnSync('where.exe', [command], { stdio: 'ignore' })
      : spawnSync('sh', ['-lc', `command -v ${JSON.stringify(command)}`], { stdio: 'ignore' });
  return result.status === 0;
}
