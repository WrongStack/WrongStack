import { createEvidenceAnalyzerPlugin } from '../evidence-analyzer/index.js';
import { collectWorkspaceHealth } from './project.js';

export default createEvidenceAnalyzerPlugin({
  name: 'workspace-health',
  toolName: 'workspace_health_analyze',
  description:
    'Checks the workspace manifests (or supplied output) for broken package-manager, Node engine, script and workspace-link contracts',
  evidenceHint:
    'Inspect package.json, tool output, or workspace configuration for health-contract failures.',
  rules: [
    {
      label: 'unsupported runtime',
      severity: 'error',
      pattern: /(?:ERR_PNPM_UNSUPPORTED_ENGINE|engine[^\n]*(?:not compatible|unsupported))/i,
      advice: 'Align the declared engine with the active runtime before retrying.',
    },
    {
      label: 'missing script',
      severity: 'warning',
      pattern: /missing script:|ERR_PNPM_NO_SCRIPT/i,
      advice: 'Use an existing script or add the intended command to package.json.',
    },
    {
      label: 'workspace resolution failure',
      severity: 'error',
      pattern: /workspace package .* not found|ERR_PNPM_WORKSPACE_PKG_NOT_FOUND/i,
      advice: 'Verify workspace globs and workspace dependency names.',
    },
  ],
  project: {
    description:
      'reads the root and workspace package.json files to find lockfile/packageManager mismatches, unmet engines.node, `run` references to undefined scripts, empty workspace globs and unresolved workspace: dependencies.',
    collect: collectWorkspaceHealth,
  },
});
