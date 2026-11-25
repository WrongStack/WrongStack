/**
 * Map our stable, human-friendly catalog ids to the official registry's ids,
 * so a live-synced registry (keyed by registry id) still resolves when the
 * user types our id. Our id is preferred in the UI; the alias is the bridge.
 */
export const REGISTRY_ID_ALIASES: Readonly<Record<string, string>> = {
  'claude-code': 'claude-acp',
  'gemini-cli': 'gemini',
  'codex-cli': 'codex-acp',
  copilot: 'github-copilot-cli',
  'kimi-code': 'kimi-code',
  kimi: 'kimi',
  'kiro-cli': 'kiro',
  'pi-acp': 'pi-acp',
  cline: 'cline',
  goose: 'goose',
  opencode: 'opencode',
  cursor: 'cursor',
  'qwen-code': 'qwen-code',
  'mistral-vibe': 'mistral-vibe',
  'antigravity-acp': 'antigravity-acp',
  'amp-acp': 'amp-acp',
  auggie: 'auggie',
  devin: 'devin',
  'factory-droid': 'factory-droid',
  'grok-build': 'grok-build',
  junie: 'junie',
  kilo: 'kilo',
};

const CANONICAL_AGENT_IDS = new Map([
  ...Object.entries(REGISTRY_ID_ALIASES).map(([id, registryId]) => [registryId, id] as const),
  ['opencode-v2', 'opencode'],
  ['opencode2', 'opencode'],
  ['antigravity', 'antigravity-acp'],
  ['pi', 'pi-acp'],
]);

export function canonicalAcpAgentId(id: string): string {
  return CANONICAL_AGENT_IDS.get(id) ?? id;
}
