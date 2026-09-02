/**
 * @wrongstack/plugins — scan honesty tests.
 *
 * The source-scanning plugins stop walking once they hit their findings
 * cap. That is the right behaviour, but they used to report the *discovered*
 * file count as `scannedFiles` and gave no indication that the walk had
 * been cut short. A caller then saw "scanned 4000 files, 50 findings" for a
 * run that actually opened 3 of them — and a capped scan of a clean-looking
 * subset was indistinguishable from a complete one.
 *
 * These tests pin the two properties that fix: counts describe work
 * actually done, and truncation is stated.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const refactorSuggester = (await import('../src/refactor-suggester/index.js')).default;
const featureFlagTracker = (await import('../src/feature-flag-tracker/index.js')).default;
const interfaceContractGuard = (await import('../src/interface-contract-guard/index.js')).default;

interface RegisteredTool {
  name: string;
  execute(input: unknown, ctx?: unknown): Promise<Any>;
}

function makeApi(extensions: Record<string, unknown> = {}) {
  const tools: RegisteredTool[] = [];
  return {
    tools: { register: (t: RegisteredTool) => tools.push(t), list: () => tools },
    slashCommands: { register() {} },
    config: { extensions },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    metrics: { counter() {}, histogram() {}, gauge() {} },
    session: { append: async () => {} },
    extensions: { register: () => ({ unregister() {} }) },
    registerSystemPromptContributor: () => () => {},
    registerHook: () => () => {},
    onEvent: () => () => {},
    onPattern: () => () => {},
    emitCustom() {},
    onConfigChange: () => () => {},
    _tools: tools,
  };
}

function tool(api: { _tools: RegisteredTool[] }, name: string): RegisteredTool {
  const t = api._tools.find((x) => x.name === name);
  if (!t)
    throw new Error(
      `tool ${name} not registered (have: ${api._tools.map((x) => x.name).join(', ')})`,
    );
  return t;
}

let tmpDir: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-truncation-'));
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('refactor-suggester truncation', () => {
  it('reports truncated + an accurate scannedFiles when the cap stops the walk', async () => {
    // Many files, each with a smell, and a cap of 1 — so the walk must
    // stop after the first file and say so.
    const src = path.join(tmpDir, 'src');
    await fs.mkdir(src);
    const longFn = `function big() {\n${'  const x = 1;\n'.repeat(200)}}\n`;
    for (let i = 0; i < 12; i++) {
      await fs.writeFile(path.join(src, `f${i}.ts`), longFn, 'utf8');
    }

    const api = makeApi({ 'refactor-suggester': { enabled: true, maxSuggestions: 1 } });
    await refactorSuggester.setup(api as Any);
    const res = await tool(api, 'suggest_refactors').execute({ path: 'src' });

    expect(res.ok).toBe(true);
    expect(res.discoveredFiles).toBe(12);
    // Only the files actually opened may be counted.
    expect(res.scannedFiles).toBeLessThan(res.discoveredFiles);
    expect(res.truncated).toBe(true);
    refactorSuggester.teardown?.(api as Any);
  });

  it('does not claim truncation when the whole tree was read', async () => {
    const src = path.join(tmpDir, 'src');
    await fs.mkdir(src);
    await fs.writeFile(path.join(src, 'clean.ts'), 'export const a = 1;\n', 'utf8');

    const api = makeApi({ 'refactor-suggester': { enabled: true } });
    await refactorSuggester.setup(api as Any);
    const res = await tool(api, 'suggest_refactors').execute({ path: 'src' });

    expect(res.truncated).toBe(false);
    expect(res.scannedFiles).toBe(res.discoveredFiles);
    refactorSuggester.teardown?.(api as Any);
  });
});

describe('feature-flag-tracker truncation', () => {
  it('reports truncated + an accurate scannedFiles when the cap stops the walk', async () => {
    const src = path.join(tmpDir, 'src');
    await fs.mkdir(src);
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(
        path.join(src, `f${i}.ts`),
        // Matches the plugin's default `isFeatureEnabled('…')` pattern.
        `if (isFeatureEnabled('flag_${i}')) { doThing(); }\n`,
        'utf8',
      );
    }

    const api = makeApi({ 'feature-flag-tracker': { enabled: true, maxFindings: 1 } });
    await featureFlagTracker.setup(api as Any);
    const res = await tool(api, 'scan_feature_flags').execute({ path: 'src' });

    expect(res.ok).toBe(true);
    expect(res.discoveredFiles).toBe(10);
    expect(res.scannedFiles).toBeLessThan(res.discoveredFiles);
    expect(res.truncated).toBe(true);
    featureFlagTracker.teardown?.(api as Any);
  });
});

describe('interface-contract-guard', () => {
  it('recognises an implementer declared in a different file', async () => {
    // The single-pass implementer index has to see across files, exactly
    // as the old per-name cross-file regex sweep did.
    const src = path.join(tmpDir, 'src');
    await fs.mkdir(src);
    await fs.writeFile(
      path.join(src, 'contract.ts'),
      'export interface Greeter { hi(): void }\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(src, 'impl.ts'),
      'class EnglishGreeter implements Greeter { hi() {} }\n',
      'utf8',
    );

    const api = makeApi({ 'interface-contract-guard': { enabled: true } });
    await interfaceContractGuard.setup(api as Any);
    const res = await tool(api, 'check_interface_contracts').execute({ path: 'src' });

    expect(res.ok).toBe(true);
    expect(res.findings.map((f: { interfaceName: string }) => f.interfaceName)).not.toContain(
      'Greeter',
    );
    interfaceContractGuard.teardown?.(api as Any);
  });

  it('flags an interface nothing implements', async () => {
    const src = path.join(tmpDir, 'src');
    await fs.mkdir(src);
    await fs.writeFile(
      path.join(src, 'lonely.ts'),
      'export interface Orphan { x: number }\n',
      'utf8',
    );

    const api = makeApi({ 'interface-contract-guard': { enabled: true } });
    await interfaceContractGuard.setup(api as Any);
    const res = await tool(api, 'check_interface_contracts').execute({ path: 'src' });

    expect(res.findings.map((f: { interfaceName: string }) => f.interfaceName)).toContain('Orphan');
    interfaceContractGuard.teardown?.(api as Any);
  });

  it('reports accurate line numbers for several interfaces in one file', async () => {
    // Line numbers came from re-slicing the file per match; the
    // single-forward-scan replacement has to produce identical results.
    const src = path.join(tmpDir, 'src');
    await fs.mkdir(src);
    await fs.writeFile(
      path.join(src, 'many.ts'),
      ['// header', '', 'interface AAA { a: 1 }', '', '', 'interface BBB { b: 2 }', ''].join('\n'),
      'utf8',
    );

    const api = makeApi({ 'interface-contract-guard': { enabled: true } });
    await interfaceContractGuard.setup(api as Any);
    const res = await tool(api, 'check_interface_contracts').execute({ path: 'src' });

    const byName = Object.fromEntries(
      res.findings.map((f: { interfaceName: string; line: number }) => [f.interfaceName, f.line]),
    );
    expect(byName['AAA']).toBe(3);
    expect(byName['BBB']).toBe(6);
    interfaceContractGuard.teardown?.(api as Any);
  });

  it('reports truncation when maxFiles caps the corpus', async () => {
    const src = path.join(tmpDir, 'src');
    await fs.mkdir(src);
    for (let i = 0; i < 6; i++) {
      await fs.writeFile(path.join(src, `i${i}.ts`), `interface I${i} { v: number }\n`, 'utf8');
    }

    const api = makeApi({ 'interface-contract-guard': { enabled: true, maxFiles: 2 } });
    await interfaceContractGuard.setup(api as Any);
    const res = await tool(api, 'check_interface_contracts').execute({ path: 'src' });

    expect(res.truncated).toBe(true);
    expect(res.scannedFiles).toBe(2);
    expect(res.note).toContain('partial');
    interfaceContractGuard.teardown?.(api as Any);
  });
});
