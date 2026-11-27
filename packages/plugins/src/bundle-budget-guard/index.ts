import { createEvidenceAnalyzerPlugin } from '../evidence-analyzer/index.js';
import { collectBundleBudget } from './project.js';

export default createEvidenceAnalyzerPlugin({
  name: 'bundle-budget-guard',
  toolName: 'bundle_budget_analyze',
  description:
    'Measures browser build output on disk (or a supplied bundle report) against size budgets and flags published source maps',
  evidenceHint:
    'Inspect a bundle report or build output for size-budget and artifact exposure evidence.',
  rules: [
    {
      label: 'bundle budget exceeded',
      severity: 'error',
      pattern: /(?:bundle|asset|chunk).*(?:budget|limit).*(?:exceeded|over)/i,
      advice: 'Identify the changed dependency or import path and reduce or split the payload.',
    },
    {
      label: 'large JavaScript asset',
      severity: 'warning',
      pattern: /\b(?:[5-9]\d{2}|[1-9]\d{3,})\s*(?:kB|KB)\b.*\.js\b/i,
      advice: 'Review whether the asset can be code-split or its dependency reduced.',
    },
    {
      label: 'published source map',
      severity: 'info',
      pattern: /\.map\b.*(?:emit|upload|publish)|sourcemap.*(?:upload|public)/i,
      advice: 'Confirm sourcemap access matches the intended observability and disclosure policy.',
    },
  ],
  options: {
    maxAssetKb: {
      type: 'number',
      minimum: 1,
      default: 500,
      description: 'JS asset budget in kB (project mode).',
    },
    maxCssKb: {
      type: 'number',
      minimum: 1,
      default: 150,
      description: 'CSS asset budget in kB (project mode).',
    },
    includeServerOutput: {
      type: 'boolean',
      default: false,
      description: 'Also budget library/server output (dist without index.html or assets/).',
    },
  },
  project: {
    description:
      'measures browser build output already on disk (dist/build/out with index.html or assets/, .next/static) against maxAssetKb/maxCssKb budgets and lists source maps; nothing is built.',
    collect: collectBundleBudget,
  },
});
