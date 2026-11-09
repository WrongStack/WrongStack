/** Display identity only: an installed agent is not a claim of tested capabilities. */
const ACP_NAMES: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  'claude-acp': 'Claude Code',
  'codex-cli': 'Codex',
  'codex-acp': 'Codex',
  copilot: 'GitHub Copilot',
  'github-copilot-cli': 'GitHub Copilot',
  kimi: 'Kimi',
  'qwen-code': 'Qwen Code',
  goose: 'Goose',
  'factory-droid': 'Factory Droid',
  'grok-build': 'Grok Build',
  'oh-my-pi': 'Oh My Pi',
  'pi-acp': 'Pi',
  opencode: 'OpenCode',
  'opencode-classic': 'OpenCode Classic',
  'gemini-cli': 'Gemini CLI',
};

export function isAcpProvider(provider?: string, providerType?: string): boolean {
  return provider === 'acp' || providerType === 'acp';
}

export function acpAgentName(model?: string): string {
  const id = model?.startsWith('acp/') ? model.slice(4) : model;
  return id && Object.hasOwn(ACP_NAMES, id) ? ACP_NAMES[id]! : id || 'ACP';
}

/** Human-readable route; retain raw provider/model separately for addressing. */
export function agentRuntimeLabel(provider?: string, model?: string): string | undefined {
  if (isAcpProvider(provider)) return model ? `ACP · ${acpAgentName(model)}` : 'ACP';
  if (!provider) return model || undefined;
  if (!model) return provider;
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}
