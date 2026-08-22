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
    probe: { command: 'gh', args: ['copilot', '--help'] },
    // ACP is in the standalone @github/copilot CLI (registry id
    // `github-copilot-cli`), not the `gh copilot` extension. Use the package.
    acp: { command: 'npx', args: ['-y', '@github/copilot', '--acp'] },
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
    // Qwen Code (the @qwen-code/qwen-code package) speaks ACP behind `--acp`.
    acp: { command: 'qwen', args: ['--acp'] },
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
    // OpenCode speaks ACP via its `acp` subcommand (registry id `opencode`).
    acp: { command: 'opencode', args: ['acp'] },
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
    // Cursor's ACP entry is the `cursor-agent acp` binary (registry id `cursor`).
    acp: { command: 'cursor-agent', args: ['acp'] },
    supports: {
      loadSession: true,
      promptImages: true,
      terminal: true,
      fs: true,
    },
    integration: 'experimental',
    docs: 'https://cursor.com',
  },
  // ── Moonshot AI (Kimi) ─────────────────────────────────────────────
  {
    id: 'kimi',
    displayName: 'Kimi Code CLI',
    vendor: 'moonshot',
    probe: { command: 'kimi', args: ['--version'] },
    // Kimi Code CLI speaks ACP behind `kimi acp`. The user must complete
    // terminal login (`kimi` → `/login`) before launching `kimi acp`;
    // otherwise session creation fails with `Authentication required`.
    // The adapter reuses the CLI's existing auth state — WrongStack does
    // NOT capture or replay the Kimi OAuth tokens.
    // Docs: https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html
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
] as const;

/** O(1) lookup by id. Returns `undefined` for unknown ids. */
export function findAgentDescriptor(id: string): ACPAgentDescriptor | undefined {
  return AGENTS_CATALOG.find((a) => a.id === id);
}
