export interface WSChimeraUsageMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  totalTokens: number;
  costUsd: number;
  iterations?: number | undefined;
  toolCalls?: number | undefined;
  durationMs?: number | undefined;
  attemptsUsed?: number | undefined;
}

export interface WSChimeraScopeManifest {
  headSha?: string | undefined;
  isIncremental?: boolean | undefined;
  files: Array<{
    path: string;
    status: 'added' | 'modified';
    sha256?: string | undefined;
    hunkCount?: number | undefined;
    addedLines?: number | undefined;
    removedLines?: number | undefined;
    diffTruncated?: boolean | undefined;
    isIncrementalDelta?: boolean | undefined;
    changedSymbols?: string[] | undefined;
    pairedTestPath?: string | undefined;
    pairedTestUpdated?: boolean | undefined;
  }>;
  deletedFiles?: string[] | undefined;
  deletedFileReferences?:
    | Array<{
        deletedPath: string;
        referencedBy: string[];
      }>
    | undefined;
  signatureCallers?:
    | Array<{
        symbol: string;
        file: string;
        callers: string[];
      }>
    | undefined;
  sessionIntent?: string[] | undefined;
  skippedFiles?:
    | Array<{
        path: string;
        reason: string;
        detail?: string | undefined;
      }>
    | undefined;
  kanbanCardId?: string | undefined;
  activeTodoCount?: number | undefined;
  priorFindingCount?: number | undefined;
}

export type WSChimeraServerMessage =
  | {
      type: 'chimera.report_available';
      payload: {
        reportId: string;
        sessionId: string;
        message: string;
        fileCount: number;
        findingCount: number;
        hasActionableFindings: boolean;
        messageId?: string | undefined;
      };
    }
  | {
      type: 'chimera.reports';
      payload: {
        sessionId: string;
        isQuery?: boolean | undefined;
        reports: Array<{
          reportId: string;
          sessionId?: string | undefined;
          agentId?: string | undefined;
          reviewedAt: string;
          reviewerModel?: string | undefined;
          source?: string | undefined;
          reviewStatus?: 'success' | 'failed' | undefined;
          lifecycleStatus: string;
          counts?: { critical: number; high: number; medium: number; low: number } | undefined;
          totalFindings: number;
          fileCount?: number | undefined;
          skippedFileCount?: number | undefined;
          headSha?: string | undefined;
          durationSeconds?: number | undefined;
          cascadeDepth?: number | undefined;
          evidenceStatus?: string | undefined;
          usage?: WSChimeraUsageMetrics | undefined;
          hasActionableFindings?: boolean | undefined;
        }>;
      };
    }
  | {
      type: 'chimera.report.detail';
      payload: {
        report: {
          id: string;
          reviewedAt: string;
          sessionId: string;
          agentId: string;
          reviewerModel: string;
          source: string;
          reviewStatus: 'success' | 'failed';
          lifecycle: string;
          files: Array<{ path: string; status: string }>;
          counts: { critical: number; high: number; medium: number; low: number };
          totalFindings: number;
          unparseableCount: number;
          durationSeconds?: number | undefined;
          rawText: string;
          cascadeDepth?: number | undefined;
          evidenceStatus?: string | undefined;
          evidenceChecks?:
            | Array<{
                name: string;
                command: string;
                ok: boolean;
                claimedExitCode?: number | null;
                actualExitCode?: number | null;
              }>
            | undefined;
          usage?: WSChimeraUsageMetrics | undefined;
          scopeManifest?: WSChimeraScopeManifest | undefined;
        } | null;
        findings: Array<{
          finding: {
            id: string;
            fingerprint: string;
            severity: 'critical' | 'high' | 'medium' | 'low';
            source: string;
            location?: { file: string; line?: number | undefined } | undefined;
            category?: string | undefined;
            confidence?: string | undefined;
            verification?:
              | { status: string; reason: string; evidence?: string | undefined }
              | undefined;
            title: string;
            description: string;
            suggestedFix?: string | undefined;
            createdAt: string;
            status: string;
            resolution?:
              | {
                  outcome: string;
                  resolvedAt: string;
                  resolvedBy: string;
                  commitSha?: string | undefined;
                  notes?: string | undefined;
                }
              | undefined;
            originReport: {
              reportId: string;
              sessionId: string;
              agentId: string;
              reviewerModel: string;
            };
          };
          events: Array<{
            id: string;
            findingId: string;
            eventType: string;
            fromStatus: string | null;
            toStatus: string;
            actorId: string;
            actorKind: string;
            timestamp: string;
            reason?: string | undefined;
          }>;
        }>;
        events: Array<{
          id: string;
          reportId: string;
          eventType: string;
          fromLifecycle: string | null;
          toLifecycle: string;
          actorId: string;
          actorKind: string;
          timestamp: string;
          reason?: string | undefined;
        }>;
        scopeDrift?:
          | {
              stale: boolean;
              checkedCount: number;
              modifiedPaths: string[];
              missingPaths: string[];
            }
          | undefined;
        error?: string | undefined;
      };
    }
  | {
      type: 'chimera.report.updated';
      payload: {
        reportId: string;
        lifecycle?: string | undefined;
        success: boolean;
        error?: string | undefined;
      };
    }
  | {
      type: 'chimera.report.note_added';
      payload: { reportId: string; success: boolean; error?: string | undefined };
    }
  | {
      type: 'chimera.finding.updated';
      payload: {
        findingId: string;
        status?: string | undefined;
        success: boolean;
        error?: string | undefined;
      };
    };
