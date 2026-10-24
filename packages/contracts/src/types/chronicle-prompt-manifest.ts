/** Content-addressed summary of one provider request; built by `chronicle/prompt-manifest.ts`. */
export interface ChroniclePromptManifest {
  manifestId: string;
  messageCount: number;
  estimatedMessageTokens: number;
  contentBytes: number;
  roleCounts: Record<string, number>;
  blockCounts: Record<string, number>;
  system: { blockCount: number; bytes: number; hash: string };
  messages: Array<{
    index: number;
    role: string;
    bytes: number;
    estimatedTokens?: number;
    hash: string;
    blocks: Record<string, number>;
  }>;
  tools: {
    count: number;
    estimatedDefinitionTokens: number;
    manifestHash: string;
    names: string[];
    mutating: number;
    destructive: number;
  };
  request: Record<string, unknown>;
}
