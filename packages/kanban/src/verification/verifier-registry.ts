/**
 * VerifierRegistry — a registry of VerifierPlugin instances.
 *
 * Plugins are registered by id. The registry resolves a check to the first
 * plugin whose `canHandle()` returns true, then delegates execution.
 *
 * Built-in deterministic plugins are registered automatically. Escalation
 * plugins (agent, council) are registered only when explicitly configured.
 */
import type { KanbanCheck, KanbanVerificationCheckResult } from '../types.js';
import { DEFAULT_EVIDENCE_RULES, EvidenceValidator } from './evidence-validator.js';
import type { VerificationContext } from './verification-context.js';
import type { VerifierPlugin } from './verifier-plugin.js';

export class VerifierRegistry {
  /** Registered plugins keyed by id. */
  private readonly plugins = new Map<string, VerifierPlugin>();
  /** Ordered resolution list — first match wins. */
  private readonly resolutionOrder: string[] = [];

  /** Register a plugin. Overwrites an existing registration with the same id. */
  register(plugin: VerifierPlugin): this {
    this.plugins.set(plugin.id, plugin);
    if (!this.resolutionOrder.includes(plugin.id)) {
      this.resolutionOrder.push(plugin.id);
    }
    return this;
  }

  /** Unregister a plugin by id. */
  unregister(id: string): boolean {
    const removed = this.plugins.delete(id);
    const idx = this.resolutionOrder.indexOf(id);
    if (idx >= 0) this.resolutionOrder.splice(idx, 1);
    return removed;
  }

  /** Look up a plugin by id. */
  get(id: string): VerifierPlugin | undefined {
    return this.plugins.get(id);
  }

  /** List all registered plugin ids. */
  list(): string[] {
    return [...this.resolutionOrder];
  }

  /**
   * Resolve a check to its best-fit plugin and execute verification.
   *
   * 1. If `check.escalation` is set, resolve its named plugin directly.
   * 2. Otherwise find the first plugin where `canHandle(check.type)` returns true.
   * 3. If no plugin found → return a 'skipped' result with an explanation.
   * 4. Run the plugin's `verify()`.
   * 5. For escalation plugins, run EvidenceValidator to enforce concrete proof.
   * 6. Return the check result.
   */
  async verify(
    check: KanbanCheck,
    context: VerificationContext,
  ): Promise<KanbanVerificationCheckResult> {
    // Escalation mode overrides the normal type-based resolution.
    const effectiveType =
      check.escalation === 'agent'
        ? 'agent'
        : check.escalation === 'council'
          ? 'council'
          : check.type;

    const plugin = this.resolve(effectiveType);
    if (!plugin) {
      // Checks without a plugin (manual/review/...) carry a human-set status
      // that the verifier must respect, not overwrite: an explicitly passed or
      // failed manual check flows through as-is; anything unresolved is
      // 'skipped' so the report stays honest about what was actually verified.
      const passThrough =
        check.status === 'passed'
          ? ('passed' as const)
          : check.status === 'failed'
            ? ('failed' as const)
            : ('skipped' as const);
      return {
        checkId: check.id,
        description: check.description,
        type: check.type,
        status: passThrough,
        evidence:
          passThrough === 'skipped'
            ? {}
            : {
                manual: true,
                ...(check.checkedBy !== undefined ? { checkedBy: check.checkedBy } : {}),
                ...(check.checkedAt !== undefined ? { checkedAt: check.checkedAt } : {}),
              },
        ...(passThrough === 'skipped'
          ? { error: `No verifier plugin registered for check type "${check.type}".` }
          : {}),
      };
    }

    const result = await plugin.verify(check, context);

    // Escalation plugins must produce concrete evidence.
    if (plugin.kind === 'escalation') {
      const ev = new EvidenceValidator(DEFAULT_EVIDENCE_RULES);
      // When the check has its own escalation mode, use stricter rules.
      if (check.escalation === 'council') {
        ev.setRule('minRefs', 2);
        ev.setRule('rejectBareVerdict', true);
      }
      const validation = ev.validate(result);
      if (!validation.valid) {
        return {
          checkId: check.id,
          description: check.description,
          type: check.type,
          status: 'failed',
          evidence: result.evidence ?? {},
          error: `Agent/council verification rejected: ${validation.reasons.join('; ')}`,
          backingRefs: result.backingRefs ?? [],
        };
      }
    }

    return result;
  }

  /** Find the first plugin that handles the given check type. */
  private resolve(checkType: string): VerifierPlugin | undefined {
    for (const id of this.resolutionOrder) {
      const plugin = this.plugins.get(id);
      if (plugin?.canHandle(checkType)) return plugin;
    }
    return undefined;
  }
}
