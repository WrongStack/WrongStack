/**
 * Design turn gate — a UI change is not "done" until it was inspected rendered.
 *
 * The skills ask the model to run `design_reference {action:"inspect"}` after
 * changing UI and to fix every FAIL. Prose can be skipped; this gate cannot.
 * A toolCall middleware records, per run, which frontend files were written
 * and what the latest inspect reported. When the model then tries to end the
 * turn, the `beforeTurnEnd` extension holds it with a steer if:
 *
 *   - UI files changed after the last inspect (or none ran), or
 *   - the last inspect still reported FAILs.
 *
 * It only acts when it can act honestly: the inspect tool must be available
 * to this agent, and there must be something to inspect — a served URL from
 * `.design/gate.json` or an earlier inspect, or else a static `.html` page
 * the run wrote, which the inspect tool serves itself (`file`). Without any
 * target it stays silent rather than demanding a check nobody can run. The
 * agent loop caps how often a run can be held, so an unfixable FAIL cannot
 * trap a turn.
 *
 * `.design/gate.json` (local, self-ignored): `{ "mode": "on" | "off", "url": "http://localhost:5173/" }`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Middleware } from '@wrongstack/contracts/kernel/pipeline';
import type { AgentExtension } from '@wrongstack/contracts/types/extension-points';
import type { ToolCallPipelinePayload } from '../core/agent-types.js';
import type { Context } from '../core/context.js';
import { detectFrontendFile } from './design-detect.js';
import { designProjectDir } from './design-project-store.js';

const DESIGN_INSPECT_TOOL = 'design_reference';
const STATE_KEY = 'designTurnGate';
const WRITE_TOOLS = new Set(['write', 'edit', 'replace', 'patch']);

export interface DesignGateState {
  /** Frontend files written this run, in order, without repeats. */
  writes: string[];
  /** Event counter; a write after the last inspect has a higher number. */
  seq: number;
  lastWriteSeq: number;
  /** Survives runs: the page the model inspected (url or project file) stays known. */
  lastInspect?:
    | {
        url?: string | undefined;
        file?: string | undefined;
        fails: number;
        warns: number;
        seq: number;
      }
    | undefined;
}

export interface DesignGateConfig {
  mode: 'on' | 'off';
  url?: string | undefined;
}

function stateOf(ctx: Context): DesignGateState {
  const existing = ctx.meta[STATE_KEY] as DesignGateState | undefined;
  if (existing) return existing;
  const fresh: DesignGateState = { writes: [], seq: 0, lastWriteSeq: 0 };
  ctx.meta[STATE_KEY] = fresh;
  return fresh;
}

/** `· 3 FAIL · 5 WARN` from the inspect report header; null when absent. */
function parseInspectCounts(text: string): { fails: number; warns: number } | null {
  const m = /(\d+) FAIL · (\d+) WARN/.exec(text);
  return m ? { fails: Number(m[1]), warns: Number(m[2]) } : null;
}

/** Records frontend writes and inspect results for the turn gate. */
function makeDesignGateToolCallMiddleware(): Middleware<ToolCallPipelinePayload> {
  return {
    name: 'DesignTurnGateRecorder',
    owner: 'core',
    async handler(payload, next) {
      const out = await next(payload);
      try {
        const name = out.toolUse?.name;
        if (!name || out.result?.is_error) return out;
        const input = (out.toolUse.input ?? {}) as Record<string, unknown>;
        if (WRITE_TOOLS.has(name)) {
          const p = typeof input.path === 'string' ? input.path : '';
          if (!p || !detectFrontendFile(p, out.ctx.projectRoot)) return out;
          const state = stateOf(out.ctx);
          state.lastWriteSeq = ++state.seq;
          if (!state.writes.includes(p)) state.writes.push(p);
        } else if (name === DESIGN_INSPECT_TOOL && input.action === 'inspect') {
          const counts = parseInspectCounts(String(out.result?.content ?? ''));
          const url = typeof input.url === 'string' ? input.url : undefined;
          const file = typeof input.file === 'string' ? input.file : undefined;
          if (!counts || (!url && !file)) return out;
          const state = stateOf(out.ctx);
          state.lastInspect = { url, file, ...counts, seq: ++state.seq };
        }
      } catch {
        // Recording is best-effort; a failure must never break the tool call.
      }
      return out;
    },
  };
}

async function readDesignGateConfig(projectRoot: string): Promise<DesignGateConfig> {
  try {
    const raw = JSON.parse(
      (await fs.readFile(path.join(designProjectDir(projectRoot), 'gate.json'), 'utf8')).replace(
        /^﻿/,
        '',
      ),
    ) as { mode?: unknown; url?: unknown };
    return {
      mode: raw.mode === 'off' ? 'off' : 'on',
      url: typeof raw.url === 'string' && /^https?:\/\//.test(raw.url) ? raw.url : undefined,
    };
  } catch {
    return { mode: 'on' };
  }
}

/**
 * The steer for a turn that tries to end, or undefined to let it end.
 * Pure: the extension supplies state, config and tool availability.
 */
function designGateSteer(
  state: DesignGateState | undefined,
  config: DesignGateConfig,
  inspectAvailable: boolean,
  projectRoot: string,
): string | undefined {
  if (config.mode === 'off' || !inspectAvailable || !state || state.writes.length === 0) {
    return undefined;
  }
  // A served URL wins; else the page inspected before; else a static page this
  // run wrote, which the inspect tool can serve from the project itself.
  const writtenPage = state.writes.find((p) => /\.html?$/i.test(p));
  const pageFile = writtenPage
    ? path.isAbsolute(writtenPage)
      ? path.relative(projectRoot, writtenPage).replace(/\\/g, '/')
      : writtenPage
    : undefined;
  const target = config.url
    ? { key: 'url', value: config.url }
    : state.lastInspect?.url
      ? { key: 'url', value: state.lastInspect.url }
      : (state.lastInspect?.file ?? pageFile)
        ? { key: 'file', value: (state.lastInspect?.file ?? pageFile) as string }
        : undefined;
  if (!target || target.value.startsWith('..')) return undefined;
  const url = target.value;
  const files = state.writes.slice(0, 6).join(', ') + (state.writes.length > 6 ? ', …' : '');
  const call = `${DESIGN_INSPECT_TOOL} {action:"inspect", ${target.key}:"${url}"}`;
  const stale = !state.lastInspect || state.lastInspect.seq < state.lastWriteSeq;
  if (stale) {
    return (
      `[design-gate] You changed UI file(s) (${files}) after the last rendered inspection. ` +
      `Run \`${call}\` and fix every FAIL before finishing.` +
      (target.key === 'url'
        ? ' If that page is not being served right now, say so in your answer and list the ' +
          'checks that remain unverified.'
        : ' The tool serves the file itself; no dev server is needed.')
    );
  }
  if ((state.lastInspect?.fails ?? 0) > 0) {
    return (
      `[design-gate] The last inspect of ${url} still reports ${state.lastInspect?.fails} FAIL. ` +
      `Fix them and re-run \`${call}\`. If a FAIL cannot be fixed in this task, say which and why in your answer.`
    );
  }
  return undefined;
}

/**
 * The extension that holds a turn while its UI changes are uninspected or
 * failing. `hasTool` answers whether this agent can call the inspect tool
 * (restricted mode and network-less subagents cannot, so the gate stays off).
 */
function createDesignTurnGateExtension(deps: {
  hasTool: (name: string) => boolean;
}): AgentExtension {
  return {
    name: 'design-turn-gate',
    owner: 'core',
    beforeRun(ctx) {
      // Writes are judged per run; the inspected URL stays known.
      const state = ctx.meta[STATE_KEY] as DesignGateState | undefined;
      if (state) state.writes = [];
    },
    async beforeTurnEnd(ctx) {
      const state = ctx.meta[STATE_KEY] as DesignGateState | undefined;
      if (!state || state.writes.length === 0) return undefined;
      const config = await readDesignGateConfig(ctx.projectRoot);
      return designGateSteer(state, config, deps.hasTool(DESIGN_INSPECT_TOOL), ctx.projectRoot);
    },
  };
}

/**
 * Install the recorder middleware and the turn-end extension on one agent.
 * The recorder only observes results, so it is appended: prepending it would
 * push it ahead of a host-owned tool boundary installed earlier.
 */
export function installDesignTurnGate(deps: {
  pipelines: { toolCall: { use(mw: Middleware<ToolCallPipelinePayload>): unknown } };
  extensions: { register(ext: AgentExtension): unknown };
  hasTool: (name: string) => boolean;
}): void {
  deps.pipelines.toolCall.use(makeDesignGateToolCallMiddleware());
  deps.extensions.register(createDesignTurnGateExtension({ hasTool: deps.hasTool }));
}
