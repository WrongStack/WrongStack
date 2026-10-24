/**
 * `wstack typesafe replay-topic-shift` — calibrate the topic-shift front on
 * this project's own sessions.
 *
 * Session journals record every user prompt (`user_input`) and every message
 * appended to the conversation, so the history the advisor saw at each prompt
 * can be rebuilt. Each prompt is replayed through the real `TopicShiftAdvisor`
 * twice — once with only the TypeSafe judge, once with only the configured
 * provider (the path it has always had, with its production request) — and only
 * prompts that pass the advisor's own local gate are counted, because the
 * rest never reach a classifier in production either.
 *
 * Reported: how often each classifier answers at all, what it answers, and
 * how the two agree where Jev is decisive. `--json` includes the prompt and
 * the previous user prompt for hand-labelling. Nothing is written.
 */

import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import type { Message } from '@wrongstack/contracts/types';
import { TopicShiftAdvisor, type TopicShiftDiagnostic } from '@wrongstack/core/execution';
import { resolveTypeSafeAccount } from '@wrongstack/core/typesafe';
import { color } from '@wrongstack/core/utils';
import { resolveRuntimeMaxContext } from '../../context-limit.js';
import type { SubcommandDeps } from '../contracts.js';
import { createProviderForId } from './modeldiag-eval.js';

const gunzipAsync = promisify(gunzip);

interface PromptPoint {
  session: string;
  prompt: string;
  previousPrompt: string;
  messages: Message[];
  contextTokens: number | undefined;
}

interface TopicCase extends PromptPoint {
  jevNoul?: number | undefined;
  jevError?: string | undefined;
  llm?: 'new' | 'same' | undefined;
  llmConfidence?: number | undefined;
  llmFailure?: string | undefined;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } => b?.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

async function sessionFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  let days: string[];
  try {
    days = await readdir(root);
  } catch {
    return out;
  }
  for (const day of days.sort()) {
    let entries: string[];
    try {
      entries = await readdir(path.join(root, day));
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      if (/^sess_[^.]+\.jsonl(\.gz)?$/.test(name)) out.push(path.join(root, day, name));
    }
  }
  return out;
}

async function promptPoints(file: string): Promise<PromptPoint[]> {
  const buf = await readFile(file);
  const raw = file.endsWith('.gz')
    ? (await gunzipAsync(buf)).toString('utf8')
    : buf.toString('utf8');
  const messages: Message[] = [];
  const points: PromptPoint[] = [];
  let contextTokens: number | undefined;
  let previousPrompt = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e['type'] === 'llm_request' && typeof e['estimatedInputTokens'] === 'number') {
      contextTokens = e['estimatedInputTokens'];
    } else if (e['type'] === 'user_input') {
      const prompt = textOf(e['content']).trim();
      if (prompt) {
        points.push({
          session: path.basename(file).replace(/\.jsonl(\.gz)?$/, ''),
          prompt,
          previousPrompt,
          messages: [...messages],
          contextTokens,
        });
        previousPrompt = prompt;
      }
    } else if (e['type'] === 'message_appended') {
      const m = e['message'] as { role?: string; content?: unknown } | undefined;
      if (m && (m.role === 'user' || m.role === 'assistant')) {
        const text = textOf(m.content).trim();
        if (text) messages.push({ role: m.role, content: text });
      }
    }
  }
  return points;
}

export async function replayTopicShift(
  deps: SubcommandDeps,
  write: (line: string) => void,
): Promise<number> {
  const flags = deps.flags ?? {};
  const json = flags['json'] === true;
  // A value-less flag parses as `true`, and Number(true) is 1: a bare
  // --max-context replayed every prompt against a 1-token window.
  for (const name of ['limit', 'max-context']) {
    if (typeof flags[name] === 'boolean') {
      write(`${color.red('✗')} --${name} needs a number.`);
      return 2;
    }
  }
  const account = resolveTypeSafeAccount({ config: deps.config, restGate: null });
  if (account.status !== 'ready') {
    write(`${color.red('✗')} ${account.reason}. Run \`wstack typesafe login\`.`);
    return 2;
  }
  const limit = Math.max(1, Number(flags['limit']) || 40);
  const sessionsRoot =
    typeof flags['sessions'] === 'string'
      ? path.resolve(flags['sessions'])
      : path.join(deps.paths.projectDir, 'sessions');

  const providerId =
    typeof flags['provider'] === 'string' ? flags['provider'] : deps.config.provider;
  const model = typeof flags['model'] === 'string' ? flags['model'] : deps.config.model;
  // The replayed window is the model's real one: an explicit flag, else the
  // catalog. Never a guessed default — the advisor's verdict depends on it.
  const flagMaxContext = Number(flags['max-context']);
  const maxContext =
    Number.isFinite(flagMaxContext) && flagMaxContext > 0
      ? Math.floor(flagMaxContext)
      : await resolveRuntimeMaxContext({
          modelsRegistry: deps.modelsRegistry,
          config: deps.config,
          provider: { capabilities: { maxContext: 0 } } as never,
          providerId,
          modelId: model,
        }).catch(() => 0);
  if (maxContext <= 0) {
    write(
      `${color.red('✗')} Context window of ${providerId}/${model} is unknown. Pass --max-context <tokens>.`,
    );
    return 2;
  }
  const provider =
    flags['no-llm'] === true
      ? undefined
      : createProviderForId(providerId, deps.config as Parameters<typeof createProviderForId>[1]);

  const judge = { client: account.client, model: account.model, feature: 'topicShift' as const };
  const reached: TopicCase[] = [];
  let scanned = 0;
  const files = await sessionFiles(sessionsRoot);
  // Newest first: the gate and the prompts people type drift over time.
  for (const file of files.reverse()) {
    if (reached.length >= limit) break;
    let points: PromptPoint[];
    try {
      points = await promptPoints(file);
    } catch {
      continue;
    }
    for (const point of points) {
      if (reached.length >= limit) break;
      scanned++;
      let gate = false;
      let jevNoul: number | undefined;
      let jevError: string | undefined;
      const jevAdvisor = new TopicShiftAdvisor({
        getJudge: () => judge,
        onDiagnostic: (d: TopicShiftDiagnostic) => {
          if (d.stage === 'gate') gate = true;
          if (d.stage === 'system-one') {
            jevNoul = d.noul;
            jevError = d.error;
          }
        },
      });
      await jevAdvisor.advise({
        prompt: point.prompt,
        messages: point.messages,
        contextTokens: point.contextTokens,
        maxContext,
      });
      if (!gate) continue;
      const c: TopicCase = { ...point, jevNoul, jevError };
      if (provider?.complete) {
        let failure: string | undefined;
        const llmAdvisor = new TopicShiftAdvisor({
          onDiagnostic: (d) => {
            if (d.stage === 'model' && !d.parsed) {
              failure = d.error ?? (d.text?.trim() ? 'unparseable reply' : 'empty reply');
            }
          },
        });
        const advice = await llmAdvisor.advise({
          prompt: point.prompt,
          messages: point.messages,
          provider,
          model,
          contextTokens: point.contextTokens,
          maxContext,
        });
        if (advice.source === 'model') {
          c.llm = advice.suggestNewContext ? 'new' : 'same';
          c.llmConfidence = advice.confidence;
        } else {
          c.llmFailure = failure ?? `no model answer (${advice.source})`;
        }
      }
      reached.push(c);
    }
  }

  const bucket = (n: number | undefined) =>
    n === undefined ? 'none' : n >= 0.8 ? 'new' : n <= 0.3 ? 'same' : 'unsure';
  if (json) {
    write(
      JSON.stringify(
        {
          sessionsRoot,
          scanned,
          llm: provider ? `${providerId}/${model}` : null,
          cases: reached.map((c) => ({
            session: c.session,
            previousPrompt: c.previousPrompt.slice(0, 200),
            prompt: c.prompt.slice(0, 300),
            jev: c.jevNoul === undefined ? null : Number(c.jevNoul.toFixed(3)),
            jevBucket: bucket(c.jevNoul),
            jevError: c.jevError,
            llm: c.llm ?? null,
            llmConfidence: c.llmConfidence,
            llmFailure: c.llmFailure,
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const pct = (a: number, b: number) => (b === 0 ? '—' : `${Math.round((a / b) * 100)}%`);
  const count = (b: string) => reached.filter((c) => bucket(c.jevNoul) === b).length;
  write(
    color.dim(
      `${scanned} prompt(s) scanned in ${files.length} session file(s); ` +
        `${reached.length} passed the local gate and reached a classifier`,
    ),
  );
  write(color.bold('Jev'));
  write(
    `  new ${count('new')}  same ${count('same')}  unsure→provider ${count('unsure')}  ` +
      `no answer ${count('none')}`,
  );
  if (provider) {
    const answered = reached.filter((c) => c.llm);
    write(color.bold(`Provider classifier (${providerId}/${model}, production request shape)`));
    write(
      `  answered ${answered.length}/${reached.length}` +
        `  new ${answered.filter((c) => c.llm === 'new').length}` +
        `  same ${answered.filter((c) => c.llm === 'same').length}`,
    );
    const failures = new Map<string, number>();
    for (const c of reached) {
      if (c.llmFailure) failures.set(c.llmFailure, (failures.get(c.llmFailure) ?? 0) + 1);
    }
    for (const [reason, n] of failures) write(color.amber(`  ${n}× ${reason.slice(0, 100)}`));
    const both = reached.filter((c) => c.llm && ['new', 'same'].includes(bucket(c.jevNoul)));
    write(
      `  agreement where Jev is decisive: ${pct(
        both.filter((c) => bucket(c.jevNoul) === c.llm).length,
        both.length,
      )} of ${both.length}`,
    );
  }
  write(color.dim(`model ${account.model}`));
  return 0;
}
