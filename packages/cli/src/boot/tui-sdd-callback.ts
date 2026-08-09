/**
 * TUI SDD callbacks — extracted from the runTui() options literal.
 *
 * Phase C step 5. getSDDContext returns the active spec-driven-development
 * context; onSDDOutput parses assistant output for spec/plan/task artifacts,
 * auto-saves them, and returns status messages for the TUI to display.
 *
 * No closure dependencies — both functions delegate to the shared SDD
 * runtime service.
 */

/**
 * Get the active SDD context for the current session.
 */
export async function getSDDContext(): Promise<unknown> {
  const { getActiveSDDContext } = await import('../services/sdd-runtime.js');
  return getActiveSDDContext();
}

/**
 * Parse assistant output for SDD artifacts (spec, plan, tasks), auto-save
 * them, and return status messages for the TUI.
 */
export async function onSDDOutput(output: string): Promise<string[]> {
  const {
    trySaveSpecFromAIOutput,
    trySaveImplementationPlan,
    trySaveTasksFromAIOutput,
    autoDetectTaskCompletion,
    getTaskProgress,
    getActiveSDDPhase,
  } = await import('../services/sdd-runtime.js');
  const messages: string[] = [];
  const specSaved = await trySaveSpecFromAIOutput(output);
  if (specSaved) messages.push('✓ Spec detected and saved! Use /sdd approve to continue.');
  const planSaved = trySaveImplementationPlan(output);
  if (planSaved) messages.push('✓ Implementation plan saved!');
  const tasksSaved = await trySaveTasksFromAIOutput(output);
  if (tasksSaved) {
    const progress = getTaskProgress();
    const count = progress?.total ?? 0;
    messages.push(`✓ ${count} tasks detected and saved! Use /sdd approve to execute.`);
  }
  const sddPhase = getActiveSDDPhase();
  if (sddPhase === 'executing') {
    const autoCompleted = autoDetectTaskCompletion(output);
    if (autoCompleted > 0) {
      const progress = getTaskProgress();
      if (progress) {
        messages.push(
          `✓ ${autoCompleted} task(s) auto-completed! Progress: ${progress.completed}/${progress.total} (${progress.percentComplete}%)`,
        );
      }
    }
  }
  return messages;
}
