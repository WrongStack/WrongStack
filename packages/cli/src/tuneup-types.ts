import type { Config } from '@wrongstack/contracts/types';
import type { UpdateInfo } from './update-check.js';

type TuneupSeverity = 'error' | 'warning' | 'info' | 'ok';

/** Stable check-group ids — one section per group in the rendered report. */
export type TuneupCategory =
  | 'version'
  | 'autonomy'
  | 'skills'
  | 'mcp'
  | 'plugins'
  | 'memory'
  | 'hooks'
  | 'permissions'
  | 'performance'
  | 'reliability'
  | 'config';

/**
 * A structured, deterministic repair the command knows how to apply.
 * `set-config` is the generic one — a dot-path into the global config plus the
 * value to set — so most knobs need no bespoke apply logic.
 */
export type TuneupAction =
  | { kind: 'set-config'; path: string[]; value: unknown; label: string }
  | { kind: 'add-exec-allow'; commands: string[] }
  | { kind: 'normalize-hook-timeout'; event: string; index: number; timeoutMs: number };

export interface TuneupFinding {
  category: TuneupCategory;
  severity: TuneupSeverity;
  /** One-line problem statement. */
  problem: string;
  /** Optional human hint about the recommended action. */
  suggestion?: string | undefined;
  /** Present when a deterministic auto-fix exists; short description shown in the report. */
  fix?: string | undefined;
  /** Machine-readable descriptor the command applies on `/tuneup fix`. */
  action?: TuneupAction | undefined;
  /** A line folded into the agent follow-up turn (fuzzy items with no mechanical fix). */
  handoff?: string | undefined;
}

/** A discovered skill, reduced to what the checks need. */
export interface TuneupSkill {
  name: string;
  source: string;
  /** Body length in chars, when the command could read it (best-effort). */
  bodyChars?: number | undefined;
}

/** Live MCP server status, reduced from `mcpRegistry.describe()`. */
interface TuneupMcpServer {
  name: string;
  state: string;
  enabled: boolean;
  toolCount: number;
}

/** An instruction/memory file layer to compare + size-check. */
export interface TuneupMemoryFile {
  /** Human label, e.g. "user memory" or "project AGENTS.md". */
  label: string;
  path: string;
  content: string;
  /** True for committed/shared layers (project AGENTS.md, root CLAUDE.md). */
  committed: boolean;
}

/** The persistent permission trust file, `~/.wrongstack/projects/<hash>/trust.json`. */
export type TuneupTrustPolicy = Record<
  string,
  { allow?: string[] | undefined; deny?: string[] | undefined; auto?: boolean | undefined }
>;

/** Ambient facts the command precomputes (host / disk / env) for the checks. */
interface TuneupEnv {
  /** Logical CPU count, for the maxConcurrent sanity check. */
  cpuCount?: number | undefined;
  /** Number of configured providers, for the fallback-chain check. */
  providerCount?: number | undefined;
  /** Whether the secret vault is passphrase-hardened at rest. */
  vaultHardened?: boolean | undefined;
  /** Total bytes of on-disk session logs for this project (disk-hygiene check). */
  sessionBytes?: number | undefined;
}

export interface TuneupInput {
  config: Config;
  skills: TuneupSkill[];
  /** `config.skills.eagerMaxChars` or its default. */
  eagerMaxChars: number;
  skillMode: 'eager' | 'progressive';
  /** Live MCP status when the host wired `mcpStatus`; undefined → skip live MCP checks. */
  mcp?: TuneupMcpServer[] | undefined;
  /** Instruction-file layers (user memory, project AGENTS.md, root CLAUDE.md/AGENTS.md). */
  memoryFiles: TuneupMemoryFile[];
  /** Self-update info (from `checkForUpdate`), when the version check ran. */
  update?: UpdateInfo | undefined;
  /** Parsed trust file, when present. */
  trust?: TuneupTrustPolicy | undefined;
  /**
   * Denied read-only commands mined from session history (optional richer
   * signal). Each entry is a command line and how many times it was denied.
   */
  deniedFromHistory?: Array<{ command: string; count: number }> | undefined;
  /** Ambient host/disk facts. */
  env?: TuneupEnv | undefined;
  /** Count of `/doctor`-style config issues (from `diagnoseConfig`). */
  configIssues?: number | undefined;
  /**
   * Power profile: `/tuneup fix --power`. Gates the autonomy/yolo/director
   * actions so a plain tune-up never flips them (respects the user-owned
   * autonomy invariant).
   */
  power?: boolean | undefined;
}

export interface TuneupReport {
  findings: TuneupFinding[];
  /** Composed agent follow-up prompt for fuzzy items; empty when none. */
  agentHandoff: string;
}
