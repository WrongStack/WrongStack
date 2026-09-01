import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeSecurityAndPerformance, securityAstScanTool } from '../src/index.js';

describe('security-ast-scan tool & analyzer', () => {
  it('detects N+1 database queries inside loops', () => {
    const badCode = `
export async function getOrders(userIds: string[]) {
  const result = [];
  for (const id of userIds) {
    const userOrders = await db.query(\`SELECT * FROM orders WHERE user_id = \${id}\`);
    result.push(userOrders);
  }
  return result;
}
`;
    const findings = analyzeSecurityAndPerformance('src/orders.ts', badCode);
    const nPlusOne = findings.find((f) => f.ruleId === 'perf/n-plus-one-query');
    expect(nPlusOne).toBeDefined();
    expect(nPlusOne?.severity).toBe('critical');
    expect(nPlusOne?.recommendation).toContain('IN (...)');
  });

  it('detects SQL Injection and string concatenation in queries', () => {
    const badCode = `
export async function getUser(username: string) {
  const query = "SELECT * FROM users WHERE name = '" + username + "'";
  return db.query(query);
}
`;
    const findings = analyzeSecurityAndPerformance('src/user.ts', badCode);
    const sqlInj = findings.find((f) => f.ruleId === 'sec/sql-injection');
    expect(sqlInj).toBeDefined();
    expect(sqlInj?.severity).toBe('critical');
  });

  it('detects hardcoded AWS and GitHub secret tokens', () => {
    const badCode = `
const awsKey = "AKIA1234567890ABCDEF";
const githubToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
`;
    const findings = analyzeSecurityAndPerformance('src/config.ts', badCode);
    const secrets = findings.filter((f) => f.ruleId === 'sec/hardcoded-secret');
    expect(secrets.length).toBeGreaterThanOrEqual(2);
  });

  it('detects Prototype Pollution vulnerabilities', () => {
    const badCode = `
export function mergeConfig(target: any, source: any) {
  target["__proto__"] = source;
  return target;
}
`;
    const findings = analyzeSecurityAndPerformance('src/util.ts', badCode);
    const proto = findings.find((f) => f.ruleId === 'sec/prototype-pollution');
    expect(proto).toBeDefined();
    expect(proto?.severity).toBe('warning');
  });

  it('detects ReDoS catastrophic backtracking regular expressions', () => {
    const badCode = `
const emailRegex = /^([a-zA-Z0-9_]+)+@domain.com$/;
`;
    const findings = analyzeSecurityAndPerformance('src/validator.ts', badCode);
    const redos = findings.find((f) => f.ruleId === 'sec/redos-vulnerable-regex');
    expect(redos).toBeDefined();
    expect(redos?.recommendation).toContain('nested repetitions');
  });

  it('executes securityAstScanTool on clean and dirty files', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-scan-'));
    const cleanFile = path.join(tempDir, 'clean.ts');
    const dirtyFile = path.join(tempDir, 'dirty.ts');

    await fs.writeFile(
      cleanFile,
      'export function sum(a: number, b: number) { return a + b; }',
      'utf8',
    );

    await fs.writeFile(
      dirtyFile,
      'export function unsafe(input: string) { eval(`console.log("${input}")`); }',
      'utf8',
    );

    try {
      // H-6: the tool now resolves through safeResolveReal like every sibling
      // file tool — relative paths resolve against ctx.workingDir ?? ctx.cwd
      // (the runtime ctx always carries cwd), then containment is checked
      // against projectRoot. A ctx with only projectRoot no longer works for
      // relative paths; pass the temp dir as cwd as the runtime would.
      // Clean scan
      const cleanRes = await securityAstScanTool.execute(
        { file: 'clean.ts' },
        { projectRoot: tempDir, cwd: tempDir } as never,
        { signal: new AbortController().signal },
      );
      expect(cleanRes.status).toBe('clean');
      expect(cleanRes.totalFindings).toBe(0);

      // Dirty scan
      const dirtyRes = await securityAstScanTool.execute(
        { file: 'dirty.ts' },
        { projectRoot: tempDir, cwd: tempDir } as never,
        { signal: new AbortController().signal },
      );
      expect(dirtyRes.status).toBe('findings_detected');
      expect(dirtyRes.criticalCount).toBeGreaterThanOrEqual(1);
      expect(dirtyRes.findings.some((f) => f.ruleId === 'sec/unsafe-dynamic-exec')).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
