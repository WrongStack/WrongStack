export interface AutomationTemplate {
  id: string;
  version: 1;
  name: string;
  prompt: string;
  requirements: readonly string[];
}
export const VERSIONED_AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  {
    id: 'dependency-review',
    version: 1,
    name: 'Dependency review',
    prompt:
      'Review dependency changes. Identify actionable compatibility or security findings, verify them, and prepare a minimal patch with tests. Use the existing project instructions and skills; report the validation boundary.',
    requirements: ['Trusted runtime image', 'Provider credentials', 'Project dependency manifest'],
  },
  {
    id: 'test-triage',
    version: 1,
    name: 'Test triage',
    prompt:
      'Run the relevant tests, reproduce the first concrete failure, fix its cause and rerun the affected tests. Use the existing project instructions and skills. Prepare a patch and report the validation boundary.',
    requirements: ['Trusted runtime image', 'Provider credentials', 'Project test command'],
  },
  {
    id: 'pr-followup',
    version: 1,
    name: 'PR follow-up',
    prompt:
      'Investigate the PR or CI feedback in the event context. Preserve existing work, use the existing project instructions and skills, prepare a narrow patch and verify the change.',
    requirements: [
      'Trusted runtime image',
      'Provider credentials',
      'GitHub repository and signed event setup',
    ],
  },
];
