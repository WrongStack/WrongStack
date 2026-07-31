import type { EventBus } from '@wrongstack/core/kernel';
import type { TokenCounter } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import type { TerminalRenderer } from './renderer.js';
import { fmtTok } from './utils.js';

interface ToolStat {
  ok: number;
  fail: number;
  totalMs: number;
}

/**
 * Hard cap on the per-session "which paths were touched" Sets. Past this,
 * older paths are evicted so a session that sweeps a huge repo cannot push
 * the closure's RAM linearly with the number of distinct files. The cap
 * is generous — most sessions touch a small fraction — but bounded.
 * RAM-leak audit 2026-07-31, LOW.
 */
const SESSION_STATS_MAX_PATHS = 10_000;

/**
 * Add `path` to a bounded Set, evicting the oldest entry past the cap.
 * Set preserves insertion order, so the first iterator value is the oldest.
 */
function addBoundedPath(set: Set<string>, path: string): void {
  if (set.has(path)) return;
  if (set.size >= SESSION_STATS_MAX_PATHS) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(path);
}

/**
 * Accumulates per-session stats by listening to EventBus events. Designed
 * to be created once in main(), live for the whole CLI invocation (single-shot
 * or REPL), and produce the closing report when asked.
 *
 * Cost is intentionally not tracked here — TokenCounter is the authority.
 */
export class SessionStats {
  private readonly tokenCounter: TokenCounter;
  private readonly startedAt = Date.now();

  private apiRequests = 0;
  private iterations = 0;
  private errors = 0;

  private readonly toolStats = new Map<string, ToolStat>();
  private readonly readPaths = new Set<string>();
  private readonly editedPaths = new Set<string>();
  private readonly writtenPaths = new Set<string>();
  private bytesWritten = 0;
  private bashCommands = 0;
  private fetches = 0;

  // Stored handler refs so destroy() can remove them.
  private readonly _handlers: Array<{ event: string; handler: (e: unknown) => void }> = [];

  constructor(events: EventBus, tokenCounter: TokenCounter) {
    this.tokenCounter = tokenCounter;

    const onResponse = () => {
      this.apiRequests++;
    };
    const onIteration = () => {
      this.iterations++;
    };
    const onError = () => {
      this.errors++;
    };
    const onTool = (e: unknown) => {
      const tool = e as {
        name: string;
        ok: boolean;
        durationMs: number;
        input?: Record<string, unknown>;
      };
      const slot = this.toolStats.get(tool.name) ?? { ok: 0, fail: 0, totalMs: 0 };
      if (tool.ok) slot.ok++;
      else slot.fail++;
      slot.totalMs += tool.durationMs;
      this.toolStats.set(tool.name, slot);

      const input = tool.input;
      if (tool.name === 'bash') this.bashCommands++;
      else if (tool.name === 'fetch') this.fetches++;

      if (!tool.ok) return;
      const path = typeof input?.path === 'string' ? input.path : undefined;
      if (tool.name === 'read' && path) addBoundedPath(this.readPaths, path);
      else if (tool.name === 'edit' && path) addBoundedPath(this.editedPaths, path);
      else if (tool.name === 'write' && path) {
        addBoundedPath(this.writtenPaths, path);
        const content = typeof input?.content === 'string' ? input.content : '';
        this.bytesWritten += Buffer.byteLength(content, 'utf8');
      }
    };

    events.on('provider.response', onResponse);
    events.on('iteration.completed', onIteration);
    events.on('error', onError);
    events.on('tool.executed', onTool);

    this._handlers.push(
      { event: 'provider.response', handler: onResponse },
      { event: 'iteration.completed', handler: onIteration },
      { event: 'error', handler: onError },
      { event: 'tool.executed', handler: onTool },
    );
  }

  /** Remove all event listeners. Call this when the session ends. */
  destroy(events: EventBus): void {
    for (const { event, handler } of this._handlers) {
      // event is a string literal known to be a valid EventName — safe cast
      (events.off as (e: string, h: (...args: unknown[]) => void) => void)(event, handler);
    }
    this._handlers.length = 0;
  }

  hasActivity(): boolean {
    return (
      this.apiRequests > 0 ||
      this.iterations > 0 ||
      this.toolStats.size > 0 ||
      this.tokenCounter.total().input > 0
    );
  }

  /**
   * Build the report string. Returns null when there's no recorded
   * activity yet — caller decides whether to emit a placeholder or stay
   * silent. Splitting `format()` out of `render()` lets the TUI's slash
   * dispatcher take the string and turn it into a history entry, while
   * REPL keeps the old direct-write path.
   */
  format(): string | null {
    if (!this.hasActivity()) return null;
    const u = this.tokenCounter.total();
    const cost = this.tokenCounter.estimateCost();
    const elapsedSec = ((Date.now() - this.startedAt) / 1000).toFixed(1);

    const lines: string[] = [];
    lines.push('');
    lines.push(color.bold('Session report'));
    lines.push(color.dim('─'.repeat(40)));
    lines.push(`  Elapsed:       ${elapsedSec}s`);
    lines.push(`  Iterations:    ${this.iterations}`);
    lines.push(`  API requests:  ${this.apiRequests}`);
    if (this.errors > 0) {
      lines.push(`  Errors:        ${color.yellow(String(this.errors))}`);
    }
    lines.push('');
    lines.push(
      `  Tokens:        in ${fmtTok(u.input)}   out ${fmtTok(u.output)}${u.cacheRead ? `   cacheR ${fmtTok(u.cacheRead)}` : ''}${u.cacheWrite ? `   cacheW ${fmtTok(u.cacheWrite)}` : ''}`,
    );
    const cache = this.tokenCounter.cacheStats();
    if (cache.readTokens > 0 || cache.writeTokens > 0) {
      const pct = (cache.hitRatio * 100).toFixed(1);
      lines.push(
        `  Prompt cache:  ${pct}% hit  ${color.dim(`(${fmtTok(cache.readTokens)} read / ${fmtTok(cache.writeTokens)} write)`)}`,
      );
    }
    if (cost.total > 0) {
      lines.push(
        `  Cost:          $${cost.total.toFixed(4)}${color.dim(` (in $${cost.input.toFixed(4)} / out $${cost.output.toFixed(4)})`)}`,
      );
    } else {
      lines.push(`  Cost:          ${color.dim('$0 (no pricing on this plan)')}`);
    }

    if (this.toolStats.size > 0) {
      lines.push('');
      lines.push(`  ${color.bold('Tool calls')}`);
      const sorted = [...this.toolStats.entries()].sort(
        (a, b) => b[1].ok + b[1].fail - (a[1].ok + a[1].fail),
      );
      for (const [name, s] of sorted) {
        const total = s.ok + s.fail;
        const failPart = s.fail > 0 ? color.yellow(` (${s.fail} failed)`) : '';
        const avgMs = total > 0 ? Math.round(s.totalMs / total) : 0;
        lines.push(
          `    ${name.padEnd(12)} ${String(total).padStart(3)}×   ${color.dim(`avg ${avgMs}ms`)}${failPart}`,
        );
      }
    }

    const fileActivity =
      this.readPaths.size > 0 ||
      this.editedPaths.size > 0 ||
      this.writtenPaths.size > 0 ||
      this.bytesWritten > 0;
    if (fileActivity) {
      lines.push('');
      lines.push(`  ${color.bold('Files')}`);
      if (this.readPaths.size > 0)
        lines.push(
          `    read:    ${this.readPaths.size}  ${color.dim(samplePaths(this.readPaths))}`,
        );
      if (this.editedPaths.size > 0)
        lines.push(
          `    edited:  ${this.editedPaths.size}  ${color.dim(samplePaths(this.editedPaths))}`,
        );
      if (this.writtenPaths.size > 0) {
        const bytes = this.bytesWritten;
        const byteStr = bytes > 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
        lines.push(
          `    written: ${this.writtenPaths.size}  (${byteStr})  ${color.dim(samplePaths(this.writtenPaths))}`,
        );
      }
    }

    if (this.bashCommands > 0 || this.fetches > 0) {
      lines.push('');
      if (this.bashCommands > 0) lines.push(`  Shell commands:  ${this.bashCommands}`);
      if (this.fetches > 0) lines.push(`  Web fetches:     ${this.fetches}`);
    }

    lines.push('');
    return lines.join('\n');
  }

  render(renderer: TerminalRenderer): void {
    const text = this.format();
    if (text === null) return;
    renderer.write(`${text}\n`);
  }
}

function samplePaths(set: Set<string>): string {
  const arr = [...set];
  if (arr.length <= 2) return arr.join(', ');
  return `${arr[0]}, … (+${arr.length - 1} more)`;
}
