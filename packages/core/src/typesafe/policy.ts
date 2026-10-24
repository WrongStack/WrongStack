import type { Config } from '@wrongstack/contracts/types/config/root';
import type { TypeSafeJudgmentsConfig } from '@wrongstack/contracts/types/config/typesafe';

// Clients can outlive the immutable snapshot from which they were built.
// Keep their permission tied to the owning store, rather than the old flag.
interface Policy {
  current: Pick<Config, 'typesafe'>;
  controller: AbortController;
}
const policies = new WeakMap<object, Policy>();

export function createTypeSafePolicy(initial: Pick<Config, 'typesafe'>) {
  const policy: Policy = { current: initial, controller: new AbortController() };
  return (config: Pick<Config, 'typesafe'>) => {
    if (config.typesafe?.enabled !== true) policy.controller.abort();
    else if (policy.controller.signal.aborted) policy.controller = new AbortController();
    policy.current = config;
    policies.set(config, policy);
  };
}

export function typeSafePolicySignal(config: Pick<Config, 'typesafe'>): AbortSignal | undefined {
  return policies.get(config)?.controller.signal;
}

export function typeSafePolicyScope(config: Pick<Config, 'typesafe'>): object | undefined {
  return policies.get(config);
}

export function typeSafeAllowed(config: Pick<Config, 'typesafe'>, feature?: string): boolean {
  const current = policies.get(config)?.current ?? config;
  if (current.typesafe?.enabled !== true) return false;
  return (
    !feature || current.typesafe.judgments?.[feature as keyof TypeSafeJudgmentsConfig] !== false
  );
}
