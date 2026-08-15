import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  codebaseAstReplaceTool,
  codebaseRepoMapTool,
  extractFileSkeleton,
  generateRepoMap,
  replaceSymbolInFile,
} from '../src/codebase-index/index.js';

describe('Comprehensive End-to-End AST, Skeleton & Repo-Map Suite', () => {
  it('E2E Proof: Multi-language Skeleton Extraction, Repo Mapping, and Surgical AST Replacement', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-e2e-proof-'));

    // 1. Setup multi-language project structure
    const srcDir = path.join(tempDir, 'src');
    const pyDir = path.join(tempDir, 'python_module');
    const goDir = path.join(tempDir, 'go_module');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.mkdir(pyDir, { recursive: true });
    await fs.mkdir(goDir, { recursive: true });

    // TS files
    const appTs = path.join(srcDir, 'app.ts');
    await fs.writeFile(
      appTs,
      `import { OrderService } from './order-service.js';
import { User } from './user.js';

export class Application {
  private orderService: OrderService;

  constructor() {
    this.orderService = new OrderService();
  }

  /** Starts the application */
  public async bootstrap(): Promise<void> {
    console.log("Starting server...");
    await this.orderService.initialize();
  }
}
`,
      'utf8',
    );

    const orderServiceTs = path.join(srcDir, 'order-service.ts');
    await fs.writeFile(
      orderServiceTs,
      `export interface Order {
  id: string;
  total: number;
}

export class OrderService {
  private orders: Map<string, Order> = new Map();

  public async initialize(): Promise<void> {
    console.log("Initialized order cache");
  }

  /**
   * Calculates discount for order
   */
  public calculateDiscount(order: Order, rate: number): number {
    const rawDiscount = order.total * rate;
    const finalAmount = Math.max(0, rawDiscount);
    return finalAmount;
  }
}
`,
      'utf8',
    );

    // Python file
    const pyService = path.join(pyDir, 'pipeline.py');
    await fs.writeFile(
      pyService,
      `class DataPipeline:
    def __init__(self, name: str):
        self.name = name

    def process_batch(self, batch):
        """Processes incoming data batch."""
        res = []
        for x in batch:
            res.append(x * 2)
        return res
`,
      'utf8',
    );

    // Go file
    const goService = path.join(goDir, 'handler.go');
    await fs.writeFile(
      goService,
      `package main

func HandleRequest(payload string) (bool, error) {
    if len(payload) == 0 {
        return false, nil
    }
    return true, nil
}
`,
      'utf8',
    );

    try {
      // ═══════════════════════════════════════════════════════════════════════
      // PROOF STEP 1: Skeleton extraction on TS, Python, Go
      // ═══════════════════════════════════════════════════════════════════════
      const tsSkel = await extractFileSkeleton({
        file: orderServiceTs,
        content: await fs.readFile(orderServiceTs, 'utf8'),
        lang: 'ts',
      });

      expect(tsSkel.skeleton).toContain('export interface Order');
      expect(tsSkel.skeleton).toContain(
        'public calculateDiscount(order: Order, rate: number): number { /* L16-L20 */ }',
      );
      expect(tsSkel.skeleton).not.toContain('const rawDiscount');
      expect(tsSkel.stats.tokenSavingsPercent).toBeGreaterThan(15);
      expect(
        tsSkel.symbols?.some((s) => s.name === 'calculateDiscount' && s.startLine === 16),
      ).toBe(true);

      const pySkel = await extractFileSkeleton({
        file: pyService,
        content: await fs.readFile(pyService, 'utf8'),
        lang: 'py',
      });

      expect(pySkel.skeleton).toContain('class DataPipeline:');
      expect(pySkel.skeleton).toContain('def process_batch(self, batch):');
      expect(pySkel.skeleton).toContain('... # L6-L10');
      expect(pySkel.skeleton).not.toContain('res.append');

      const goSkel = await extractFileSkeleton({
        file: goService,
        content: await fs.readFile(goService, 'utf8'),
        lang: 'go',
      });

      expect(goSkel.skeleton).toContain(
        'func HandleRequest(payload string) (bool, error) { /* L3-L8 */ }',
      );

      // ═══════════════════════════════════════════════════════════════════════
      // PROOF STEP 2: Token-budgeted Repo Map generation
      // ═══════════════════════════════════════════════════════════════════════
      const repoMapResult = await generateRepoMap({
        projectRoot: tempDir,
        maxTokens: 800,
      });

      expect(repoMapResult.filesCount).toBeGreaterThanOrEqual(3);
      expect(repoMapResult.map).toContain('src/app.ts');
      expect(repoMapResult.map).toContain('export class Application');
      expect(repoMapResult.map).toContain('src/order-service.ts');
      expect(repoMapResult.map).toContain('export class OrderService');
      expect(repoMapResult.estimatedTokens).toBeLessThanOrEqual(800);

      // Tool execution check
      const repoMapToolOut = await codebaseRepoMapTool.execute(
        {},
        { projectRoot: tempDir } as never,
        { signal: new AbortController().signal },
      );
      expect(repoMapToolOut.status).toBe('ok');
      expect(repoMapToolOut.filesCount).toBe(repoMapResult.filesCount);

      // ═══════════════════════════════════════════════════════════════════════
      // PROOF STEP 3: Surgical AST Code Replacement (TypeScript & Python)
      // ═══════════════════════════════════════════════════════════════════════
      // Mutate TypeScript method `calculateDiscount`
      const tsMutateRes = await replaceSymbolInFile(
        {
          file: orderServiceTs,
          symbol: 'calculateDiscount',
          newBody: 'return order.total * (1 - rate);',
          target: 'body',
        },
        tempDir,
      );

      expect(tsMutateRes.symbol).toBe('calculateDiscount');
      const updatedTsContent = await fs.readFile(orderServiceTs, 'utf8');
      expect(updatedTsContent).toContain('return order.total * (1 - rate);');
      expect(updatedTsContent).toContain(
        'public calculateDiscount(order: Order, rate: number): number {',
      );
      expect(updatedTsContent).toContain('export interface Order'); // rest of file intact
      expect(updatedTsContent).toContain('public async initialize()'); // sibling method intact

      // Mutate Python method `process_batch`
      const pyMutateRes = await replaceSymbolInFile(
        {
          file: pyService,
          symbol: 'process_batch',
          newBody: 'return [x * 100 for x in batch if x > 0]',
          target: 'body',
        },
        tempDir,
      );

      expect(pyMutateRes.symbol).toBe('process_batch');
      const updatedPyContent = await fs.readFile(pyService, 'utf8');
      expect(updatedPyContent).toContain('return [x * 100 for x in batch if x > 0]');
      expect(updatedPyContent).toContain('class DataPipeline:');
      expect(updatedPyContent).toContain('def __init__(self, name: str):');

      // Tool execution check on codebaseAstReplaceTool
      const astReplaceToolOut = await codebaseAstReplaceTool.execute(
        {
          file: orderServiceTs,
          symbol: 'initialize',
          newBody: 'console.log("Superfast cache ready");',
        },
        { projectRoot: tempDir } as never,
        { signal: new AbortController().signal },
      );

      expect(astReplaceToolOut.status).toBe('ok');
      const finalTs = await fs.readFile(orderServiceTs, 'utf8');
      expect(finalTs).toContain('Superfast cache ready');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
