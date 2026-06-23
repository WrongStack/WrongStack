/**
 * Static catalog of ACP-supporting agents known to WrongStack.
 *
 * Scope: CLI-spawnable agents only (i.e. agents that can be run as a
 * subprocess with stdio JSON-RPC, per the ACP v1 spec's local-transport
 * model). IDE-only or SaaS-only entries from
 * https://agentclientprotocol.com/get-started/agents are deliberately
 * omitted — they can't be driven by a SubagentRunner.
 *
 * Maintenance
 * ───────────
 * This is a static catalog by design. ACP v1 is a moving target: agents
 * ship ACP support, deprecate it, change invocation flags. Auto-fetching
 * a live registry sounds appealing but adds a runtime dependency on
 * network + on whatever schema the ACP team decides on for the Registry
 * RFD. A typed static file the maintainer refreshes on a known schedule
 * is more reliable, easier to diff in PRs, and keeps probe failures
 * attributable to the local machine rather than to a transient registry
 * outage.
 *
 * Each entry tags its `integration` mechanism:
 *   - `native`       — the agent ships with a documented ACP entry flag.
 *   - `adapter`      — runs through Zed's SDK adapter or similar wrapper.
 *   - `community`    — community-maintained wrapper (e.g. `@agentify/cline`,
 *                      `bub-acp-server`, `pi-acp`).
 *   - `experimental` — listed by ACP but no public ACP entry yet;
 *                      entry may not work.
 *
 * When the maintainer verifies an entry works, flip `integration` from
 * `experimental` to `native`/`adapter`/`community` and remove the warning.
 *
 * Detection
 * ─────────
 * The `EnsembleRegistry` (sibling module) probes each entry's `probe`
 * argv in parallel via `Promise.allSettled`. A probe that exits 0 with
 * a non-empty stdout line is considered installed. Probes that time out
 * or print nothing are treated as not-installed.
 */
import type { ACPAgentDescriptor } from './ensemble-registry.js';

/**
 * The catalog. Order is significant for the TUI render — most-requested
 * agents go first. Edit by re-ordering, not by alphabetising.
 */
export const AGENTS_CATALOG: readonly ACPAgentDescriptor[] = [
  // ── Anthropic ────────────────────────────────────────────────────────
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    vendor: 'anthropic',
    probe: { command: 'claude', args: ['--version'] },
    // Native ACP entry is gated behind the SDK adapter in early releases;
    // see https://agentclientprotocol.com/get-started/agents
    acp: { command: 'claude', args: [] },
    supports: {
      loadSession: true,
      promptImages: true,
      terminal: true,
      fs: true,
    },
    integration: 'adapter',
    docs: 'https://docs.anthropic.com/en/docs/claude-code',
  },

  // ── Google ───────────────────────────────────────────────────────────
  {
    id: 'gemini-cli',
    displayName: 'Gemini CLI',
    vendor: 'google',
    probe: { command: 'gemini', args: ['--version'] },
    acp: { command: 'gemini', args: [] },
    supports: {
      loadSession: true,
      promptImages: true,
      terminal: true,
      fs: true,
    },
    integration: 'native',
    docs: 'https://github.com/google-gemini/gemini-cli',
  },

  // ── OpenAI ───────────────────────────────────────────────────────────
  {
    id: 'codex-cli',
    displayName: 'Codex CLI',
    vendor: 'openai',
    probe: { command: 'codex', args: ['--version'] },
    acp: { command: 'codex', args: [] },
    supports: {
      loadSession: false,
      promptImages: false,
      terminal: true,
      fs: true,
    },
    integration: 'adapter',
    docs: 'https://github.com/openai/codex',
  },

  // ── GitHub ───────────────────────────────────────────────────────────
  {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    vendor: 'github',
    probe: { command: 'gh', args: ['copilot', '--help'] },
    acp: { command: 'gh', args: ['copilot'] },
    supports: {
      loadSession: false,
      promptImages: false,
      terminal: true,
      fs: false,
    },
    integration: 'experimental',
    docs: 'https://github.com/features/copilot/cli',
  },

  // ── Community / wrappers ─────────────────────────────────────────────
  {
    id: 'cline',
    displayName: 'Cline',
    vendor: 'community',
    probe: { command: 'npx', args: ['--version'] },
    acp: {
      command: 'npx',
      args: ['-y', '@agentify/cline'],
    },
    supports: {
      loadSession: true,
      promptImages: true,
      terminal: true,
      fs: true,
    },
    integration: 'community',
    docs: 'https://github.com/cline/cline',
  },
  {
    id: 'goose',
    displayName: 'Goose',
    vendor: 'community',
    probe: { command: 'goose', args: ['--version'] },
    acp: { command: 'goose', args: [] },
    supports: {
      loadSession: true,
      promptImages: true,
      terminal: true,
      fs: true,
    },
    integration: 'experimental',
    docs: 'https://github.com/block/goose',
  },
  {
    id: 'openhands',
    displayName: 'OpenHands',
    vendor: 'community',
    probe: { command: 'openhands', args: ['--version'] },
    acp: { command: 'openhands', args: [] },
    supports: {
      loadSession: false,
      promptImages: true,
      terminal: true,
      fs: true,
    },
    integration: 'experimental',
    // Canonical repo URL — the org renamed; All-Hands-AI/OpenHands 301-redirects here.
    docs: 'https://github.com/OpenHands/OpenHands',
  },

  // ── Vendor CLIs (native binaries) ───────────────────────────────────
  {
    id: 'qwen-code',
    displayName: 'Qwen Code',
    vendor: 'community',
    probe: { command: 'qwen', args: ['--version'] },
    acp: { command: 'qwen', args: [] },
    supports: {
      loadSession: false,
      promptImages: false,
      terminal: true,
      fs: false,
    },
    integration: 'experimental',
    docs: 'https://github.com/QwenLM/Qwen3-Coder',
  },
  {
    id: 'kiro-cli',
    displayName: 'Kiro CLI',
    vendor: 'community',
    probe: { command: 'kiro', args: ['--version'] },
    acp: { command: 'kiro', args: [] },
    supports: {
      loadSession: false,
      promptImages: false,
      terminal: true,
      fs: true,
    },
    integration: 'experimental',
    docs: 'https://kiro.dev',
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    vendor: 'community',
    probe: { command: 'opencode', args: ['--version'] },
    acp: { command: 'opencode', args: [] },
    supports: {
      loadSession: true,
      promptImages: true,
      terminal: true,
      fs: true,
    },
    integration: 'native',
    docs: 'https://github.com/sst/opencode',
  },
  {
    id: 'mistral-vibe',
    displayName: 'Mistral Vibe',
    vendor: 'community',
    probe: { command: 'vibe', args: ['--version'] },
    acp: { command: 'vibe', args: [] },
    supports: {
      loadSession: false,
      promptImages: false,
      terminal: true,
      fs: false,
    },
    integration: 'experimental',
    docs: 'https://github.com/mistralai/mistral-vibe',
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    vendor: 'community',
    probe: { command: 'cursor', args: ['--version'] },
    acp: { command: 'cursor', args: [] },
    supports: {
      loadSession: true,
      promptImages: true,
      terminal: true,
      fs: true,
    },
    integration: 'experimental',
    docs: 'https://cursor.com',
  },
] as const;

/** O(1) lookup by id. Returns `undefined` for unknown ids. */
export function findAgentDescriptor(
  id: string,
): ACPAgentDescriptor | undefined {
  return AGENTS_CATALOG.find((a) => a.id === id);
}
