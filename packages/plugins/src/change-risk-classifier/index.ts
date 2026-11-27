import { keepNonTestChanges } from '../evidence-analyzer/diff.js';
import { createEvidenceAnalyzerPlugin } from '../evidence-analyzer/index.js';
import { collectChangeRisk } from './project.js';
import { CHANGE_RISK_RULES } from './rules.js';

export default createEvidenceAnalyzerPlugin({
  name: 'change-risk-classifier',
  toolName: 'change_risk_analyze',
  description:
    'Classifies the working-tree change (or a supplied diff) into authentication, persistence, destructive-operation, CI, infrastructure and dependency risk signals per file',
  evidenceHint:
    'Classify a change by the risks that merit targeted proof before it ships (auth, persistence, destructive operations, CI, infrastructure, dependencies).',
  rules: CHANGE_RISK_RULES,
  preprocess: keepNonTestChanges,
  project: {
    description:
      'reads `git diff HEAD` plus untracked files and classifies each changed file by path and by its changed (non-test) lines.',
    collect: collectChangeRisk,
  },
});
