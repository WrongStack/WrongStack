import * as path from 'node:path';
import type { RunResult } from '../core/agent-types.js';
import type { Context } from '../core/context.js';
import type { OneShotOrchestrator } from '../execution/one-shot-llm.js';
import type { AfterRunHook, AgentExtension } from '../extension/extension-points.js';
import type { MemoryStore } from '../types/memory.js';
import type { Provider } from '../types/provider.js';
import {
  readBundledInstructionText,
  renderInstructionTemplate,
} from '../utils/instruction-file.js';

// ── Types ───────────────────────────────────────────────────────────────

export type CuratorSageKind =
  | 'fact'
  | 'decision'
  | 'convention'
  | 'preference'
  | 'anti_pattern'
  | 'warning'
  | 'workflow'
  | 'bug_root_cause'
  | 'file_note'
  | 'symbol_note'
  | 'command_note';

export interface CuratorMemoryAnchor {
  type: 'file' | 'directory' | 'symbol' | 'package' | 'command' | 'test' | 'git';
  path?: string | undefined;
  symbol?: string | undefined;
  command?: string | undefined;
}

export interface CuratorSageRecord {
  id: string;
  text: string;
  scope?: string | undefined;
  kind?: string | undefined;
  status?: string | undefined;
  importance?: number | undefined;
  confidence?: number | undefined;
  freshness?: number | undefined;
  tags?: string[] | undefined;
  anchors?: CuratorMemoryAnchor[] | undefined;
  persistence?: 'permanent' | 'long_lived' | 'short_lived' | undefined;
  contradicts?: string[] | undefined;
  supersedes?: string[] | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface CuratorSageCandidate {
  id: string;
  memoryId?: string | undefined;
  reason?: string | undefined;
  suggestedAction?: string | undefined;
}

export interface CuratorSage {
  rememberSage(input: {
    text: string;
    scope?: string | undefined;
    kind?: CuratorSageKind | undefined;
    tags?: string[] | undefined;
    importance?: number | undefined;
    confidence?: number | undefined;
    persistence?: 'permanent' | 'long_lived' | 'short_lived' | undefined;
    anchors?: CuratorMemoryAnchor[] | undefined;
    sources?: Array<{ type: string; sessionId?: string | undefined }> | undefined;
    supersedes?: string[] | undefined;
    contradicts?: string[] | undefined;
  }): Promise<{ id?: string } | unknown>;
  getSage?(id: string): Promise<CuratorSageRecord | null>;
  updateSage?(id: string, patch: Partial<CuratorSageRecord>): Promise<unknown>;
  deleteSage?(id: string, reason?: string): Promise<void>;
  listCandidates?(includeResolved?: boolean): Promise<CuratorSageCandidate[]>;
  retrieveForPath?(opts: {
    path: string;
    limit?: number;
    includeStatuses?: string[];
  }): Promise<CuratorSageRecord[]>;
  searchSage?(
    query: string,
    opts?: { limit?: number; scope?: 'project'; includeStatuses?: string[] },
  ): Promise<unknown[]>;
}

export type CuratorOperation =
  | { action: 'supersede'; targetId: string; reason: string; supersededBy?: string | undefined }
  | { action: 'contradict'; targetId: string; reason: string; contradictsWith?: string | undefined }
  | {
      action: 'merge';
      targetIds: string[];
      text: string;
      type?: string | undefined;
      priority?: string | undefined;
      confidence?: number | undefined;
      tags?: string[] | undefined;
      anchors?: CuratorMemoryAnchor[] | undefined;
      reason: string;
    }
  | {
      action: 'split';
      targetId: string;
      items: Array<{
        text: string;
        type?: string | undefined;
        priority?: string | undefined;
        confidence?: number | undefined;
        tags?: string[] | undefined;
        anchors?: CuratorMemoryAnchor[] | undefined;
      }>;
      reason: string;
    }
  | {
      action: 'recalibrate';
      targetId: string;
      importance?: number | undefined;
      confidence?: number | undefined;
      freshness?: number | undefined;
      status?: string | undefined;
      reason: string;
    }
  | { action: 'keep'; targetId: string; reason: string };

interface CuratorResponse {
  operations: CuratorOperation[];
  summary?: string | undefined;
}

export interface SessionMemoryCuratorOptions {
  memoryStore: MemoryStore;
  Sage?: CuratorSage | undefined;
  provider?: Provider | undefined;
  model?: string | undefined;
  maxTargetMemories?: number | undefined;
  oneShotOrchestrator?: OneShotOrchestrator | undefined;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function toSageKind(type: string | undefined): CuratorSageKind {
  switch (type) {
    case 'decision':
    case 'convention':
    case 'preference':
    case 'anti_pattern':
    case 'warning':
    case 'workflow':
    case 'bug_root_cause':
    case 'file_note':
    case 'symbol_note':
    case 'command_note':
      return type;
    default:
      return 'fact';
  }
}

function importanceFromPriority(priority: string | undefined): number {
  switch (priority) {
    case 'critical':
      return 0.95;
    case 'high':
      return 0.8;
    case 'medium':
      return 0.55;
    case 'low':
      return 0.25;
    default:
      return 0.6;
  }
}

function relativePath(projectRoot: string, filePath: string): string {
  const rel = path.relative(projectRoot, filePath);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
    ? rel.replaceAll('\\', '/')
    : filePath.replaceAll('\\', '/');
}

function formatCandidateRecord(record: CuratorSageRecord): string {
  const anchors =
    record.anchors && record.anchors.length > 0
      ? ` [anchors: ${record.anchors.map((a) => (a.path ? `${a.type}:${a.path}` : a.type)).join(', ')}]`
      : '';
  const tags = record.tags && record.tags.length > 0 ? ` [tags: ${record.tags.join(', ')}]` : '';
  const status = record.status ? ` (status: ${record.status})` : '';
  const kind = record.kind ? ` [${record.kind}]` : '';
  return `- ID: ${record.id}${status}${kind}: "${record.text}"${tags}${anchors} (importance: ${record.importance ?? 0.6}, confidence: ${record.confidence ?? 0.8})`;
}

// ── SessionMemoryCurator ────────────────────────────────────────────────

export class SessionMemoryCurator implements AgentExtension {
  name = 'session-memory-curator';
  owner = 'core';
  private readonly Sage?: CuratorSage | undefined;
  private readonly provider?: Provider | undefined;
  private readonly model?: string | undefined;
  private readonly maxTargetMemories: number;
  private readonly oneShotOrchestrator?: OneShotOrchestrator | undefined;

  constructor(opts: SessionMemoryCuratorOptions) {
    this.Sage = opts.Sage;
    this.provider = opts.provider;
    this.model = opts.model;
    this.maxTargetMemories = opts.maxTargetMemories ?? 10;
    this.oneShotOrchestrator = opts.oneShotOrchestrator;
  }

  afterRun: AfterRunHook = async (ctx: Context, result: RunResult) => {
    // Only curate after successful runs with actual work done
    if (result.status !== 'done') return;
    if (!this.Sage?.updateSage) return;

    const provider = this.provider ?? ctx.provider;
    if (!provider?.complete && !this.oneShotOrchestrator) return;

    const projectRoot = ctx.projectRoot ?? ctx.cwd ?? '';
    const writtenFiles = [...(ctx.writtenFiles ?? [])].slice(0, 6).map((f) => relativePath(projectRoot, f));

    // Phase 1: Deterministik Scope Toplama
    // Sadece oturum boyunca dosya yazılmışsa veya bekleyen candidate varsa çalışır.
    const targetMap = new Map<string, CuratorSageRecord>();

    try {
      // 1. Yazılan dosyalara bağlı olan hafıza kayıtlarını çek
      for (const file of writtenFiles) {
        if (targetMap.size >= this.maxTargetMemories) break;
        if (this.Sage.retrieveForPath) {
          const matched = await this.Sage.retrieveForPath({
            path: file,
            limit: 4,
            includeStatuses: ['active', 'stale'],
          });
          for (const m of matched) {
            if (m.id && !targetMap.has(m.id)) {
              targetMap.set(m.id, m);
            }
          }
        } else if (this.Sage.searchSage) {
          const searchHits = (await this.Sage.searchSage(file, {
            limit: 4,
            scope: 'project',
            includeStatuses: ['active', 'stale'],
          })) as CuratorSageRecord[];
          for (const m of searchHits) {
            if (m.id && !targetMap.has(m.id)) {
              targetMap.set(m.id, m);
            }
          }
        }
      }

      // 2. Hijyenin ürettiği çelişki / inceleme adaylarını ekle
      if (this.Sage.listCandidates && targetMap.size < this.maxTargetMemories) {
        const candidates = await this.Sage.listCandidates(false);
        for (const c of candidates) {
          if (targetMap.size >= this.maxTargetMemories) break;
          if (c.memoryId && !targetMap.has(c.memoryId) && this.Sage.getSage) {
            const mem = await this.Sage.getSage(c.memoryId);
            if (mem?.id) {
              targetMap.set(mem.id, mem);
            }
          }
        }
      }

      // İncelemeye değer hiçbir aday hafıza bulunamadıysa 0 token harcayarak çık
      if (targetMap.size === 0) return;

      const candidatesBlock = [...targetMap.values()]
        .slice(0, this.maxTargetMemories)
        .map(formatCandidateRecord)
        .join('\n');

      const prompt = renderInstructionTemplate(
        readBundledInstructionText('llm/memory-curator.md'),
        {
          writtenFiles: writtenFiles.length > 0 ? writtenFiles.join(', ') : '(none)',
          summary: (result.finalText ?? '').slice(0, 800),
          candidates: candidatesBlock,
        },
      );

      // Phase 2: LLM Curation Call
      const _model = this.model ?? ctx.model;
      let text = '';

      if (this.oneShotOrchestrator) {
        const oneShotResult = await this.oneShotOrchestrator.call({
          system: prompt,
          userPrompt: 'Review candidate memories against session changes and return JSON operations.',
          model: _model ?? 'deepseek-chat',
          maxTokens: 400,
          timeoutMs: 10_000,
        });
        text = oneShotResult.text;
      } else if (provider?.complete) {
        const signal = AbortSignal.timeout(10_000);
        const response = await provider.complete(
          {
            model: _model,
            system: [{ type: 'text', text: prompt }],
            messages: [
              {
                role: 'user',
                content:
                  'Review candidate memories against session changes and return JSON operations.',
              },
            ],
            maxTokens: 400,
          },
          { signal },
        );
        text = response.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();
      }

      if (!text) return;

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const parsed: CuratorResponse = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed.operations) || parsed.operations.length === 0) return;

      // Phase 3: Operasyonları Güvenli Şekilde Uygula
      let supersededCount = 0;
      let mergedCount = 0;
      let splitCount = 0;
      let recalibratedCount = 0;

      for (const op of parsed.operations.slice(0, 15)) {
        try {
          if (!op || typeof op !== 'object') continue;

          if (op.action === 'supersede' && typeof op.targetId === 'string') {
            const target = targetMap.get(op.targetId);
            if (target?.persistence === 'permanent') continue; // permanent kararlar otomatik silinmez
            await this.Sage.updateSage(op.targetId, {
              status: 'superseded',
              ...(op.supersededBy ? { supersedes: [op.supersededBy] } : {}),
            });
            supersededCount++;
          } else if (op.action === 'contradict' && typeof op.targetId === 'string') {
            const target = targetMap.get(op.targetId);
            if (target?.persistence === 'permanent') continue;
            await this.Sage.updateSage(op.targetId, {
              status: 'contradicted',
              ...(op.contradictsWith ? { contradicts: [op.contradictsWith] } : {}),
            });
            supersededCount++;
          } else if (op.action === 'merge' && Array.isArray(op.targetIds) && op.text?.trim()) {
            // 1. Yeni birleştirilmiş hafızayı kaydet
            const remembered = (await this.Sage.rememberSage({
              text: op.text.trim(),
              kind: toSageKind(op.type),
              importance: importanceFromPriority(op.priority),
              confidence: typeof op.confidence === 'number' ? op.confidence : 0.85,
              tags: op.tags,
              anchors: op.anchors,
              persistence: 'long_lived',
              supersedes: op.targetIds,
              sources: [{ type: 'session', sessionId: ctx.session.id }],
            })) as { id?: string } | undefined;

            const newId = remembered?.id;

            // 2. Birleştirilen eski hafızaları superseded olarak işaretle
            for (const oldId of op.targetIds) {
              const old = targetMap.get(oldId);
              if (old?.persistence !== 'permanent') {
                await this.Sage.updateSage(oldId, {
                  status: 'superseded',
                  ...(newId ? { supersedes: [newId] } : {}),
                });
              }
            }
            mergedCount++;
          } else if (op.action === 'split' && typeof op.targetId === 'string' && Array.isArray(op.items)) {
            // 1. Her bir bölünmüş parçayı kaydet
            for (const item of op.items.slice(0, 4)) {
              if (!item.text?.trim()) continue;
              await this.Sage.rememberSage({
                text: item.text.trim(),
                kind: toSageKind(item.type),
                importance: importanceFromPriority(item.priority),
                confidence: typeof item.confidence === 'number' ? item.confidence : 0.85,
                tags: item.tags,
                anchors: item.anchors,
                persistence: 'long_lived',
                supersedes: [op.targetId],
                sources: [{ type: 'session', sessionId: ctx.session.id }],
              });
            }

            // 2. Orijinal geniş kaydı superseded yap
            const target = targetMap.get(op.targetId);
            if (target?.persistence !== 'permanent') {
              await this.Sage.updateSage(op.targetId, { status: 'superseded' });
            }
            splitCount++;
          } else if (op.action === 'recalibrate' && typeof op.targetId === 'string') {
            const patch: Partial<CuratorSageRecord> = {};
            if (typeof op.importance === 'number') patch.importance = Math.max(0, Math.min(1, op.importance));
            if (typeof op.confidence === 'number') patch.confidence = Math.max(0, Math.min(1, op.confidence));
            if (typeof op.freshness === 'number') patch.freshness = Math.max(0, Math.min(1, op.freshness));
            if (typeof op.status === 'string' && ['active', 'stale', 'archived'].includes(op.status)) {
              const target = targetMap.get(op.targetId);
              if (target?.persistence !== 'permanent' || op.status === 'active') {
                patch.status = op.status;
              }
            }
            if (Object.keys(patch).length > 0) {
              await this.Sage.updateSage(op.targetId, patch);
              recalibratedCount++;
            }
          }
        } catch {
          // Bireysel işlem hataları sonraki operasyonları engellememeli
        }
      }

      if (supersededCount > 0 || mergedCount > 0 || splitCount > 0 || recalibratedCount > 0) {
        process.stderr.write(
          `[memory] Session curation: ${supersededCount} superseded, ${mergedCount} merged, ${splitCount} split, ${recalibratedCount} recalibrated\n`,
        );
      }
    } catch {
      // Best effort: Curation asla ana agent akışını durdurmaz
    }
  };
}
