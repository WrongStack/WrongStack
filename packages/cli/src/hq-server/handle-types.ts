/**
 * Type-only leaf for the public HQ server handle.
 *
 * Lives separately from `hq-server.ts` so callers (notably
 * `subcommands/handlers/hq.ts`) can depend on the public types without
 * pulling in the HQ server implementation. Breaks a long-standing type-only
 * import edge `handlers/hq.ts → hq-server.ts` that participated in the
 * 33-member CLI SCC (see docs/reports/modularity-assessment-2026-08-22.md).
 *
 * This module MUST contain no runtime imports.
 */

export interface HqStartupConnectionInfo {
  dataDir: string;
  browserUrl: string;
  clientUrl: string;
  clientEnv: {
    WRONGSTACK_HQ_URL: string;
    WRONGSTACK_HQ_TOKEN?: string;
  };
  createdAuth: boolean;
  browserTokenMode: boolean;
  passwordMode: boolean;
}

export type HqFirstRunSetup = HqStartupConnectionInfo;

export interface HqServerHandle {
  host: string;
  port: number;
  firstRunSetup?: HqFirstRunSetup;
  trustPublicOrigin(origin: string): void;
  close(): Promise<void>;
}
