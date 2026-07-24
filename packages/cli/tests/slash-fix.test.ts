import type { Context } from '@wrongstack/core/agent';
import { SlashCommandRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { HybridCompactor } from '@wrongstack/core/execution';
import { DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import { describe, expect, it } from 'vitest';
import { classifyError, needsSubagent, isSimpleFix } from '../src/slash-commands/fix-classifier.js';
import { buildBuiltinSlashCommands } from '../src/slash-commands/index.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

class FakeRenderer {
  output = '';
  warnings: string[] = [];
  errors: string[] = [];
  infos: string[] = [];
  write(s: unknown): void {
    this.output += typeof s === 'string' ? s : ((s as { text?: string }).text ?? '');
  }
  writeLine(s = ''): void { this.output += `${s}\n`; }
  writeBlock(): void {}
  writeToolCall(): void {}
  writeToolResult(): void {}
  writeDiff(): void {}
  writeWarning(s: string): void { this.warnings.push(s); }
  writeError(s: string): void { this.errors.push(s); }
  writeInfo(s: string): void { this.infos.push(s); }
  clear(): void { this.output = ''; }
}

function makeRig() {
  const registry = new SlashCommandRegistry();
  const toolRegistry = new ToolRegistry();
  const renderer = new FakeRenderer();
  const cmds = buildBuiltinSlashCommands({
    registry,
    toolRegistry,
    compactor: new HybridCompactor({ preserveK: 5 }),
    tokenCounter: new DefaultTokenCounter(),
    renderer: renderer as never as Parameters<typeof buildBuiltinSlashCommands>[0]['renderer'],
    cwd: '/tmp',
    projectRoot: '/proj',
  } as never as SlashCommandContext);
  for (const c of cmds) registry.register(c);
  return { registry, renderer, toolRegistry };
}

const fakeCtx = {
  messages: [],
  todos: [],
  systemPrompt: [],
  readFiles: new Set(),
  fileMtimes: new Map(),
  model: 'test-model',
  cwd: '/tmp',
  projectRoot: '/proj',
} as never as Context;

// ──────────────────────────────────────────────────────────────────────────────
// classifyError unit tests
// ──────────────────────────────────────────────────────────────────────────────
describe('fix-classifier', () => {
  // ── TypeScript ──────────────────────────────────────────────────────────
  it('classifies TS#### error codes as TypeScript', () => {
    const r = classifyError('TS2345: Argument of type "string | null" is not assignable');
    expect(r.category).toBe('ts');
    expect(r.language).toBe('typescript');
    expect(r.skillHints).toContain('typescript-strict');
    expect(r.errorCode).toBe('TS2345');
    expect(r.confidence).toBe(1.0);
  });

  it('classifies TypeScript error without code', () => {
    const r = classifyError('TypeScript error: type checking failed');
    expect(r.category).toBe('ts');
    expect(r.language).toBe('typescript');
    expect(r.skillHints).toContain('typescript-strict');
  });

  it('classifies : any as ts unsafe-any', () => {
    const r = classifyError('foo: any used in api.ts');
    expect(r.category).toBe('ts');
    expect(r.subcategory).toBe('unsafe-any');
    expect(r.skillHints).toContain('typescript-strict');
  });

  // ── Rust ────────────────────────────────────────────────────────────────
  it('classifies Rust E#### errors', () => {
    const r = classifyError('error[E0503]: expected something but found');
    expect(r.category).toBe('runtime');
    expect(r.subcategory).toBe('panic');
    expect(r.language).toBe('rust');
    expect(r.errorCode).toBe('E0503');
  });

  it('classifies Rust panic', () => {
    const r = classifyError('thread \'main\' panicked at \'index out of bounds\', src/main.rs:42');
    expect(r.category).toBe('runtime');
    expect(r.subcategory).toBe('panic');
    expect(r.language).toBe('rust');
    expect(r.confidence).toBe(1.0);
  });

  it('classifies Rust compiler error', () => {
    const r = classifyError('rustc: error: unused variable: x');
    expect(r.category).toBe('compile');
    expect(r.subcategory).toBe('rust-compile');
    expect(r.language).toBe('rust');
  });

  // ── Go ─────────────────────────────────────────────────────────────────
  it('classifies Go build error', () => {
    const r = classifyError('go build failed: package main is not in GOROOT');
    expect(r.category).toBe('compile');
    expect(r.subcategory).toBe('go-compile');
    expect(r.language).toBe('go');
  });

  it('classifies Go nil pointer', () => {
    const r = classifyError('panic: nil pointer dereference');
    expect(r.category).toBe('runtime');
    expect(r.subcategory).toBe('nil-pointer');
    expect(r.language).toBe('go');
  });

  // ── Python ──────────────────────────────────────────────────────────────
  it('classifies Python traceback', () => {
    const r = classifyError('Traceback (most recent call last):\n  File "test.py", line 42, in <module>');
    expect(r.category).toBe('runtime');
    expect(r.subcategory).toBe('python-traceback');
    expect(r.language).toBe('python');
    expect(r.confidence).toBe(1.0);
  });

  it('classifies Python AttributeError', () => {
    const r = classifyError("AttributeError: 'NoneType' object has no attribute 'encode'");
    expect(r.category).toBe('runtime');
    expect(r.subcategory).toBe('python-type');
    expect(r.language).toBe('python');
  });

  it('classifies Python pip/dependency error', () => {
    const r = classifyError('pip install failed: No matching distribution found');
    expect(r.category).toBe('dep');
    expect(r.subcategory).toBe('python-dep');
    expect(r.language).toBe('python');
  });

  it('classifies mypy type error', () => {
    const r = classifyError('mypy: error: Argument 1 to "len" has incompatible type "str"');
    expect(r.category).toBe('lint');
    expect(r.subcategory).toBe('python-lint');
    expect(r.language).toBe('python');
  });

  // ── Java / Kotlin ─────────────────────────────────────────────────────
  it('classifies Java NullPointerException', () => {
    const r = classifyError('java.lang.NullPointerException');
    expect(r.category).toBe('runtime');
    expect(r.subcategory).toBe('null-pointer');
    expect(r.language).toBe('java');
    expect(r.confidence).toBe(1.0);
  });

  it('classifies Java runtime exception', () => {
    const r = classifyError('Exception in thread "main" java.util.NoSuchElementException');
    expect(r.category).toBe('runtime');
    expect(r.subcategory).toBe('java-exception');
    expect(r.language).toBe('java');
  });

  it('classifies Kotlin compiler error', () => {
    const r = classifyError('kotlin compiler error: unresolved reference');
    expect(r.category).toBe('compile');
    expect(r.subcategory).toBe('kotlin-compile');
    expect(r.language).toBe('kotlin');
  });

  // ── C / C++ ────────────────────────────────────────────────────────────
  it('classifies C compiler error', () => {
    const r = classifyError('gcc: error: undefined reference to \'main\'');
    expect(r.category).toBe('compile');
    expect(r.subcategory).toBe('c-compile');
    expect(r.language).toBe('c');
  });

  it('classifies C segmentation fault', () => {
    const r = classifyError('Segmentation fault (core dumped)');
    expect(r.category).toBe('runtime');
    expect(r.subcategory).toBe('segfault');
    expect(r.language).toBe('c');
    expect(r.confidence).toBe(1.0);
  });

  it('classifies memory safety issue', () => {
    const r = classifyError('heap-buffer-overflow in malloc.c:42');
    expect(r.category).toBe('perf');
    expect(r.subcategory).toBe('memory-safety');
    expect(r.language).toBe('c');
  });

  // ── Node.js / JS ────────────────────────────────────────────────────────
  it('classifies Node.js ENOENT as infra config-error (config.json matches first)', () => {
    const r = classifyError('Error: ENOENT: no such file or directory, open \'config.json\'');
    expect(r.category).toBe('infra');
    expect(r.subcategory).toBe('config-error');
    expect(r.language).toBe('unknown');
  });

  it('classifies null is not a function as runtime', () => {
    const r = classifyError('TypeError: null is not a function');
    expect(r.category).toBe('runtime');
    expect(r.subcategory).toBe('null-undefined-access');
    expect(r.confidence).toBe(0.9);
  });

  it('classifies undefined is not a function', () => {
    const r = classifyError('TypeError: undefined is not a function');
    expect(r.category).toBe('runtime');
    expect(r.subcategory).toBe('null-undefined-access');
    expect(r.confidence).toBe(0.9);
  });

  it('classifies cannot read property', () => {
    const r = classifyError('TypeError: Cannot read property "map" of undefined');
    expect(r.category).toBe('runtime');
    expect(r.subcategory).toBe('undefined-call');
    expect(r.language).toBe('javascript');
  });

  // ── Security ──────────────────────────────────────────────────────────
  it('classifies hardcoded secret as security', () => {
    const r = classifyError('Security: hardcoded API key in config.ts');
    expect(r.category).toBe('security');
    expect(r.subcategory).toBe('secret-exposure');
    expect(r.skillHints).toContain('security-scanner');
    expect(r.confidence).toBe(1.0);
  });

  it('classifies SQL injection as security', () => {
    const r = classifyError('SQL injection vulnerability in query builder');
    expect(r.category).toBe('security');
    expect(r.subcategory).toBe('injection');
    expect(r.skillHints).toContain('security-scanner');
  });

  it('classifies innerHTML XSS as security', () => {
    const r = classifyError('element.innerHTML = userInput — XSS risk');
    expect(r.category).toBe('security');
    expect(r.subcategory).toBe('injection');
    expect(r.skillHints).toContain('security-scanner');
  });

  it('classifies JWT token exposure as security', () => {
    const r = classifyError('JWT token hardcoded in source code');
    expect(r.category).toBe('security');
    expect(r.skillHints).toContain('security-scanner');
  });

  // ── React / Next.js ────────────────────────────────────────────────────
  it('classifies React hooks error', () => {
    const r = classifyError("Error: Invalid hook call. Hooks can only be called inside of the body of a function component");
    expect(r.category).toBe('runtime');
    expect(r.subcategory).toBe('react-error');
    expect(r.skillHints).toContain('react-modern');
  });

  it('classifies Next.js error', () => {
    const r = classifyError('Error in nextjs: getStaticPaths called without getStaticProps');
    expect(r.category).toBe('runtime');
    expect(r.subcategory).toBe('nextjs-error');
    expect(r.skillHints).toContain('react-modern');
  });

  // ── Dependency ────────────────────────────────────────────────────────
  it('classifies module not found as dep', () => {
    const r = classifyError('Error: Cannot find module \'lodash\' in /project/node_modules');
    expect(r.category).toBe('dep');
    expect(r.subcategory).toBe('module-not-found');
    expect(r.confidence).toBe(0.9);
  });

  // ── Infra ─────────────────────────────────────────────────────────────
  it('classifies file system permission error', () => {
    const r = classifyError('EACCES: permission denied, open \'.env\'');
    expect(r.category).toBe('infra');
    expect(r.subcategory).toBe('file-system');
  });

  it('classifies network error', () => {
    const r = classifyError('ECONNREFUSED: connection refused to port 3000');
    expect(r.category).toBe('infra');
    expect(r.subcategory).toBe('network');
    expect(r.skillHints).toContain('node-modern');
  });

  it('classifies Git merge conflict as infra', () => {
    const r = classifyError('git merge conflict in branches feature/auth');
    expect(r.category).toBe('infra');
    expect(r.subcategory).toBe('git-error');
  });

  it('classifies Docker / CI error as infra', () => {
    const r = classifyError('GitHub Actions pipeline failed: docker build returned non-zero exit code 1');
    expect(r.category).toBe('infra');
    expect(r.subcategory).toBe('config-error');
  });

  // ── Logic / Performance ───────────────────────────────────────────────
  it('classifies memory leak as perf', () => {
    const r = classifyError('memory leak: event listener not removed on component unmount');
    expect(r.category).toBe('perf');
    expect(r.subcategory).toBe('performance-issue');
    expect(r.confidence).toBe(0.85);
  });

  it('classifies off-by-one as logic bug', () => {
    const r = classifyError('off-by-one error in pagination calculation');
    expect(r.category).toBe('logic');
    expect(r.subcategory).toBe('wrong-behavior');
  });

  // ── Fallback ───────────────────────────────────────────────────────────
  it('falls back to general for unknown input', () => {
    const r = classifyError('something is broken and not working correctly');
    expect(r.category).toBe('general');
    expect(r.confidence).toBe(0.3);
    expect(r.skillHints).toContain('bug-hunter');
  });

  // ── needsSubagent / isSimpleFix ───────────────────────────────────────
  it('needsSubagent returns true for low-confidence errors', () => {
    expect(needsSubagent(classifyError('something is broken'))).toBe(true);
  });

  it('isSimpleFix returns true for high-confidence TypeScript errors', () => {
    expect(isSimpleFix(classifyError('TS2345: Argument of type "string | null" is not assignable'))).toBe(true);
  });

  it('isSimpleFix returns true for null-undefined-access with high confidence', () => {
    expect(isSimpleFix(classifyError('TypeError: null is not a function'))).toBe(true);
  });

  it('needsSubagent returns false for high-confidence TS errors', () => {
    expect(needsSubagent(classifyError('TS2345: Argument of type "string | null" is not assignable'))).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// /fix command integration tests
// ──────────────────────────────────────────────────────────────────────────────
describe('/fix command', () => {
  it('returns help text when called with no arguments', async () => {
    const { registry } = makeRig();
    const result = await registry.dispatch('/fix', fakeCtx);
    expect(result?.message).toContain('/fix');
    expect(result?.message).toContain('Usage:');
  });

  it('classifies TypeScript error and activates typescript-strict skill', async () => {
    const { registry } = makeRig();
    const result = await registry.dispatch('/fix TS2345: Argument of type "string | null" is not assignable', fakeCtx);
    expect(result?.message).toContain('typescript-strict');
    expect(result?.runText).toContain('TypeScript');
    expect(result?.runText).toContain('TS2345');
    expect(result?.metadata?.skillHints).toContain('typescript-strict');
  });

  it('classifies undefined-call error (cannot read property) as node-modern skill', async () => {
    const { registry } = makeRig();
    const result = await registry.dispatch('/fix TypeError: Cannot read property "map" of undefined', fakeCtx);
    expect(result?.message).toContain('node-modern');
    expect(result?.runText).toContain('Runtime');
  });

  it('classifies hardcoded secret as security-scanner', async () => {
    const { registry } = makeRig();
    const result = await registry.dispatch('/fix Security: hardcoded API key in config.ts', fakeCtx);
    expect(result?.message).toContain('security-scanner');
    expect(result?.runText).toContain('security');
    expect(result?.metadata?.skillHints).toContain('security-scanner');
  });

  it('classifies SQL injection as security-scanner', async () => {
    const { registry } = makeRig();
    const result = await registry.dispatch('/fix SQL injection vulnerability in query builder', fakeCtx);
    expect(result?.message).toContain('security-scanner');
    expect(result?.metadata?.skillHints).toContain('security-scanner');
  });

  it('classifies null is not a function as runtime', async () => {
    const { registry } = makeRig();
    const result = await registry.dispatch('/fix TypeError: null is not a function', fakeCtx);
    expect(result?.message).toContain('null-undefined-access');
    expect(result?.message).toContain('bug-hunter');
  });

  it('classifies Python traceback as runtime (python)', async () => {
    const { registry } = makeRig();
    const result = await registry.dispatch('/fix Traceback (most recent call last): File "test.py", line 1', fakeCtx);
    expect(result?.message).toContain('python-traceback');
    expect(result?.metadata?.skillHints).toContain('bug-hunter');
    expect(result?.runText).toContain('Traceback');
  });

  it('classifies Rust E0503 as runtime error with error code', async () => {
    const { registry } = makeRig();
    const result = await registry.dispatch('/fix error[E0503]: expected something but found E0503 in src/lib.rs', fakeCtx);
    expect(result?.message).toContain('panic');
    expect(result?.runText).toContain('E0503');
    expect(result?.metadata?.delegateRequested).toBe(false); // confidence 1.0 → inline fix
  });

  it('classifies segfault as runtime', async () => {
    const { registry } = makeRig();
    const result = await registry.dispatch('/fix Segmentation fault (core dumped) at main.rs:42', fakeCtx);
    expect(result?.message).toContain('segfault');
    expect(result?.metadata?.skillHints).toContain('bug-hunter');
  });

  it('returns runText containing the problem text verbatim', async () => {
    const { registry } = makeRig();
    const err = 'TS2741: Property "id" is optional but required';
    const result = await registry.dispatch(`/fix ${err}`, fakeCtx);
    expect(result?.runText).toContain(err);
    expect(result?.runText).toContain('TypeScript');
  });

  it('returns metadata with skillHints and delegate info', async () => {
    const { registry } = makeRig();
    const result = await registry.dispatch('/fix TS2345: type error', fakeCtx);
    expect(result?.metadata).toBeDefined();
    expect(result?.metadata?.skillHints).toContain('typescript-strict');
    expect(typeof result?.metadata?.delegateRequested).toBe('boolean');
  });
});