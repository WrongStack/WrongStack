/**
 * metric plugin — verifies a task's goal metrics against their targets.
 * This is always deterministic: compares current vs target for each metric.
 * Produces evidence: { metrics: [{ name, target, current, met }], allMet }.
 */
import type { KanbanCheck, KanbanVerificationCheckResult } from '../../types.js';
import type { VerificationContext } from '../verification-context.js';
import type { VerifierPlugin } from '../verifier-plugin.js';

export class MetricPlugin implements VerifierPlugin {
  readonly id = 'metric';
  readonly kind = 'deterministic' as const;

  canHandle(checkType: string): boolean {
    return checkType === 'metric';
  }

  async verify(
    check: KanbanCheck,
    context: VerificationContext,
  ): Promise<KanbanVerificationCheckResult> {
    const metrics = context.task.goalMetrics ?? [];
    if (metrics.length === 0) {
      return {
        checkId: check.id,
        description: check.description,
        type: check.type,
        status: 'skipped',
        evidence: {},
        error: 'Task has no goal metrics to verify.',
      };
    }

    const results = metrics.map((m) => {
      if (m.target === undefined || m.current === undefined) {
        return { ...m, met: false, reason: 'Target or current value not set.' };
      }
      // Blank strings are "not set" in string form: Number('') is 0, and
      // treating it as a real target would mark at_least metrics met with a
      // target of zero. Non-numeric strings ('95%') coerce to NaN, which
      // would fail silently with null-masked evidence. Both surface a reason,
      // mirroring the undefined branch above.
      const rawTarget = typeof m.target === 'string' ? m.target.trim() : m.target;
      const rawCurrent = typeof m.current === 'string' ? m.current.trim() : m.current;
      if (rawTarget === '' || rawCurrent === '') {
        return {
          ...m,
          met: false,
          reason: 'Target or current value is blank; set a numeric value.',
        };
      }
      const target = typeof rawTarget === 'number' ? rawTarget : Number(rawTarget);
      const current = typeof rawCurrent === 'number' ? rawCurrent : Number(rawCurrent);
      // direction: 'at_least' (default) means met when current >= target;
      // 'at_most' means met when current <= target (error rate, cost ceiling,
      // latency, open-bug count — anything where lower is better).
      const direction = m.direction ?? 'at_least';
      const numeric = !Number.isNaN(target) && !Number.isNaN(current);
      if (!numeric) {
        return {
          ...m,
          met: false,
          reason: `Target and current must be numbers or numeric strings; got target ${JSON.stringify(m.target)} and current ${JSON.stringify(m.current)}.`,
        };
      }
      const met = direction === 'at_most' ? current <= target : current >= target;
      return { ...m, target, current, direction, met };
    });

    const allMet = results.every((r) => r.met);
    return {
      checkId: check.id,
      description: check.description,
      type: check.type,
      status: allMet ? 'passed' : 'failed',
      evidence: {
        metrics: results.map((r) => ({
          name: r.name,
          target: r.target,
          current: r.current,
          direction: r.direction,
          unit: r.unit,
          met: r.met,
          reason: 'reason' in r ? (r as { reason: string }).reason : undefined,
        })),
        allMet,
        total: results.length,
        met: results.filter((r) => r.met).length,
        missed: results.filter((r) => !r.met).length,
      },
      error: allMet ? undefined : `${results.filter((r) => !r.met).length} metric(s) not met.`,
    };
  }
}
