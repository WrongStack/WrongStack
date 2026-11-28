import { describe, expect, it } from 'vitest';
import { acpModeRisk } from '../src/ui/acp-mode-risk';

describe('acpModeRisk', () => {
  it('marks the modes that skip an agent family own prompts, and only for that family', () => {
    expect(acpModeRisk('claude-code', 'bypassPermissions')).toBe('danger');
    expect(acpModeRisk('claude-acp', 'acceptEdits')).toBe('caution');
    expect(acpModeRisk('codex-acp', 'agent-full-access')).toBe('danger');
    expect(acpModeRisk('codex-acp', 'full-access')).toBe('danger');
    expect(acpModeRisk('codex-acp', 'agent')).toBeUndefined();
    // "auto" is Claude Code's classifier approvals but Codex's default: no tint for Codex.
    expect(acpModeRisk('claude-code', 'auto')).toBe('caution');
    expect(acpModeRisk('codex-acp', 'auto')).toBeUndefined();
  });

  it('leaves unknown agents and modes untinted', () => {
    expect(acpModeRisk('gemini-cli', 'bypassPermissions')).toBeUndefined();
    expect(acpModeRisk('claude-code', 'plan')).toBeUndefined();
    expect(acpModeRisk('claude-code', 'constructor')).toBeUndefined();
  });
});
