import type { Plugin } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import dependencyDriftDetector from '../src/dependency-drift-detector/index.js';
import { analyzeEvidence } from '../src/evidence-analyzer/index.js';
import lockfileConsistencyGuard from '../src/lockfile-consistency-guard/index.js';

type Finding = { rule: string; line: number; excerpt: string };

async function analyze(plugin: Plugin, toolName: string, content: string): Promise<Finding[]> {
  const register = vi.fn();
  const api = {
    tools: { register },
    config: { extensions: { [plugin.name]: { enabled: true } } },
    log: { info: vi.fn(), warn: vi.fn() },
  };
  await plugin.setup(api as never);
  try {
    const tool = register.mock.calls.find(([value]) => value.name === toolName)?.[0];
    const result = (await tool.execute({ content }, { projectRoot: process.cwd() })) as {
      findings: Finding[];
    };
    return result.findings;
  } finally {
    await plugin.teardown?.(api as never);
  }
}

// F1115: these rules are written with `[\s\S]` to span lines, but the
// analyzer matched one line at a time, so they only ever fired on minified,
// single-line evidence — never on a pretty-printed manifest or a file list.
describe('evidence analyzer rules that span lines', () => {
  it('flags an unbounded range in a pretty-printed package.json', async () => {
    const manifest = JSON.stringify({ name: 'x', dependencies: { 'left-pad': '*' } }, null, 2);
    const findings = await analyze(dependencyDriftDetector, 'dependency_drift_analyze', manifest);
    expect(findings.filter((f) => f.rule === 'unbounded dependency range')).toEqual([
      expect.objectContaining({ line: 3, excerpt: '"dependencies": {' }),
    ]);
  });

  it('flags two lockfiles listed on separate lines', async () => {
    const findings = await analyze(
      lockfileConsistencyGuard,
      'lockfile_consistency_analyze',
      'README.md\npackage-lock.json\npnpm-lock.yaml\n',
    );
    expect(findings.filter((f) => f.rule === 'multiple lockfiles')).toEqual([
      expect.objectContaining({ line: 2, excerpt: 'package-lock.json' }),
    ]);
  });

  it('keeps single-line rules line-scoped and line numbers exact', () => {
    const profile = {
      name: 'probe',
      toolName: 'probe',
      description: '',
      evidenceHint: '',
      rules: [
        { label: 'line', severity: 'info' as const, pattern: /a.*b/, advice: '' },
        { label: 'span', severity: 'info' as const, pattern: /a[\s\S]{0,4}b/, advice: '' },
      ],
    };
    const { findings } = analyzeEvidence('x\na\nb\n', profile, 10);
    expect(findings.map((f) => `${f.rule}@${f.line}`)).toEqual(['span@2']);
  });

  it('still bounds a spanning rule on a large adversarial input', () => {
    const content = 'package-lock.json\n'.repeat(40_000);
    const started = Date.now();
    const result = analyzeEvidence(
      content,
      {
        name: 'probe',
        toolName: 'probe',
        description: '',
        evidenceHint: '',
        rules: [
          {
            label: 'multiple lockfiles',
            severity: 'warning',
            pattern: /package-lock\.json[\s\S]*pnpm-lock\.yaml/i,
            advice: '',
          },
        ],
      },
      10,
    );
    expect(result.findings).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
