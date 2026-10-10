const subprocessIntegrationFiles = [
  'packages/webui-server/tests/git-handlers.test.ts',
  'packages/tui/tests/git-info.test.ts',
  'packages/tools/tests/project-server-idle.test.ts',
];

/** Preserve Vitest's order while keeping short subprocess deadlines out of the initial load. */
export function deferSubprocessIntegration<T extends { moduleId: string }>(
  files: readonly T[],
): T[] {
  const regular: T[] = [];
  const subprocess: T[] = [];
  for (const file of files) {
    const moduleId = file.moduleId.replaceAll('\\', '/');
    const group = subprocessIntegrationFiles.some(
      (suffix) => moduleId.endsWith(`/${suffix}`) || moduleId === suffix,
    )
      ? subprocess
      : regular;
    group.push(file);
  }
  return [...regular, ...subprocess];
}
