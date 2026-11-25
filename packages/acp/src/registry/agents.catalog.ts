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
 * This is the OFFLINE FALLBACK catalog. The official, hourly-updated registry
 * now lives at https://github.com/agentclientprotocol/registry (CDN snapshot
 * in `acp-registry-fetch.ts`). `wstack acp sync` / `/acp sync` fetch it into a
 * local cache that supersedes this file at resolution time — so this catalog
 * only needs to carry the most-used agents with invocations that work without
 * a network round-trip. Entries here are kept aligned to the registry's
 * authoritative ACP-entry commands; run `/acp probe` to confirm on a host.
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
import type { ACPAgentDescriptor } from './contracts.js';

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
    // Claude Code does not speak stdio ACP from the bare `claude` binary —
    // it drops into its interactive TUI. The official ACP adapter
    // (`@agentclientprotocol/claude-agent-acp`, registry id `claude-acp`)
    // wraps the logged-in Claude Code CLI and translates ACP ↔ Claude Code.
    // Verify with `/acp probe claude-code`; override via `config.acp.agents`.
    acp: { command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] },
    supports: {
      loadSession: true,
      promptImages: true,
      terminal: true,
      fs: true,
    },
    integration: 'adapter',
    contextWindow: 1_000_000,
    docs: 'https://docs.anthropic.com/en/docs/claude-code',
  },

  // ── Google ───────────────────────────────────────────────────────────
  {
    id: 'gemini-cli',
    displayName: 'Gemini CLI',
    vendor: 'google',
    probe: { command: 'gemini', args: ['--version'] },
    // Gemini CLI (the @google/gemini-cli package, registry id `gemini`)
    // speaks ACP behind `--acp`. We invoke the locally-installed binary so it
    // uses the user's existing login. Confirm with `/acp probe gemini-cli`.
    acp: { command: 'gemini', args: ['--acp'] },
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
    // Bare `codex` has no stdio-ACP entry; the official adapter
    // (`@agentclientprotocol/codex-acp`, registry id `codex-acp`) wraps the
    // logged-in Codex CLI. Confirm with `/acp probe codex-cli`.
    acp: { command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp'] },
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
    probe: { command: 'copilot', args: ['--version'] },
    // ACP is in the standalone @github/copilot CLI (registry id
    // `github-copilot-cli`, v1.0.114+), not the legacy `gh copilot` extension.
    acp: { command: 'npx', args: ['-y', '@github/copilot', '--acp'] },
    supports: {
      loadSession: false,
      promptImages: false,
      terminal: true,
      fs: false,
    },
    integration: 'native',
    docs: 'https://github.com/features/copilot/cli',
  },

  // ── Community / wrappers ─────────────────────────────────────────────
  {
    id: 'cline',
    displayName: 'Cline',
    vendor: 'community',
    probe: { command: 'cline', args: ['--version'] },
    // Registry id `cline`: the `cline` npm package speaks ACP behind `--acp`.
    acp: {
      command: 'npx',
      args: ['-y', 'cline', '--acp'],
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
    acp: { command: 'goose', args: ['acp'] },
    supports: {
      loadSession: true,
      promptImages: true,
      terminal: true,
      fs: true,
    },
    integration: 'native',
    docs: 'https://github.com/block/goose',
  },
  {
    id: 'pi-acp',
    displayName: 'pi ACP',
    vendor: 'community',
    probe: { command: 'pi', args: ['--version'] },
    acp: { command: 'npx', args: ['-y', 'pi-acp'] },
    supports: {
      loadSession: true,
      promptImages: true,
      terminal: true,
      fs: true,
    },
    integration: 'community',
    docs: 'https://github.com/svkozak/pi-acp',
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
    // Not in the official agentclientprotocol/registry (2026-11). Keep as a
    // local-PATH fallback; probe/spawn may hang if the binary has no ACP entry.
    docs: 'https://github.com/OpenHands/OpenHands',
  },

  // ── Vendor CLIs (native binaries) ───────────────────────────────────
  {
    id: 'qwen-code',
    displayName: 'Qwen Code',
    vendor: 'community',
    probe: { command: 'qwen', args: ['--version'] },
    // Qwen Code (the @qwen-code/qwen-code package) speaks ACP behind `--acp`.
    acp: { command: 'qwen', args: ['--acp', '--experimental-skills'] },
    supports: {
      loadSession: false,
      promptImages: false,
      terminal: true,
      fs: false,
    },
    integration: 'native',
    docs: 'https://github.com/QwenLM/Qwen3-Coder',
  },
  {
    id: 'kiro-cli',
    displayName: 'Kiro CLI',
    vendor: 'community',
    probe: { command: 'kiro-cli', args: ['--version'] },
    // Official registry id `kiro` (v3.0.0+): `kiro-cli acp --agent-engine=v3`.
    acp: { command: 'kiro-cli', args: ['acp', '--agent-engine=v3'] },
    supports: {
      loadSession: true,
      promptImages: true,
      terminal: true,
      fs: true,
    },
    integration: 'native',
    docs: 'https://kiro.dev',
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    vendor: 'community',
    probe: { command: 'opencode', args: ['--version'] },
    // OpenCode speaks ACP via its `acp` subcommand (registry id `opencode`).
    acp: { command: 'opencode', args: ['acp'] },
    supports: {
      loadSession: true,
      promptImages: true,
      terminal: true,
      fs: true,
    },
    integration: 'native',
    docs: 'https://github.com/anomalyco/opencode',
  },
  {
    id: 'command-code',
    displayName: 'Command Code',
    vendor: 'community',
    probe: { command: process.platform === 'win32' ? 'cmdc' : 'cmd', args: ['--version'] },
    acp: { command: process.platform === 'win32' ? 'cmdc' : 'cmd', args: ['acp'] },
    supports: { loadSession: false, promptImages: false, terminal: false, fs: false },
    integration: 'native',
    docs: 'https://commandcode.ai/docs/acp',
  },
  {
    id: 'mistral-vibe',
    displayName: 'Mistral Vibe',
    vendor: 'community',
    probe: { command: 'vibe-acp', args: ['--version'] },
    // Official registry ships a dedicated `vibe-acp` binary, not bare `vibe`.
    acp: { command: 'vibe-acp', args: [] },
    supports: {
      loadSession: false,
      promptImages: false,
      terminal: true,
      fs: false,
    },
    integration: 'native',
    docs: 'https://github.com/mistralai/mistral-vibe',
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    vendor: 'community',
    probe: { command: 'cursor-agent', args: ['--version'] },
    // Cursor's ACP entry is the `cursor-agent acp` binary (registry id `cursor`).
    acp: { command: 'cursor-agent', args: ['acp'] },
    supports: {
      loadSession: true,
      promptImages: true,
      terminal: true,
      fs: true,
    },
    integration: 'native',
    docs: 'https://cursor.com',
  },
  // ── Moonshot AI (Kimi) ─────────────────────────────────────────────
  {
    id: 'kimi-code',
    displayName: 'Kimi Code',
    vendor: 'moonshot',
    probe: { command: 'kimi-code', args: ['--version'] },
    // Official registry id `kimi-code` (`@moonshot-ai/kimi-code`, v2.7+): supersedes legacy `kimi`.
    acp: { command: 'npx', args: ['-y', '@moonshot-ai/kimi-code', 'acp'] },
    supports: {
      loadSession: true,
      promptImages: true,
      terminal: true,
      fs: true,
    },
    integration: 'native',
    docs: 'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/ides.html',
  },
  {
    id: 'kimi',
    displayName: 'Kimi Code CLI',
    vendor: 'moonshot',
    probe: { command: 'kimi', args: ['--version'] },
    // Legacy Kimi Code CLI binary (`kimi acp`). Kept alongside `kimi-code`
    // for users with the local binary already installed and logged in.
    acp: { command: 'kimi', args: ['acp'] },
    supports: {
      loadSession: true,
      promptImages: true,
      terminal: true,
      fs: true,
    },
    integration: 'native',
    docs: 'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/ides.html',
  },
  // ── Additional Official ACP Registry Agents ────────────────────────
  {
    id: 'antigravity-acp',
    displayName: 'Google Antigravity',
    vendor: 'google',
    probe: { command: 'agy', args: ['--version'] },
    acp: { command: 'agy', args: ['acp'] },
    supports: { loadSession: true, promptImages: true, terminal: true, fs: true },
    integration: 'native',
    docs: 'https://antigravity.google/docs/cli/acp/',
  },
  {
    id: 'amp-acp',
    displayName: 'Amp',
    vendor: 'community',
    probe: { command: 'amp-acp', args: ['--version'] },
    acp: { command: 'amp-acp', args: [] },
    supports: { loadSession: true, promptImages: true, terminal: true, fs: true },
    integration: 'native',
    docs: 'https://ampcode.com',
  },
  {
    id: 'auggie',
    displayName: 'Auggie CLI',
    vendor: 'community',
    probe: { command: 'auggie', args: ['--version'] },
    acp: { command: 'npx', args: ['-y', '@augmentcode/auggie', '--acp'] },
    supports: { loadSession: true, promptImages: true, terminal: true, fs: true },
    integration: 'native',
    docs: 'https://www.augmentcode.com',
  },
  {
    id: 'devin',
    displayName: 'Devin',
    vendor: 'community',
    probe: { command: 'devin', args: ['--version'] },
    acp: { command: 'devin', args: ['acp'] },
    supports: { loadSession: true, promptImages: true, terminal: true, fs: true },
    integration: 'native',
    docs: 'https://devin.ai',
  },
  {
    id: 'factory-droid',
    displayName: 'Factory Droid',
    vendor: 'community',
    probe: { command: 'droid', args: ['--version'] },
    acp: { command: 'npx', args: ['-y', 'droid', 'exec', '--output-format', 'acp-daemon'] },
    supports: { loadSession: true, promptImages: true, terminal: true, fs: true },
    integration: 'native',
    docs: 'https://factory.ai',
  },
  {
    id: 'grok-build',
    displayName: 'Grok Build',
    vendor: 'community',
    probe: { command: 'grok', args: ['--version'] },
    acp: { command: 'npx', args: ['-y', '@xai-official/grok', 'agent', 'stdio'] },
    supports: { loadSession: true, promptImages: true, terminal: true, fs: true },
    integration: 'native',
    docs: 'https://x.ai',
  },
  {
    id: 'junie',
    displayName: 'Junie',
    vendor: 'community',
    probe: { command: 'junie', args: ['--version'] },
    acp: { command: 'junie', args: ['--acp=true'] },
    supports: { loadSession: true, promptImages: true, terminal: true, fs: true },
    integration: 'native',
    docs: 'https://www.jetbrains.com/junie/',
  },
  {
    id: 'kilo',
    displayName: 'Kilo',
    vendor: 'community',
    probe: { command: 'kilo', args: ['--version'] },
    acp: { command: 'npx', args: ['-y', '@kilocode/cli', 'acp'] },
    supports: { loadSession: true, promptImages: true, terminal: true, fs: true },
    integration: 'native',
    docs: 'https://kilocode.ai',
  },
] as const;

/** O(1) lookup by id. Returns `undefined` for unknown ids. */
export function findAgentDescriptor(id: string): ACPAgentDescriptor | undefined {
  return AGENTS_CATALOG.find((a) => a.id === id);
}
