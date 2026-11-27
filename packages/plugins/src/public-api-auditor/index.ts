import { createEvidenceAnalyzerPlugin } from '../evidence-analyzer/index.js';
import { collectPublicApi, undocumentedExports } from './project.js';

export default createEvidenceAnalyzerPlugin({
  name: 'public-api-auditor',
  toolName: 'public_api_analyze',
  description:
    'Audits package entry points for undocumented exports, missing export-map targets, deprecated contracts and accidental internal API exposure',
  evidenceHint:
    'Audit a public entry point (or every package entry point) for documentation and compatibility signals.',
  // Only declarations with no /** */ comment above them; the old line rule
  // flagged every export, documented or not.
  inspect: undocumentedExports,
  rules: [
    {
      label: 'deprecated public contract',
      severity: 'info',
      pattern: /@deprecated\b/i,
      advice: 'Ensure the replacement path and removal timeline are documented.',
    },
    {
      label: 'internal path exported',
      severity: 'warning',
      pattern: /export .*['"][^'"]*(?:\/internal\/|\/src\/)[^'"]*['"]/i,
      advice: 'Expose a stable facade instead of leaking internal module paths.',
    },
  ],
  project: {
    description:
      'resolves entry points from every non-private package.json (exports/main/types, dist mapped to src), reports export-map targets that do not exist, undocumented exported declarations and internal paths re-exported.',
    collect: collectPublicApi,
  },
});
