/**
 * How far an ACP agent's own operating mode lets it act without asking. Kept as an explicit list
 * per agent family: a mode name means different things to different agents ("auto" is Claude
 * Code's classifier approvals but Codex's default), and a safety tint that guesses is worse than
 * none. Modes not listed get no tint.
 */
export type AcpModeRisk = 'danger' | 'caution';

const RISKS: ReadonlyArray<{
  agents: ReadonlySet<string>;
  modes: Readonly<Record<string, AcpModeRisk>>;
}> = [
  {
    // Claude Code: bypassPermissions runs every tool without a prompt.
    agents: new Set(['claude-code', 'claude-acp']),
    modes: { bypassPermissions: 'danger', acceptEdits: 'caution', auto: 'caution' },
  },
  {
    // Codex ACP: full access drops the sandbox and the approval prompts. Newer adapters name it
    // `agent-full-access` (their `agent` is workspace-write with approval on request), older
    // ones `full-access`.
    agents: new Set(['codex-acp', 'codex-cli']),
    modes: { 'agent-full-access': 'danger', 'full-access': 'danger' },
  },
];

export function acpModeRisk(agentId: string, value: string): AcpModeRisk | undefined {
  const family = RISKS.find((entry) => entry.agents.has(agentId));
  return family && Object.hasOwn(family.modes, value) ? family.modes[value] : undefined;
}
