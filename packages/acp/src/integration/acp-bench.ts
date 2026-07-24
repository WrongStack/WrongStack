/**
 * ACP client bench — end-to-end verification of installed ACP agents.
 *
 * Unlike `probeAcpAgent` (which only runs the `initialize` handshake), the
 * bench drives each agent through a real, deterministic turn and grades it:
 *
 *   1. handshake — spawn + `initialize` succeeds (captures agentInfo)
 *   2. prompt    — `session/new` + `session/prompt` returns with text
 *   3. marker    — the agent followed a trivial instruction (echo a token)
 *   4. fs (opt)  — the agent read a file from the client's sandboxed FS,
 *                  exercising the `fs/read_text_file` callback channel
 *
 * Grade: pass (all required checks), partial (handshake ok but degraded),
 * fail (couldn't even handshake). Each result carries per-check detail and
 * timings so the report is actionable: "claude-code: handshake ok but the
 * prompt timed out" vs "codex-cli: not installed".
 *
 * Pure orchestrator — no renderer dependency; `renderAcpBenchText` is the
 * default formatter. The CLI/slash layer supplies the command resolver
 * (so user overrides + the synced registry apply) and the agent set.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ACPSession, textContent } from '../client/acp-session.js';
import type { ACPSubagentRunnerOptions } from './acp-subagent-runner.js';

export type AcpBenchStatus = 'pass' | 'partial' | 'fail' | 'skipped';

export interface AcpBenchCheck {
  name: 'handshake' | 'prompt' | 'marker' | 'fs';
  ok: boolean;
  detail?: string | undefined;
}

export interface AcpBenchAgentResult {
  agentId: string;
  status: AcpBenchStatus;
  checks: AcpBenchCheck[];
  /** Agent metadata from the initialize handshake. */
  agentInfo?: { name: string; title?: string | undefined; version: string } | undefined;
  handshakeMs?: number | undefined;
  promptMs?: number | undefined;
  /** First line of the agent's reply (trimmed), for the report. */
  sample?: string | undefined;
  /** Why the agent failed / was skipped. */
  reason?: string | undefined;
  durationMs: number;
}

export interface AcpBenchResult {
  results: AcpBenchAgentResult[];
  summary: { pass: number; partial: number; fail: number; skipped: number };
  totalDurationMs: number;
}

/** Resolve an agent id to its spawn command (null = unknown). */
export type AcpBenchCmdResolver = (id: string) => ACPSubagentRunnerOptions | null;

export interface AcpBenchOptions {
  /** Agent ids to bench. */
  agentIds: string[];
  /** Resolve each id → spawn command (wire overrides + synced registry here). */
  resolveCmd: AcpBenchCmdResolver;
  /** FS sandbox + cwd for each agent. Defaults to `process.cwd()`. */
  projectRoot?: string | undefined;
  /** Per-agent hard timeout (handshake + each prompt). Default 60s. */
  timeoutMs?: number | undefined;
  /** Also verify the `fs/read_text_file` callback channel. Default false. */
  checkFs?: boolean | undefined;
  /** Max agents benched concurrently. Default 2 (each runs a real LLM turn). */
  concurrency?: number | undefined;
  /** Cancellation. Aborts the in-flight agent and skips the rest. */
  signal?: AbortSignal | undefined;
  /** Live per-agent status callback for the UI. */
  onProgress?:
    | ((agentId: string, phase: 'start' | 'done', result?: AcpBenchAgentResult) => void)
    | undefined;
  /** Marker token override (tests). Default is a random per-run token. */
  marker?: string | undefined;
  /** Clock injection (tests). Defaults to `Date.now`. */
  now?: (() => number) | undefined;
}

function firstLine(s: string): string {
  const line =
    s
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

function randomMarker(): string {
  // Unique-enough per run so an agent can't echo a cached reply.
  return `ACP_OK_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

/**
 * Bench one agent end-to-end. Always resolves (errors are encoded in the
 * returned result's status/checks), so the caller's fan-out never rejects.
 */
interface BenchOneCtx {
  projectRoot: string;
  timeoutMs: number;
  checkFs: boolean;
  marker: string;
  now: () => number;
  signal?: AbortSignal | undefined;
}

async function benchOne(
  agentId: string,
  cmd: ACPSubagentRunnerOptions,
  opts: BenchOneCtx,
): Promise<AcpBenchAgentResult> {
  const checks: AcpBenchCheck[] = [];
  const startedAt = opts.now();
  let session: ACPSession | null = null;
  const signal = opts.signal ?? new AbortController().signal;

  // 1. Handshake.
  const hsStart = opts.now();
  try {
    session = await ACPSession.start({
      command: cmd.command,
      ...(cmd.args !== undefined ? { args: [...cmd.args] } : {}),
      ...(cmd.env !== undefined ? { env: cmd.env } : {}),
      projectRoot: opts.projectRoot,
      timeoutMs: opts.timeoutMs,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    checks.push({ name: 'handshake', ok: false, detail: reason });
    return {
      agentId,
      status: 'fail',
      checks,
      reason,
      handshakeMs: opts.now() - hsStart,
      durationMs: opts.now() - startedAt,
    };
  }
  const handshakeMs = opts.now() - hsStart;
  const agentInfo = session.getAgentInfo() ?? undefined;
  checks.push({
    name: 'handshake',
    ok: true,
    detail: agentInfo ? `${agentInfo.name} ${agentInfo.version}` : undefined,
  });

  let promptMs: number | undefined;
  let sample: string | undefined;
  let reason: string | undefined;
  try {
    // 2 + 3. Prompt + marker echo.
    const pStart = opts.now();
    const res = await session.prompt(
      [textContent(`Reply with exactly this token and nothing else: ${opts.marker}`)],
      signal,
    );
    promptMs = opts.now() - pStart;
    sample = res.text ? firstLine(res.text) : undefined;
    const promptOk = res.hasText && res.stopReason !== 'refusal';
    checks.push({
      name: 'prompt',
      ok: promptOk,
      detail: `stopReason=${res.stopReason}${res.hasText ? '' : ', no text'}`,
    });
    const markerOk = res.text.includes(opts.marker);
    checks.push({
      name: 'marker',
      ok: markerOk,
      detail: markerOk ? undefined : 'reply did not contain the token',
    });

    // 4. Optional fs callback check.
    if (opts.checkFs) {
      const fileToken = `FILE_${opts.marker}`;
      const fileName = `acp-bench-${opts.marker}.txt`;
      const filePath = path.join(opts.projectRoot, fileName);
      let fsOk = false;
      let fsDetail: string | undefined;
      try {
        await fsp.writeFile(filePath, fileToken, 'utf8');
        const fsRes = await session.prompt(
          [
            textContent(
              `Read the file "${fileName}" in the current directory and reply with its exact contents.`,
            ),
          ],
          signal,
        );
        fsOk = fsRes.text.includes(fileToken);
        if (!fsOk)
          fsDetail = 'agent did not return the file contents (may not have used a read tool)';
      } catch (err) {
        fsDetail = err instanceof Error ? err.message : String(err);
      } finally {
        await removeBenchFile(filePath);
      }
      checks.push({ name: 'fs', ok: fsOk, detail: fsDetail });
    }
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
    checks.push({ name: 'prompt', ok: false, detail: reason });
  } finally {
    try {
      await session.close();
    } catch {
      // best-effort
    }
  }

  // Grade: required = handshake + prompt + marker (+ fs when requested).
  const required = checks.filter((c) => c.name !== 'fs' || opts.checkFs);
  const allReq = required.every((c) => c.ok);
  // A handshake failure returns above, so every result graded here has a
  // successful handshake and can only be pass or partial.
  const status: AcpBenchStatus = allReq ? 'pass' : 'partial';

  return {
    agentId,
    status,
    checks,
    ...(agentInfo ? { agentInfo } : {}),
    handshakeMs,
    ...(promptMs !== undefined ? { promptMs } : {}),
    ...(sample ? { sample } : {}),
    ...(reason ? { reason } : {}),
    durationMs: opts.now() - startedAt,
  };
}

/**
 * Bench a set of ACP agents end-to-end and return a graded report. Unknown
 * ids are reported `skipped`. Bounded concurrency keeps the number of live
 * ACP subprocesses (each running a real model turn) manageable.
 */
export async function runAcpBench(opts: AcpBenchOptions): Promise<AcpBenchResult> {
  const now = opts.now ?? Date.now;
  const projectRoot = opts.projectRoot ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const checkFs = opts.checkFs ?? false;
  const marker = opts.marker ?? randomMarker();
  const concurrency = Math.max(1, opts.concurrency ?? 2);

  // Dedup, preserve order.
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of opts.agentIds) {
    const id = raw.trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  const results: AcpBenchAgentResult[] = ids.map((agentId) => ({
    agentId,
    status: 'skipped',
    checks: [],
    durationMs: 0,
    reason: 'unknown agent',
  }));
  const startMs = now();

  const runnable: { id: string; cmd: ACPSubagentRunnerOptions; index: number }[] = [];
  ids.forEach((id, index) => {
    const cmd = opts.resolveCmd(id);
    if (cmd) runnable.push({ id, cmd, index });
  });

  let next = 0;
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(concurrency, runnable.length);
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (true) {
          const current = next++;
          if (current >= runnable.length) return;
          const { id, cmd, index } = runnable[current]!;
          if (opts.signal?.aborted) {
            results[index] = {
              agentId: id,
              status: 'skipped',
              checks: [],
              durationMs: 0,
              reason: 'aborted',
            };
            continue;
          }
          opts.onProgress?.(id, 'start');
          const r = await benchOne(id, cmd, {
            projectRoot,
            timeoutMs,
            checkFs,
            marker,
            now,
            ...(opts.signal ? { signal: opts.signal } : {}),
          });
          results[index] = r;
          opts.onProgress?.(id, 'done', r);
        }
      })(),
    );
  }
  await Promise.all(workers);

  const summary = { pass: 0, partial: 0, fail: 0, skipped: 0 };
  for (const r of results) summary[r.status]++;

  return { results, summary, totalDurationMs: now() - startMs };
}

/** Render an `AcpBenchResult` as a plain-text report. */
export function renderAcpBenchText(result: AcpBenchResult): string {
  const icon = (s: AcpBenchStatus): string =>
    s === 'pass' ? '✓' : s === 'partial' ? '◐' : s === 'skipped' ? '–' : '✗';
  const lines: string[] = ['ACP client bench:', ''];
  if (result.results.length === 0) {
    lines.push('No agents to bench.');
    return lines.join('\n');
  }
  for (const r of result.results) {
    const checks = r.checks.map((c) => `${c.ok ? '✓' : '✗'}${c.name}`).join(' ');
    const timing =
      r.handshakeMs !== undefined
        ? `  hs=${r.handshakeMs}ms${r.promptMs !== undefined ? ` prompt=${r.promptMs}ms` : ''}`
        : '';
    lines.push(
      `  ${icon(r.status)} ${r.agentId.padEnd(16)} ${r.status.toUpperCase().padEnd(7)} ${checks}${timing}`,
    );
    if (r.agentInfo) lines.push(`      agent: ${r.agentInfo.name} ${r.agentInfo.version}`);
    if (r.sample) lines.push(`      reply: ${r.sample}`);
    if (r.reason) lines.push(`      reason: ${r.reason}`);
  }
  const { pass, partial, fail, skipped } = result.summary;
  lines.push('');
  lines.push(
    `Bench summary: ${pass} pass, ${partial} partial, ${fail} fail, ${skipped} skipped. (${result.totalDurationMs}ms total)`,
  );
  return lines.join('\n');
}

async function removeBenchFile(filePath: string, remove: typeof fsp.rm = fsp.rm): Promise<void> {
  await remove(filePath, { force: true }).catch(() => undefined);
}

/** Direct-module test seam; not re-exported by the package barrel. */
export const acpBenchCoverage = { firstLine, randomMarker, removeBenchFile };
