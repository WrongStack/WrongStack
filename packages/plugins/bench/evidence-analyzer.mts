import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { PluginAPI, Tool } from '@wrongstack/contracts/types';
import { createEvidenceAnalyzerPlugin } from '../src/evidence-analyzer/index.js';

// Near-limit multiline CI evidence, with findings concentrated at the end.
const content = `${'ordinary build output\n'.repeat(44000)}${'FAIL expected regression\r\n'.repeat(200)}`;
const plugin = createEvidenceAnalyzerPlugin({
  name: 'benchmark',
  toolName: 'benchmark',
  description: 'benchmark',
  evidenceHint: 'benchmark',
  rules: [{ label: 'failure', severity: 'error', pattern: /FAIL/g, advice: 'Inspect failure' }],
});
let tool: Tool;
const api = {
  config: { extensions: { benchmark: { maxFindings: 200 } } },
  tools: {
    register(value: Tool) {
      tool = value;
    },
  },
  log: { info() {} },
} as unknown as PluginAPI;
await plugin.setup(api);
const samples: number[] = [];
try {
  for (let i = 0; i < 4; i++) {
    const started = performance.now();
    const result = (await tool!.execute({ content }, {} as never, {
      signal: new AbortController().signal,
    })) as {
      findings: Array<{ line: number }>;
    };
    const elapsed = performance.now() - started;
    assert.equal(result.findings.length, 200);
    assert.equal(result.findings[0]!.line, 44001);
    assert.equal(result.findings[199]!.line, 44200);
    if (i) samples.push(Number(elapsed.toFixed(3)));
  }
  console.log(
    JSON.stringify({
      runtime: process.version,
      platform: process.platform,
      chars: content.length,
      findings: 200,
      milliseconds: samples,
    }),
  );
} finally {
  await plugin.teardown?.(api);
}
