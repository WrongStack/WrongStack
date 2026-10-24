import type { TaskNode } from '@wrongstack/contracts/types';

export function buildTaskPrompt(task: TaskNode, phaseName: string, goal: string): string {
  return [
    `You are executing one task inside an autonomous, phase-based build.`,
    `Overall goal: ${goal}`,
    `Current phase: ${phaseName}`,
    '',
    `TASK: ${task.title}`,
    task.description ? `Details: ${task.description}` : '',
    `Type: ${task.type} · Priority: ${task.priority}`,
    '',
    `Do the work now using your tools (read, edit, write, bash, …). Make the`,
    `change real — do not just describe it. When finished, end with a one-line`,
    `summary of what you changed. If the task is impossible or already done,`,
    `say so explicitly.`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildRepairPrompt(phaseName: string, failure: string, goal: string): string {
  return [
    `You are repairing a FAILED verification inside an autonomous, phase-based build.`,
    `Overall goal: ${goal}`,
    `Phase: ${phaseName}`,
    '',
    `The phase's code changes were applied, but verification (typecheck/lint)`,
    `failed in this working directory. Verifier output:`,
    '```',
    failure.slice(0, 4000),
    '```',
    '',
    `Fix the code in THIS working directory so verification passes. Use your tools`,
    `(read, edit, write, bash). Fix the root cause — do NOT delete code, weaken`,
    `types, or disable lint rules just to silence the error. When finished, end`,
    `with a one-line summary of what you changed.`,
  ].join('\n');
}

export function buildConflictPrompt(files: string[], goal: string): string {
  const fileList = files.length
    ? files.map((f) => `  - ${f}`).join('\n')
    : '  (run `git diff --check` or search for "<<<<<<<" to find them)';
  return [
    `A git squash-merge hit conflicts while integrating an autonomous build phase`,
    `into the base branch. Overall goal: ${goal}`,
    '',
    `These files contain conflict markers (<<<<<<<, =======, >>>>>>>) in the`,
    `current working directory:`,
    fileList,
    '',
    `Resolve every conflict by correctly combining BOTH sides — keep the intent of`,
    `the base branch AND the phase's changes; do not blindly discard either side.`,
    `Remove all conflict markers from every affected file. Do NOT run \`git commit\``,
    `or \`git add\` — just leave the resolved files on disk. If a conflict cannot be`,
    `resolved safely, say so explicitly. End with a one-line summary.`,
  ].join('\n');
}
