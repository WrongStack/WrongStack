import type { ContentBlock, ToolUseBlock } from '../types/blocks.js';
import { isTextBlock, isToolUseBlock } from '../types/blocks.js';
import type { AgentInternals } from './agent-internals.js';
import { resolveEventSessionId } from './context.js';

export function iterationFingerprint(blocks: ContentBlock[]): string {
  const toolUses = blocks.filter(isToolUseBlock);
  const texts = blocks.filter(isTextBlock);

  const toolNameSet = Array.from(new Set(toolUses.map((u) => u.name))).sort();
  const firstInputHash = toolUses[0] ? hashSmall(stableStringify(toolUses[0].input ?? {})) : '';
  const textBlob = texts
    .map((t) => t.text)
    .join('')
    .slice(0, 512);

  const hasContent = toolNameSet.length > 0 || textBlob.length > 0;
  if (!hasContent) return '__empty__';

  return [`tools=${toolNameSet.join('+') || '-'}`, `in0=${firstInputHash}`, `txt=${textBlob}`].join(
    '\n',
  );
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = canonicalize(src[k]);
    return out;
  }
  return value;
}

export function hashSmall(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

export interface LoopDetectorResult {
  action: 'none' | 'steer' | 'cut';
  cutSummary?: string;
  steerMessage?: string;
}

export class AgentLoopDetector {
  private lastToolSignature = '';
  private toolLoopCount = 0;
  private iterationSteerDone = false;
  private readonly recentCallKeys: string[] = [];
  private readonly steeredCallKeys = new Set<string>();

  constructor(private readonly a: AgentInternals) {}

  checkIteration(
    iterationIndex: number,
    content: ContentBlock[],
    toolUses: ToolUseBlock[],
    queueSteer: (text: string) => void,
  ): { cut: boolean; cutSummary?: string } {
    const loopCfg = this.a.loopDetection;
    if (loopCfg.mode === 'off') return { cut: false };

    const sig = iterationFingerprint(content);
    if (sig !== '__empty__') {
      if (sig === this.lastToolSignature) {
        this.toolLoopCount++;
      } else {
        this.lastToolSignature = sig;
        this.toolLoopCount = 1;
        this.iterationSteerDone = false;
      }

      const names = toolUses.map((t) => t.name).join(', ');
      const hasText = content.some(isTextBlock);
      const kind: 'tool' | 'message' | 'mixed' =
        toolUses.length > 0 && hasText ? 'mixed' : toolUses.length > 0 ? 'tool' : 'message';
      const observationRepeat =
        loopCfg.mode === 'steer-then-cut' &&
        toolUses.length > 0 &&
        toolUses.every((use) => {
          const tool = this.a.tools.get(use.name);
          return (
            tool?.mutating === false &&
            (tool.riskTier === 'safe' || (tool.capabilities?.length ?? 0) > 0)
          );
        });
      const repeatMultiplier = observationRepeat ? 2 : 1;
      const detail =
        kind === 'tool'
          ? `"${names}" called with effectively identical inputs ${this.toolLoopCount} times in a row`
          : kind === 'mixed'
            ? `"${names}" + same text repeated ${this.toolLoopCount} times in a row`
            : `same assistant text repeated ${this.toolLoopCount} times in a row`;

      const cutAt =
        (loopCfg.mode === 'cut' ? loopCfg.steerThreshold : loopCfg.cutThreshold) * repeatMultiplier;
      if (this.toolLoopCount >= cutAt) {
        this.a.logger.warn(`Loop detected: ${detail} — stopping to prevent infinite loop.`);
        this.a.events.emit('tool.loop_detected', {
          sessionId: resolveEventSessionId(this.a.ctx),
          ctx: this.a.ctx,
          tools: names,
          repeatCount: this.toolLoopCount,
          iteration: iterationIndex,
          kind,
          action: 'cut',
          scope: 'iteration',
        });
        const summary =
          kind === 'message'
            ? `[Loop detected: same assistant message repeated ${this.toolLoopCount}× — stopping to prevent infinite repetition.]`
            : `[Loop detected: ${detail} — stopping to prevent infinite repetition.]`;
        return { cut: true, cutSummary: summary };
      }

      if (
        loopCfg.mode === 'steer-then-cut' &&
        this.toolLoopCount >= loopCfg.steerThreshold * repeatMultiplier &&
        !this.iterationSteerDone
      ) {
        this.iterationSteerDone = true;
        this.a.logger.warn(`Loop detected: ${detail} — steering the model to change approach.`);
        this.a.events.emit('tool.loop_detected', {
          sessionId: resolveEventSessionId(this.a.ctx),
          ctx: this.a.ctx,
          tools: names,
          repeatCount: this.toolLoopCount,
          iteration: iterationIndex,
          kind,
          action: 'steer',
          scope: 'iteration',
        });
        queueSteer(
          `[loop-detector] Your last ${this.toolLoopCount} responses were effectively identical (${detail}). ` +
            'This approach is not working. Change strategy: use a different tool, different arguments, ' +
            'or a different plan — or explain what is blocking you and stop. ' +
            `Repeating the same response ${cutAt - this.toolLoopCount} more time(s) will terminate the turn.`,
        );
      }
    } else {
      this.lastToolSignature = '';
      this.toolLoopCount = 0;
      this.iterationSteerDone = false;
    }

    if (loopCfg.mode === 'steer-then-cut') {
      for (const u of toolUses) {
        const key = `${u.name}:${hashSmall(stableStringify(u.input ?? {}))}`;
        this.recentCallKeys.push(key);
        if (this.recentCallKeys.length > loopCfg.windowSize) this.recentCallKeys.shift();
        if (this.steeredCallKeys.has(key)) continue;
        let count = 0;
        for (const k of this.recentCallKeys) if (k === key) count++;
        const tool = this.a.tools.get(u.name);
        const observationThreshold =
          tool?.mutating === false &&
          (tool.riskTier === 'safe' || (tool.capabilities?.length ?? 0) > 0)
            ? loopCfg.callRepeatThreshold * 2
            : loopCfg.callRepeatThreshold;
        if (count < observationThreshold) continue;
        this.steeredCallKeys.add(key);
        const preview = JSON.stringify(u.input ?? {}).slice(0, 160);
        this.a.logger.warn(
          `Loop detected: "${u.name}" called with identical arguments ${count}× within the last ${loopCfg.windowSize} tool calls — steering the model to change approach.`,
        );
        this.a.events.emit('tool.loop_detected', {
          sessionId: resolveEventSessionId(this.a.ctx),
          ctx: this.a.ctx,
          tools: u.name,
          repeatCount: count,
          iteration: iterationIndex,
          kind: 'tool',
          action: 'steer',
          scope: 'call',
        });
        queueSteer(
          `[loop-detector] You have called ${u.name}(${preview}) ${count} times with identical arguments ` +
            `within the last ${loopCfg.windowSize} tool calls. The result will not change. Do not repeat ` +
            'this call — use what you already know, try a different approach, or explain the blocker.',
        );
      }
    }

    return { cut: false };
  }
}
