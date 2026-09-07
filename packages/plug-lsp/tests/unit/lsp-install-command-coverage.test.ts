import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { installLang } = vi.hoisted(() => ({ installLang: vi.fn() }));

vi.mock('../../src/slash-commands/install.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/slash-commands/install.js')>();
  return { ...actual, installLang };
});

import { buildLspCommand, LANGUAGE_SERVERS } from '../../src/slash-commands/lsp.js';

// `/lsp install` now saves and starts the server, so give it a registry that
// can do both and a throwaway state root to write into.
const realHome = process.env['WRONGSTACK_HOME'];
let tmpHome: string;

beforeAll(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-install-'));
  process.env['WRONGSTACK_HOME'] = tmpHome;
});

afterAll(async () => {
  if (realHome === undefined) delete process.env['WRONGSTACK_HOME'];
  else process.env['WRONGSTACK_HOME'] = realHome;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

function context() {
  return {
    registry: {
      list: vi.fn(() => []),
      upsertServer: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
    },
    tracker: { list: vi.fn(() => []) },
    cfg: {
      autoStart: 'lazy',
      severityFilter: ['error'],
      maxDiagnosticsPerFile: 10,
      maxDiagnosticsTotal: 20,
      servers: {},
    },
    cwd: process.cwd(),
  } as never;
}

async function run(args: string) {
  const result = await buildLspCommand(context()).run!(args);
  if (!result) throw new Error('LSP command returned no result');
  return result;
}

describe('unified LSP install command coverage', () => {
  beforeEach(() => {
    installLang.mockReset();
  });

  it('renders already-installed and dry-run results with fallback configuration values', async () => {
    const rootPatterns = LANGUAGE_SERVERS.go!.rootPatterns;
    delete LANGUAGE_SERVERS.go!.rootPatterns;
    installLang.mockResolvedValueOnce({ alreadyInstalled: true });
    expect((await run('install go')).message).toContain('Already installed:');

    installLang.mockResolvedValueOnce({
      alreadyInstalled: false,
      dryRun: true,
      installCommand: 'go install gopls',
    });
    expect((await run('install go')).message).toContain('Dry run');
    if (rootPatterns === undefined) delete LANGUAGE_SERVERS.go!.rootPatterns;
    else LANGUAGE_SERVERS.go!.rootPatterns = rootPatterns;
  });

  it('renders system and package-manager installations', async () => {
    const rootPatterns = LANGUAGE_SERVERS.go!.rootPatterns;
    delete LANGUAGE_SERVERS.go!.rootPatterns;
    installLang.mockResolvedValueOnce({
      alreadyInstalled: false,
      dryRun: false,
      packageManager: 'system',
      installCommand: 'go install gopls',
    });
    expect((await run('install go')).message).toContain('Go toolchain');

    installLang.mockResolvedValueOnce({
      alreadyInstalled: false,
      dryRun: false,
      packageManager: 'pnpm',
      installCommand: 'pnpm add -D pyright',
    });
    expect((await run('add python')).message).toContain('pnpm add -D pyright');
    if (rootPatterns === undefined) delete LANGUAGE_SERVERS.go!.rootPatterns;
    else LANGUAGE_SERVERS.go!.rootPatterns = rootPatterns;
  });

  it('formats Error and non-Error install failures', async () => {
    installLang.mockRejectedValueOnce(new Error('install exploded'));
    expect((await run('install python')).message).toContain('install exploded');

    installLang.mockRejectedValueOnce('string failure');
    expect((await run('install python')).message).toContain('string failure');
  });
});
