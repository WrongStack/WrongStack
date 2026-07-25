const BOOTSTRAP_KEYS = new Set(['version', 'activeProfile']);

export function isBootstrapOnly(config: Record<string, unknown>): boolean {
  return Object.keys(config).every((k) => BOOTSTRAP_KEYS.has(k));
}
