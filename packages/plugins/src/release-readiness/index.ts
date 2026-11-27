import { createEvidenceAnalyzerPlugin } from '../evidence-analyzer/index.js';
import { collectReleaseReadiness } from './project.js';

export default createEvidenceAnalyzerPlugin({
  name: 'release-readiness',
  toolName: 'release_readiness_analyze',
  description:
    'Checks release readiness of the working tree (dirty tree, version alignment, changelog entry, already-tagged version, upstream drift) or of supplied release-gate output',
  evidenceHint:
    'Inspect release-gate output, a changelog, or a version manifest for blocking readiness evidence.',
  rules: [
    {
      label: 'release gate failure',
      severity: 'error',
      pattern: /(?:release:check|release gate|prepublish).*(?:failed|error)|\bFAILED\b/i,
      advice: 'Resolve the authoritative failing gate and rerun it before publishing.',
    },
    {
      label: 'dirty worktree',
      severity: 'warning',
      // `\bM\s+\S+` matched any capital M followed by a word ("M apps" but also
      // "Make sure"); only porcelain status lines with a path-like target count.
      pattern:
        /(?:working tree|worktree).*(?:dirty|modified)|^\s?(?:\?\?|[MADRCU][MADRCU ]?)\s+\S*[/.]\S*\s*$/im,
      advice:
        'Explicitly review the pending files before deciding whether they belong in the release.',
    },
    {
      label: 'version mismatch',
      severity: 'error',
      pattern: /(?:version).*(?:mismatch|does not match|out of sync)/i,
      advice: 'Align release manifests and public metadata from the canonical version source.',
    },
  ],
  project: {
    description:
      'reads git status, workspace package versions (lockstep vs independent), CHANGELOG.md heading for the version, whether that version is already tagged with commits after it, and upstream ahead/behind.',
    collect: collectReleaseReadiness,
  },
});
