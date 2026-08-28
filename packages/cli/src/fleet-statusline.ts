/**
 * Live fleet status line for the plain (non-TUI) REPL and single-shot modes.
 *
 * The TUI already renders a rich per-agent 4th line; the plain terminal had
 * nothing live while subagents ran. This reserves the bottom terminal row via
 * a DECSTBM scroll region (`\x1b[1;{rows-1}r`) so normal streamed output keeps
 * scrolling in the region above while a continuously-updated status line stays
 * pinned to the bottom. It activates only when ≥1 subagent is running on a TTY,
 * and fully restores the scroll region when the fleet goes idle or on dispose.
 *
 * State is fed entirely by host EventBus events (the coordinator + the
 * multi-agent factory bridge both emit onto the host bus):
 *   subagent.spawned / task_started / tool_executed / iteration_summary /
 *   task_completed.
 */

import type { EventBus } from '@wrongstack/core/kernel';
import { color, onResize } from '@wrongstack/core/utils';

export interface FleetAgentState {
  id: string;
  name: string;
  status: 'running' | 'done' | 'failed';
  iterations: number;
  toolCalls: number;
  lastTool?: string | undefined;
  startedAt: number;
  endedAt?: number | undefined;
  /** Cumulative budget auto-extensions — rendered as a "⚡N" suffix. */
  extensions?: number | undefined;
}

interface FleetStatusLineOptions {
  events: EventBus;
  out?: NodeJS.WriteStream | undefined;
  /** Minimum ms between repaints. Default 150. */
  throttleMs?: number | undefined;
  /** Inject a clock for tests. */
  now?: (() => number) | undefined;
  /** App version (e.g. "0.7.0") prefixed as a `WS v…` chip on the pinned line. */
  version?: string | undefined;
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m${rem.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${(m % 60).toString().padStart(2, '0')}m`;
}

/**
 * Pure formatter — turns the agent map into a single status string. Exposed
 * for testing; contains no ANSI cursor movement, only color codes + the width
 * cap. Returns '' when there is nothing worth showing.
 */
export function renderFleetLine(
  states: Map<string, FleetAgentState>,
  now: number,
  columns: number,
  version?: string | undefined,
): string {
  const all = [...states.values()];
  if (all.length === 0) return '';
  const running = all.filter((a) => a.status === 'running');
  const done = all.filter((a) => a.status === 'done').length;
  const failed = all.filter((a) => a.status === 'failed').length;

  const versionChip = version
    ? `${color.bold('WS')}${color.dim(` v${version}`)} ${color.dim('│')} `
    : '';
  const counts =
    versionChip +
    `${color.cyan('⟳ fleet')} ` +
    `${color.yellow(`▶${running.length}`)} ` +
    `${color.green(`✓${done}`)}` +
    (failed > 0 ? ` ${color.red(`✗${failed}`)}` : '');

  // Show running agents first (most relevant), newest activity first.
  const shown = running
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(0, 4)
    .map((a) => {
      const elapsed = fmtElapsed(Math.max(0, now - a.startedAt));
      const tool = a.lastTool ? ` ${color.dim(a.lastTool)}` : '';
      const ext = a.extensions && a.extensions > 0 ? ` ${color.yellow(`⚡${a.extensions}`)}` : '';
      return (
        `${color.bold(a.name)} ` +
        `${color.yellow('▶')} ${color.dim(elapsed)} ` +
        `${color.dim(`L${a.iterations}`)} ${color.dim(`${a.toolCalls}t`)}${tool}${ext}`
      );
    });

  let line =
    shown.length > 0 ? `${counts} ${color.dim('│')} ${shown.join(color.dim('  ·  '))}` : counts;

  // Hard cap to terminal width so the line never wraps and corrupts the
  // scroll region. Strip-aware truncation isn't worth it here — cap on the
  // raw length minus a safety margin; ANSI codes are short and the margin
  // absorbs them.
  const max = Math.max(20, columns - 1);
  // Rough visible-length guard: count only non-ANSI chars.
  const visible = line.replace(/\x1b\[[0-9;]*m/g, '');
  if (visible.length > max) {
    // Re-truncate the visible portion; rebuild without trailing partial codes.
    let count = 0;
    const out: string[] = [];
    let i = 0;
    while (i < line.length && count < max - 1) {
      if (line[i] === '\x1b') {
        const end = line.indexOf('m', i);
        if (end !== -1) {
          out.push(line.slice(i, end + 1));
          i = end + 1;
          continue;
        }
      }
      if (line[i] !== undefined) out.push(line[i]!);
      count++;
      i++;
    }
    line = out.join('') + '…';
  }
  return line;
}

export class FleetStatusLine {
  private readonly events: EventBus;
  private readonly out: NodeJS.WriteStream;
  private readonly throttleMs: number;
  private readonly now: () => number;
  private readonly version?: string | undefined;
  private readonly states = new Map<string, FleetAgentState>();
  private readonly unsubs: Array<() => void> = [];
  private active = false;
  private rows = 0;
  private repaintTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private deactivateTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeCleanup: (() => void) | null = null;
  private lastPaint = 0;
  private readonly onResize = () => {
    if (this.active) {
      this.rows = this.out.rows ?? 24;
      this.out.write(`\x1b[1;${this.rows - 1}r`);
      this.paint(true);
    }
  };

  constructor(opts: FleetStatusLineOptions) {
    this.events = opts.events;
    this.out = opts.out ?? process.stdout;
    this.throttleMs = opts.throttleMs ?? 150;
    this.now = opts.now ?? Date.now;
    this.version = opts.version;
  }

  /** Subscribe to host fleet events. No terminal output until a subagent spawns. */
  start(): void {
    const ensure = (id: string, name?: string): FleetAgentState => {
      let s = this.states.get(id);
      if (!s) {
        s = {
          id,
          name: name ?? id,
          status: 'running',
          iterations: 0,
          toolCalls: 0,
          startedAt: this.now(),
        };
        this.states.set(id, s);
      } else if (name && s.name === s.id) {
        s.name = name;
      }
      return s;
    };

    this.unsubs.push(
      this.events.on('subagent.spawned', (e) => {
        ensure(e.subagentId, e.name);
        this.activate();
        this.schedulePaint();
      }),
      this.events.on('subagent.task_started', (e) => {
        const s = ensure(e.subagentId);
        s.status = 'running';
        this.activate();
        this.schedulePaint();
      }),
      this.events.on('subagent.tool_executed', (e) => {
        const s = ensure(e.subagentId);
        s.toolCalls++;
        s.lastTool = e.name;
        this.activate();
        this.schedulePaint();
      }),
      this.events.on('subagent.iteration_summary', (e) => {
        const s = ensure(e.subagentId);
        s.iterations = e.iteration;
        if (typeof e.toolCalls === 'number') s.toolCalls = e.toolCalls;
        if (e.currentTool) s.lastTool = e.currentTool;
        this.schedulePaint();
      }),
      this.events.on('subagent.budget_extended', (e) => {
        const s = ensure(e.subagentId);
        s.extensions = e.totalExtensions;
        this.activate();
        this.schedulePaint();
      }),
      this.events.on('subagent.task_completed', (e) => {
        const s = ensure(e.subagentId);
        s.status = e.status === 'success' ? 'done' : 'failed';
        s.iterations = e.iterations;
        s.toolCalls = e.toolCalls;
        s.endedAt = this.now();
        this.schedulePaint();
        // When nothing is running anymore, retract the status line.
        if (![...this.states.values()].some((a) => a.status === 'running')) {
          // Small delay so the final ✓/✗ counts are visible briefly.
          if (this.deactivateTimer) clearTimeout(this.deactivateTimer);
          this.deactivateTimer = setTimeout(() => {
            this.deactivateTimer = null;
            if (![...this.states.values()].some((a) => a.status === 'running')) {
              this.deactivate();
            }
          }, 800);
        }
      }),
      this.events.on('subagent.removed', (e) => {
        // Drop terminal-state entries so a long-running REPL doesn't keep one
        // entry per retired subagent for the process lifetime (RAM-leak audit
        // 2026-07-31, LOW). Mirrors `cli/src/fleet/status-broadcast.ts`.
        this.states.delete(e.subagentId);
        this.schedulePaint();
      }),
    );
  }

  /** Unsubscribe and restore the terminal. Idempotent. */
  stop(): void {
    for (const u of this.unsubs.splice(0)) u();
    this.deactivate();
  }

  private isTty(): boolean {
    return !!this.out.isTTY;
  }

  private activate(): void {
    if (this.active || !this.isTty()) return;
    this.active = true;
    this.rows = this.out.rows ?? 24;
    // Make room for the reserved row, then carve out the scroll region.
    this.out.write('\n');
    this.out.write(`\x1b[1;${this.rows - 1}r`);
    this.out.write(`\x1b[${this.rows - 1};1H`);
    this.resizeCleanup = onResize(() => this.onResize(), this.out);
    this.tickTimer = setInterval(() => this.paint(true), 1000);
    if (this.tickTimer.unref) this.tickTimer.unref();
    this.paint(true);
  }

  private deactivate(): void {
    if (!this.active) return;
    this.active = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.repaintTimer) {
      clearTimeout(this.repaintTimer);
      this.repaintTimer = null;
    }
    if (this.deactivateTimer) {
      clearTimeout(this.deactivateTimer);
      this.deactivateTimer = null;
    }
    this.resizeCleanup?.();
    this.resizeCleanup = null;
    if (this.isTty()) {
      // Clear the reserved line and reset the scroll region to full screen.
      this.out.write('\x1b7');
      this.out.write(`\x1b[${this.rows};1H`);
      this.out.write('\x1b[2K');
      this.out.write('\x1b8');
      this.out.write('\x1b[r');
    }
  }

  private schedulePaint(): void {
    if (!this.active) return;
    const since = this.now() - this.lastPaint;
    if (since >= this.throttleMs) {
      this.paint(false);
      return;
    }
    if (this.repaintTimer) return;
    this.repaintTimer = setTimeout(() => {
      this.repaintTimer = null;
      this.paint(false);
    }, this.throttleMs - since);
    if (this.repaintTimer.unref) this.repaintTimer.unref();
  }

  private paint(force: boolean): void {
    if (!this.active || !this.isTty()) return;
    if (!force) this.lastPaint = this.now();
    else this.lastPaint = this.now();
    const line = renderFleetLine(this.states, this.now(), this.out.columns ?? 80, this.version);
    this.out.write('\x1b7'); // save cursor
    this.out.write(`\x1b[${this.rows};1H`); // last row
    this.out.write('\x1b[2K'); // clear
    this.out.write(line);
    this.out.write('\x1b8'); // restore cursor
  }
}
