import type { Permission } from '../tool.js';
import type { TokenSavingTier } from './runtime.js';

export interface MCPServerConfig {
  /** Human-readable description shown in `wstack mcp list`. */
  description?: string | undefined;
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string | undefined;
  args?: string[] | undefined;
  env?: Record<string, string>;
  url?: string | undefined;
  headers?: Record<string, string>;
  enabled?: boolean | undefined;
  allowedTools?: string[] | undefined;
  permission?: Permission | undefined;
  startupTimeoutMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
  /**
   * Lazy connect: when true, the server process is NOT spawned at boot. Its
   * tools are registered from a cached manifest (discovered on the first ever
   * connect) and the server only spawns when one of its tools is actually
   * called, then auto-sleeps after an idle period. Default (false/undefined) =
   * eager connect at boot.
   */
  lazy?: boolean | undefined;
  /**
   * Allowlist of environment variable names to forward from the parent process
   * to this MCP server's child process. The values are resolved from
   * `process.env` at spawn time, NOT stored in the config file.
   *
   * Why this exists: WrongStack's `buildChildEnv()` security filter scrubs
   * env vars whose names look like secrets (TOKEN, SECRET, AUTH, KEY, ...)
   * from all child processes — this prevents a compromised MCP server from
   * exfiltrating provider API keys. But most MCP servers (GitHub, Slack,
   * Brave Search, ...) need their own API tokens from the environment.
   * `passthroughEnv` is the explicit bypass: only vars listed here survive
   * the filter, and they go through the `extra` path (unfiltered merge).
   *
   * Built-in presets declare their required env vars here so they work
   * out of the box when the user has the corresponding env vars exported
   * in their shell. Users can also add entries for custom servers.
   *
   * Example: passthroughEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_TOKEN']
   */
  passthroughEnv?: string[] | undefined;
  /**
   * Operational-health settings for this MCP server. Thresholds are optional;
   * when omitted the server is considered healthy as long as its connection
   * lifecycle succeeds. Latency thresholds compare against the rolling p95 of
   * the bounded sample buffer; the in-flight threshold compares against the
   * observed peak in-flight call count.
   */
  health?: MCPHealthConfig | undefined;
}

/** Per-server operational-health knobs. */
export interface MCPHealthConfig {
  thresholds?: MCPHealthThresholds | undefined;
}

/**
 * Configurable thresholds that can push an otherwise-healthy MCP server into
 * the `degraded` health state. All thresholds are optional and disabled when
 * omitted so existing behaviour is preserved.
 */
export interface MCPHealthThresholds {
  /** Connection latency p95 above this value marks the server degraded. */
  connectionLatencyP95Ms?: number | undefined;
  /** Discovery (capability listing) latency p95 above this marks degraded. */
  discoveryLatencyP95Ms?: number | undefined;
  /** Tool-call latency p95 above this marks degraded. */
  callLatencyP95Ms?: number | undefined;
  /** Peak in-flight calls above this marks the server saturated/degraded. */
  inFlightCalls?: number | undefined;
}

export interface LogConfig {
  level: 'error' | 'warn' | 'info' | 'debug' | 'trace';
  file?: string | undefined;
}

export interface PluginConfig {
  name: string;
  enabled?: boolean | undefined;
  options?: Record<string, unknown>;
}

/**
 * Human-owned policy for the LLM-facing `plugin_manager` tool.
 * This is deliberately separate from `PluginConfig.enabled`: ordinary
 * `/plugin` commands remain available to the user even when the LLM is not
 * allowed to change a plugin's boot state.
 */
export interface PluginManagerConfig {
  /**
   * Plugin names/aliases that `plugin_manager` may discover and use but may
   * not enable or disable. Use `"*"` to block all LLM plugin-state changes.
   */
  locked?: string[] | undefined;
}

/**
 * Optional subsystems that the CLI can boot without. The core flow
 * (provider + agent loop + bundled tools + session) always works; these
 * just add capabilities. `--no-features` flips all of these off, which
 * is the minimum viable WrongStack: a single provider, a fixed config,
 * no network calls at startup.
 */
export interface FeaturesConfig {
  /** Load MCP servers declared in `mcpServers`. */
  mcp: boolean;
  /** Load + initialise npm plugins declared in `plugins`. */
  plugins: boolean;
  /** Register `remember` / `forget` tools backed by memory store. */
  memory: boolean;
  /**
   * Automatically consolidate session learnings into long-term memory
   * after each completed run. The agent extracts key facts, conventions,
   * and decisions via a lightweight LLM call and persists them.
   * Enabled by default when `memory` is on; set to false to opt out.
   */
  memoryConsolidation?: boolean | undefined;
  /** Fetch the models.dev catalog at startup. When false, the provider
   *  must declare its `family` explicitly in `providers[<id>]`. */
  modelsRegistry: boolean;
  /** Discover + load skills from disk. */
  skills: boolean;
  /**
   * Enable the prompt library (`/prompt`, `/prompts`, `/prompt-gen`, the WebUI
   * modal and the bundled 168-prompt dataset). Defaults to on; set to false to
   * disable the subsystem entirely (the loader is withheld so every surface
   * reports it unavailable).
   */
  prompts?: boolean | undefined;
  /**
   * Token-saving mode tier. Controls how aggressively the system prompt
   * is compacted to reduce per-request token consumption.
   *
   * - 'off'        — Full prompt, all tools, complete guidance
   * - 'minimal'    — TIER1 tools only, stripped guidance (~3-4k tokens saved)
   * - 'light'     — Core + memory tools, common patterns, minimal guidance
   * - 'medium'    — Most development tools, some guidance
   * - 'aggressive' — Maximum savings before tools become unusable (~4-5k tokens)
   *
   * Boolean values are accepted for backward compatibility:
   * - `true`  → 'medium'
   * - `false` → 'off'
   *
   * Enable via CLI: `--token-saving-tier <level>` or `--token-saving-mode` (maps to 'medium').
   * Configure via: `features.tokenSavingMode: "minimal"` in config.
   */
  tokenSavingMode?: TokenSavingTier | boolean | undefined;
  /**
   * Enable the autonomous-coordination toolkit (AutonomousCoordinator +
   * KnowledgeGraph + ConsensusProtocol + TaskAuctioneer + ChangeManager +
   * TaskDAG). When true (the default), the TUI boot wires the coordinator
   * lazily on the first Director spawn. When false, the coordinator is
   * never constructed and the `/coordinator` slash command reports it
   * unavailable — reducing the coordination domain's runtime surface for
   * users who only use the simpler Director/Fleet path.
   */
  autonomousCoordination?: boolean | undefined;
  /**
   * Allow tools to read/write paths outside the project root directory.
   * When true (default), tools can access any path on the filesystem.
   * When false, tools are restricted to the project root directory.
   */
  allowOutsideProjectRoot?: boolean | undefined;
  /**
   * Auto-bootstrap the mailbox HTTP bridge from any WrongStack surface
   * (REPL/TUI/WebUI/eternal). When 'auto' (the default), the first
   * surface to come up for a given project joins or spawns the bridge
   * so external agents can connect without the user running
   * `wstack mailbox serve` themselves. 'off' disables this — operators
   * must start the bridge explicitly (e.g. via the `/mailbox-serve`
   * slash command or the standalone `wstack mailbox serve` subcommand).
   * The per-project lock + token-persistence model means a second
   * surface on the same project joins the first's bridge rather than
   * spawning a duplicate.
   */
  mailboxBridge?: 'auto' | 'off' | undefined;
}

export interface SageConfig {
  /**
   * Default: true. SAGE is the ONLY memory backend — this flag no longer
   * swaps the store. When `false`, the backend is still SAGE (explicit
   * `/memory`, agent memory tools, and WebUI all keep working); only automatic
   * context injection and session-end hygiene are turned off.
   */
  enabled?: boolean | undefined;
  storage?:
    | {
        /** Store memory inside the project under a gitignored directory. Default: true. */
        projectLocal?: boolean | undefined;
        /** Project-relative directory. Default: ".wrongstack/memories". */
        directory?: string | undefined;
      }
    | undefined;
  inject?:
    | {
        /** Add relevant memory to ordinary turn-level context. Default: false (opt-in). */
        turnContext?: boolean | undefined;
        /** Add relevant memory to read/tree/grep/bash/edit tool results. Default: true. */
        toolResults?: boolean | undefined;
        /**
         * Fold live todo/Kanban text into the tool retrieval query.
         * Default: false — it searches for the current task rather than the
         * file the tool touched, and matches found that way are unrelated to
         * the result they get appended to.
         */
        taskAware?: boolean | undefined;
        /** Maximum diverse, structurally related hints appended to a single tool result. Default: 8. */
        maxHintsPerTool?: number | undefined;
        /** Maximum characters appended to a single tool result. Default: 2800. */
        maxCharsPerTool?: number | undefined;
        /** Maximum memories appended to ordinary turn context. Default: 8. */
        maxTurnMemories?: number | undefined;
        /** Maximum characters appended to ordinary turn context. Default: 2400. */
        maxCharsPerTurn?: number | undefined;
        /** Minimum retrieval score for ordinary hints. Default: 0.72. */
        minScore?: number | undefined;
        /**
         * Hard importance floor for automatic injection. Default: 0.5.
         * Memories below it stay searchable but are never auto-injected.
         */
        minImportance?: number | undefined;
        /**
         * Cooldown before an already-injected memory may be injected again.
         * Default: 0 — once per session. A positive value restores time-boxed
         * repeats.
         */
        repeatCooldownMs?: number | undefined;
        triggers?:
          | Partial<
              Record<
                | 'read'
                | 'tree'
                | 'grep'
                | 'glob'
                | 'codebase_search'
                | 'bash'
                | 'write'
                | 'edit'
                | 'patch',
                boolean
              >
            >
          | undefined;
      }
    | undefined;
  retrieval?:
    | {
        /**
         * Weight given to the metadata score floor (0–1) in the relevance-blended
         * scoring formula: `metadataScore * (metadataWeight + relevance * (1 - metadataWeight))`.
         * At 0.0, relevance fully gates injection. At 1.0, metadata alone decides.
         * Default: 0.3 — validated against 148 real query-memory pairs.
         */
        metadataWeight?: number | undefined;
      }
    | undefined;
  hygiene?:
    | {
        /** Run hygiene after successful sessions. Default: true. */
        autoAfterSession?: boolean | undefined;
        /** Re-check anchored memories when files are edited. Default: true. */
        autoOnFileChange?: boolean | undefined;
        /** Archive stale/low-value memories after this many days. Default: 90. */
        retentionDays?: number | undefined;
        /**
         * Soft-delete session-scoped memories without `expiresAt` after this
         * many days. Default: 7. Session scope is ephemeral and is deleted
         * by hygiene immediately (no review candidate).
         */
        sessionRetentionDays?: number | undefined;
        /** Archive low-confidence memories after this many days. Default: 30. */
        archiveLowConfidenceAfterDays?: number | undefined;
        /**
         * Archive active memories that were injected at least `unusedMinInjections`
         * times but never referenced by the assistant, this many days after their
         * last content update. Default: 30.
         */
        archiveUnusedAfterDays?: number | undefined;
        /** Minimum injection count before a never-used memory is archived. Default: 10. */
        unusedMinInjections?: number | undefined;
        /**
         * OPT-IN: physically remove soft-deleted tombstones older than this
         * many days. Undefined/0 disables purge (default).
         */
        purgeDeletedAfterDays?: number | undefined;
      }
    | undefined;
  embeddings?:
    | {
        /** Optional future semantic layer. Disabled by default and never required. */
        enabled?: boolean | undefined;
      }
    | undefined;
}
