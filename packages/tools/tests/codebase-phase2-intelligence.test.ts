import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyFileChange,
  classifyIncrementalUpdateStrategy,
  classifySymbolBodyDrift,
  codebaseDiffImpactTool,
  computeFileStructuralFingerprint,
  computeStructuralFingerprint,
  detectFileCommunities,
  detectStoreFileCommunities,
  enrichConcepts,
  hasDynamicSymbolInjection,
  matchSymbolsToDiffHunks,
  normalizeConceptRelation,
  normalizeSymbolKindAlias,
  normalizeTestConceptEdge,
  parseUnifiedDiff,
  runIndexer,
  type SummarizerPort,
  validateIncrementalSymbolLoss,
} from '../src/codebase-index/index.js';
import { IndexStore, indexStorePool } from '../src/codebase-index/writer.js';

let tmpDir: string;
let indexDir: string;
let store: IndexStore | null = null;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-phase2-'));
  indexDir = path.join(tmpDir, '.idx');
});

afterEach(async () => {
  store?.close();
  store = null;
  indexStorePool.evict(tmpDir, indexDir);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function write(rel: string, body: string): Promise<void> {
  const full = path.join(tmpDir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, 'utf8');
}

const relativeOf = (file: string): string => {
  const rel = path.relative(tmpDir, file);
  return (rel && !rel.startsWith('..') ? rel : file).split('\\').join('/');
};

describe('Phase 2.1: Structural Fingerprinting & Cosmetic Change Gating', () => {
  it('computes identical structural fingerprints across whitespace/signature formatting and classifies changes', () => {
    const sigA = computeStructuralFingerprint(
      [
        {
          name: 'calculateTotal',
          kind: 'function',
          scope: '',
          signature: 'export function calculateTotal(price:  number,\n  tax: number): number',
        },
      ],
      [{ callType: 'call', toName: 'roundCurrency', module: '' }],
    );

    const sigB = computeStructuralFingerprint(
      [
        {
          name: 'calculateTotal',
          kind: 'function',
          scope: '',
          signature: 'export function calculateTotal(price: number, tax: number): number',
        },
      ],
      [{ callType: 'call', toName: 'roundCurrency', module: '' }],
    );

    const sigChanged = computeStructuralFingerprint(
      [
        {
          name: 'calculateTotal',
          kind: 'function',
          scope: '',
          signature: 'export function calculateTotal(price: number): number',
        },
      ],
      [{ callType: 'call', toName: 'roundCurrency', module: '' }],
    );

    expect(sigA).toBe(sigB);
    expect(sigA).not.toBe(sigChanged);

    expect(
      classifyFileChange(
        { contentHash: 'aaa', signatureHash: sigA },
        { contentHash: 'aaa', signatureHash: sigB },
      ),
    ).toBe('NONE');

    expect(
      classifyFileChange(
        { contentHash: 'aaa', signatureHash: sigA },
        { contentHash: 'bbb', signatureHash: sigB },
      ),
    ).toBe('COSMETIC');

    expect(
      classifyFileChange(
        { contentHash: 'aaa', signatureHash: sigA },
        { contentHash: 'bbb', signatureHash: sigChanged },
      ),
    ).toBe('STRUCTURAL');
  });

  it('preserves ready file_concepts without re-calling the LLM when a file undergoes a cosmetic edit', async () => {
    await write(
      'src/math.ts',
      `export function add(a: number, b: number): number {
  return a + b;
}
`,
    );
    await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
    store = new IndexStore(tmpDir, { indexDir });

    const calls: string[] = [];
    const port: SummarizerPort = {
      describeFile: vi.fn(async (input) => {
        calls.push(input.file);
        return { summary: `Summary of ${input.file}`, cruxStart: 1, cruxEnd: 2, model: 'test' };
      }),
    };

    const first = await enrichConcepts(store, port, relativeOf);
    expect(first.summarised).toBe(1);
    expect(calls).toEqual(['src/math.ts']);

    const initialSig = computeFileStructuralFingerprint(store, path.join(tmpDir, 'src/math.ts'));
    expect(initialSig).toMatch(/^[0-9a-f]{64}$/);

    // Cosmetic edit: add comments and whitespace without changing declarations or outgoing refs
    store.close();
    store = null;
    await write(
      'src/math.ts',
      `// Added documentation comment and extra blank lines
export function add(a: number, b: number): number {
  // Purely internal comment
  return a + b;
}
`,
    );
    indexStorePool.evict(tmpDir, indexDir);
    await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
    store = new IndexStore(tmpDir, { indexDir });

    calls.length = 0;
    const second = await enrichConcepts(store, port, relativeOf);
    expect(second.markedStale).toBe(0);
    expect(second.summarised).toBe(0);
    expect(second.cached).toBe(1);
    expect(calls).toEqual([]);
  });
});

describe('Phase 2.2: codebase-diff-impact Tool', () => {
  it('parses unified diff hunks and maps them to affected declarations', () => {
    const rawDiff = [
      'diff --git a/src/billing.ts b/src/billing.ts',
      'index 1111111..2222222 100644',
      '--- a/src/billing.ts',
      '+++ b/src/billing.ts',
      '@@ -12,2 +12,4 @@ export function chargeCard',
      '+  validateAmount(amount);',
      'diff --git a/src/new-helper.ts b/src/new-helper.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new-helper.ts',
      '@@ -0,0 +1,5 @@',
    ].join('\n');

    const parsed = parseUnifiedDiff(rawDiff);
    expect(parsed).toEqual([
      {
        file: 'src/billing.ts',
        status: 'modified',
        hunks: [{ startLine: 12, endLine: 15 }],
      },
      {
        file: 'src/new-helper.ts',
        status: 'added',
        hunks: [{ startLine: 1, endLine: 5 }],
      },
    ]);

    const symbols = [
      { name: 'initBilling', kind: 'function', line: 1 },
      { name: 'chargeCard', kind: 'function', line: 10 },
      { name: 'refundCard', kind: 'function', line: 25 },
    ];
    const matched = matchSymbolsToDiffHunks(symbols, parsed[0]?.hunks ?? []);
    expect(matched.map((s) => s.name)).toEqual(['chargeCard']);
  });

  it('does not read an in-hunk --- / +++ content pair as a file header', () => {
    // The removed source line was `-- drop table t;` (its diff line is
    // `--- drop table t;`) and the added one was `++ create index i on t (id);`
    // (its diff line is `+++ create index i on t (id);`). Git emits the two
    // adjacently INSIDE the hunk body, so they are byte-for-byte the shape of
    // a file-header pair — but they are content, and reading them as a header
    // invented a file that was never touched.
    const rawDiff = [
      'diff --git a/q.sql b/q.sql',
      'index 1111111..2222222 100644',
      '--- a/q.sql',
      '+++ b/q.sql',
      '@@ -1 +1 @@',
      '--- drop table t;',
      '+++ create index i on t (id);',
    ].join('\n');

    expect(parseUnifiedDiff(rawDiff)).toEqual([
      {
        file: 'q.sql',
        status: 'modified',
        hunks: [{ startLine: 1, endLine: 1 }],
      },
    ]);
  });

  it('still reads a real header pair after a hunk body as a file header', () => {
    // The same rule in the other direction: once the hunk body is exhausted,
    // the next `--- `/`+++ ` pair IS a header again (a raw unified diff has no
    // `diff --git` line to separate the sections).
    const rawDiff = [
      '--- a/first.sql',
      '+++ b/first.sql',
      '@@ -1 +1 @@',
      '-drop table t;',
      '+create table t (id int);',
      '--- a/second.sql',
      '+++ b/second.sql',
      '@@ -4 +4 @@',
      '-old line',
      '+new line',
    ].join('\n');

    expect(parseUnifiedDiff(rawDiff)).toEqual([
      {
        file: 'first.sql',
        status: 'modified',
        hunks: [{ startLine: 1, endLine: 1 }],
      },
      {
        file: 'second.sql',
        status: 'modified',
        hunks: [{ startLine: 4, endLine: 4 }],
      },
    ]);
  });

  it('analyzes working tree git diff, callers, test suites, and AST contract violations', async () => {
    await write(
      'src/discount.ts',
      `export function computeDiscount(price: number, rate: number): number {
  return price * rate;
}
export function legacyHelper(): string {
  return 'legacy';
}
`,
    );
    await write(
      'src/checkout.ts',
      `import { computeDiscount } from './discount.js';
export function runCheckout(total: number): number {
  return total - computeDiscount(total, 0.1);
}
`,
    );
    await write(
      'tests/discount.test.ts',
      `import { computeDiscount } from '../src/discount.js';
export function testDiscount(): void {
  computeDiscount(100, 0.2);
}
`,
    );

    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: tmpDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: tmpDir, stdio: 'ignore' });

    await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });

    // Modify src/discount.ts: narrow parameter list of computeDiscount (INV-002) and remove legacyHelper (INV-001)
    await write(
      'src/discount.ts',
      `export function computeDiscount(price: number): number {
  return price * 0.15;
}
`,
    );

    const report = await codebaseDiffImpactTool.execute(
      { persist: true },
      {
        cwd: tmpDir,
        projectRoot: tmpDir,
        meta: { codebaseIndexDir: indexDir },
      } as never,
      { signal: new AbortController().signal },
    );

    expect(report.status).toBe('ok');
    expect(report.persistedOverlayPath).toBe('.wrongstack/atlas/diff-overlay.json');
    expect(report.changedFiles.map((f) => f.file)).toEqual(['src/discount.ts']);
    expect(report.affectedSymbols.map((s) => s.name)).toContain('computeDiscount');
    expect(report.affectedProductionFiles).toContain('src/checkout.ts');
    expect(report.affectedTestFiles).toContain('tests/discount.test.ts');
    expect(report.invariantViolations.length).toBeGreaterThan(0);
    expect(report.riskLevel).toBe('high');
  });
});

describe('Phase 2.3: Deterministic Louvain Community Detection', () => {
  it('partitions a two-clique bar-bell graph deterministically into two communities', () => {
    const nodes = [
      'src/auth/login.ts',
      'src/auth/session.ts',
      'src/auth/token.ts',
      'src/billing/invoice.ts',
      'src/billing/ledger.ts',
      'src/billing/stripe.ts',
    ];
    const edges = [
      // Dense auth cluster
      { from: 'src/auth/login.ts', to: 'src/auth/session.ts', weight: 5 },
      { from: 'src/auth/session.ts', to: 'src/auth/token.ts', weight: 5 },
      { from: 'src/auth/login.ts', to: 'src/auth/token.ts', weight: 5 },
      // Dense billing cluster
      { from: 'src/billing/invoice.ts', to: 'src/billing/ledger.ts', weight: 5 },
      { from: 'src/billing/ledger.ts', to: 'src/billing/stripe.ts', weight: 5 },
      { from: 'src/billing/invoice.ts', to: 'src/billing/stripe.ts', weight: 5 },
      // Weak bridge between clusters
      { from: 'src/billing/invoice.ts', to: 'src/auth/session.ts', weight: 1 },
    ];

    const first = detectFileCommunities(nodes, edges);
    const second = detectFileCommunities([...nodes].reverse(), [...edges].reverse());

    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    const memberSets = first.map((c) => new Set(c.files));
    expect(memberSets).toContainEqual(
      new Set(['src/auth/login.ts', 'src/auth/session.ts', 'src/auth/token.ts']),
    );
    expect(memberSets).toContainEqual(
      new Set(['src/billing/invoice.ts', 'src/billing/ledger.ts', 'src/billing/stripe.ts']),
    );
  });

  it('discovers store file communities and refines flat single-directory subsystem derivation', async () => {
    await write('src/auth_token.ts', 'export function signToken(): string { return "t"; }\n');
    await write(
      'src/auth_session.ts',
      'import { signToken } from "./auth_token.js";\nexport function openSession(): string { return signToken(); }\n',
    );
    await write('src/pay_ledger.ts', 'export function recordEntry(): number { return 1; }\n');
    await write(
      'src/pay_invoice.ts',
      'import { recordEntry } from "./pay_ledger.js";\nexport function createInvoice(): number { return recordEntry(); }\n',
    );

    await runIndexer(undefined as never, { projectRoot: tmpDir, indexDir });
    store = new IndexStore(tmpDir, { indexDir });

    const communities = detectStoreFileCommunities(store, relativeOf);
    expect(communities.length).toBe(2);

    const subsystemInputs: string[] = [];
    const seenNeighborExports = new Map<
      string,
      ReadonlyArray<{ file: string; symbols: readonly string[] }>
    >();
    const port: SummarizerPort = {
      describeFile: async (input) => {
        if (input.neighborExports) {
          seenNeighborExports.set(input.file, input.neighborExports);
        }
        return { summary: `File ${input.file}` };
      },
      describeSubsystem: async (input) => {
        subsystemInputs.push(input.name);
        return { summary: `Subsystem ${input.name}` };
      },
    };

    const enriched = await enrichConcepts(store, port, relativeOf, { subsystems: true });
    expect(enriched.subsystems).toBe(2);
    expect(enriched.updateStrategy).toBe('PARTIAL_UPDATE');
    expect(subsystemInputs).toHaveLength(2);
    expect(seenNeighborExports.get('src/auth_session.ts')).toEqual([
      { file: 'src/auth_token.ts', symbols: ['signToken'] },
    ]);

    const secondPass = await enrichConcepts(store, port, relativeOf, { subsystems: true });
    expect(secondPass.updateStrategy).toBe('SKIP_COSMETIC');
    expect(secondPass.subsystems).toBe(0);
  });

  it('validates incremental symbol loss, dynamic injection, and concept relation normalization', () => {
    expect(classifyIncrementalUpdateStrategy(0)).toBe('SKIP_COSMETIC');
    expect(classifyIncrementalUpdateStrategy(4)).toBe('PARTIAL_UPDATE');
    expect(classifyIncrementalUpdateStrategy(18)).toBe('ARCHITECTURE_UPDATE');
    expect(classifyIncrementalUpdateStrategy(45)).toBe('FULL_UPDATE');
    expect(hasDynamicSymbolInjection('Object.defineProperty(target, "x", { value: 1 })')).toBe(
      true,
    );
    expect(hasDynamicSymbolInjection('export function plain() {}')).toBe(false);

    const loss = validateIncrementalSymbolLoss(
      [
        { name: 'alpha', kind: 'function' },
        { name: 'beta', kind: 'function' },
      ],
      [{ name: 'alpha', kind: 'function' }],
    );
    expect(loss.status).toBe('symbol-loss-detected');
    expect(loss.missingSymbols).toEqual(['beta']);

    const dynamicLoss = validateIncrementalSymbolLoss(
      [{ name: 'alpha', kind: 'function' }],
      [],
      'setattr(module, "alpha", fn)',
    );
    expect(dynamicLoss.status).toBe('dynamic-injection-uncertain');
    expect(dynamicLoss.hasDynamicInjection).toBe(true);

    expect(normalizeConceptRelation('depends_on')).toBe('uses');
    expect(normalizeConceptRelation('queries')).toBe('persists');
    expect(normalizeConceptRelation('implements')).toBe('extends');
    expect(normalizeConceptRelation('frobnicates')).toBeNull();

    expect(normalizeSymbolKindAlias('component')).toBe('function');
    expect(normalizeSymbolKindAlias('service')).toBe('class');
    expect(normalizeSymbolKindAlias('dto')).toBe('type');
    expect(normalizeSymbolKindAlias('cluster')).toBe('namespace');

    expect(
      normalizeTestConceptEdge(
        { fromId: 'billing', toId: 'tests', relation: 'uses' },
        (id) => id === 'tests',
      ),
    ).toEqual({ fromId: 'tests', toId: 'billing', relation: 'validates' });

    const drift = classifySymbolBodyDrift(
      [{ name: 'calc', kind: 'function', line: 1, endLine: 10 }],
      [{ name: 'calc', kind: 'function', line: 1, endLine: 25 }],
    );
    expect(drift.hasMajorDrift).toBe(true);
    expect(drift.driftedSymbols).toEqual(['calc']);
    expect(
      classifyFileChange(
        { contentHash: 'h1', signatureHash: 'sig1' },
        { contentHash: 'h2', signatureHash: 'sig1' },
        {
          prevSymbols: [{ name: 'calc', kind: 'function', line: 1, endLine: 10 }],
          nextSymbols: [{ name: 'calc', kind: 'function', line: 1, endLine: 25 }],
        },
      ),
    ).toBe('STRUCTURAL');
  });
});
