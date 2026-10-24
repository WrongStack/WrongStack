import type { SkillLoader } from '@wrongstack/contracts/types/skill';
import { skillPromptExclusionReasons } from '../skills/prompt-discovery.js';

/** Explain progressive prompt eligibility; body/tool activation is still checked on load. */
export async function skillDiscoveryReport(loader: SkillLoader, toolNames?: readonly string[]) {
  const skills = await loader.list();
  const entries = skills.map((skill) => {
    const reasons = skillPromptExclusionReasons(skill, toolNames);
    return {
      name: skill.name,
      source: skill.source,
      originTool: skill.originTool,
      path: skill.path,
      status: reasons.length > 0 ? 'excluded' : toolNames === undefined ? 'unchecked' : 'eligible',
      reasons,
    };
  });
  const diagnostics = loader.diagnostics?.();
  const report = {
    runtimeChecked: toolNames !== undefined,
    entries,
    skipped: diagnostics?.skipped ?? [],
    shadowed: diagnostics?.shadowed ?? [],
    loaderDiagnosticsAvailable: diagnostics !== undefined,
  };
  const lines = [
    `Skill discovery: ${entries.length} selected, ${report.shadowed.length} shadowed, ${report.skipped.length} rejected.`,
    toolNames === undefined
      ? 'Runtime tools unavailable here; eligibility is unchecked.'
      : `Progressive prompt eligibility checked against ${new Set(toolNames).size} host tools (including on-demand tools).`,
  ];
  for (const entry of entries) {
    lines.push(
      `${entry.name} [${entry.source}${entry.originTool ? `/${entry.originTool}` : ''}] — ${entry.status}${entry.reasons.length ? `: ${entry.reasons.join('; ')}` : ''}`,
    );
    lines.push(`  ${entry.path}`);
  }
  for (const shadow of report.shadowed) {
    lines.push(`${shadow.name} [${shadow.source}] — shadowed by ${shadow.shadowedBy}`);
    lines.push(`  ${shadow.path} → ${shadow.shadowedByPath ?? '(winner path unavailable)'}`);
  }
  for (const skipped of report.skipped) {
    lines.push(`${skipped.entry} — rejected: ${skipped.reason}`);
    lines.push(`  ${skipped.dir}`);
  }
  if (!report.loaderDiagnosticsAvailable)
    lines.push('Loader rejection/shadow diagnostics unavailable.');
  return { message: lines.join('\n'), metadata: { skillDiscovery: report } };
}
