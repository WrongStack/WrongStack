import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createPersistencePrimitives } from '@wrongstack/persistence';
import { redactSecrets } from '@wrongstack/primitives';
import { assertKitId, KIT_HISTORY_DIRECTORY, kitPath, loadKit } from './catalog.js';
import { runKitProcess, STDERR_TAIL_LIMIT } from './runner.js';
import { assertValue, withDefaults } from './schema.js';

const { atomicWrite } = createPersistencePrimitives();

export interface KitRunRecord {
  runId: string;
  name: string;
  revision: string;
  action: 'verify' | 'run';
  status: 'running' | 'passed' | 'failed';
  agentId: string;
  sessionId?: string | undefined;
  toolUseId?: string | undefined;
  startedAt: string;
  completedAt?: string | undefined;
  durationMs?: number | undefined;
  error?: string | undefined;
  /** Exit code of the last executed child process; present on success too. */
  exitCode?: number | undefined;
  /** Redacted stderr tail (last 4096 characters) of the last executed child process. */
  stderrTail?: string | undefined;
  /** Whether the last child process delivered its terminal IPC message. */
  resultReceived?: boolean | undefined;
  /** Parent-side milliseconds from spawn to that message; undefined when none arrived. */
  receiveMs?: number | undefined;
  cases?: Array<{ name: string; passed: boolean }> | undefined;
}

export function isKitVerified(history: readonly KitRunRecord[], revision: string): boolean {
  // A newer failed or interrupted verification revokes an older pass.
  return (
    history.find((record) => record.action === 'verify' && record.revision === revision)?.status ===
    'passed'
  );
}

export async function kitHistory(root: string, name: string, limit = 20): Promise<KitRunRecord[]> {
  assertKitId(name);
  let directory: string;
  try {
    directory = await kitPath(root, `${KIT_HISTORY_DIRECTORY}/${name}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries = (await readdir(directory))
    .filter((entry) => /^\d+-[a-f0-9-]+$/.test(entry))
    .sort()
    .reverse();
  const records: KitRunRecord[] = [];
  const boundedLimit = Number.isFinite(limit) ? Math.min(100, Math.max(0, Math.trunc(limit))) : 20;
  for (const entry of entries.slice(0, boundedLimit)) {
    try {
      const record = await kitPath(root, `${KIT_HISTORY_DIRECTORY}/${name}/${entry}/record.json`);
      records.push(JSON.parse(await readFile(record, 'utf8')) as KitRunRecord);
    } catch (error) {
      // A concurrent run may still be capturing its source, or the host may
      // have stopped before writing its first record. Neither is verification.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return records;
}

export async function executeKit(options: {
  root: string;
  name: string;
  revision: string;
  action: 'verify' | 'run';
  input: unknown;
  agentId: string;
  sessionId?: string | undefined;
  toolUseId?: string | undefined;
  signal: AbortSignal;
}) {
  const bundle = await loadKit(options.root, options.name);
  if (options.revision !== bundle.revision)
    throw new Error('Project Kit revision changed; inspect again before executing');
  const { manifest: m } = bundle;
  const input = withDefaults(options.input, m.inputSchema);
  if (options.action === 'run') {
    assertValue(input, m.inputSchema, 'input');
    const history = await kitHistory(options.root, options.name, 100);
    if (!isKitVerified(history, bundle.revision))
      throw new Error(
        'This revision has no passing verification in recent history; run action=verify first',
      );
  }
  options.signal.throwIfAborted();
  const runId = `${Date.now()}-${randomUUID()}`;
  const relative = `${KIT_HISTORY_DIRECTORY}/${m.name}/${runId}`;
  const directory = await kitPath(options.root, relative, true);
  // Run the exact bytes that were hashed, including local module imports and
  // fixtures. Every run retains its source snapshot for inspection/recovery.
  const snapshot = await kitPath(options.root, `${relative}/source`, true);
  for (const [file, body] of bundle.files) {
    const target = path.join(snapshot, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, { flag: 'wx', mode: 0o600 });
  }
  const record: KitRunRecord = {
    runId,
    name: m.name,
    revision: bundle.revision,
    action: options.action,
    status: 'running',
    agentId: options.agentId,
    sessionId: options.sessionId,
    toolUseId: options.toolUseId,
    startedAt: new Date().toISOString(),
  };
  const recordFile = path.join(directory, 'record.json');
  await atomicWrite(recordFile, JSON.stringify(record, null, 2));
  const started = Date.now();
  const logs: string[] = [];
  const cases: Array<{ name: string; passed: boolean }> = [];
  let output: unknown;
  let exitCode: number | undefined;
  let stderrTail: string | undefined;
  let resultReceived: boolean | undefined;
  let receiveMs: number | undefined;
  try {
    const inputs =
      options.action === 'verify' ? m.tests : [{ name: 'run', input, expected: undefined }];
    for (const test of inputs) {
      options.signal.throwIfAborted();
      const remaining = m.timeoutMs - (Date.now() - started);
      if (remaining <= 0) throw new Error('Timed out');
      const result = await runKitProcess({
        projectRoot: options.root,
        kitRoot: snapshot,
        entry: m.entry,
        runId,
        name: m.name,
        sessionId: options.sessionId,
        input: withDefaults(test.input, m.inputSchema),
        timeoutMs: remaining,
        signal: options.signal,
      });
      logs.push(...result.logs);
      exitCode = result.exitCode;
      stderrTail = result.stderrTail;
      resultReceived = result.resultReceived;
      receiveMs = result.receiveMs;
      if (!result.ok) throw new Error(result.error ?? 'Execution failed');
      assertValue(result.output, m.outputSchema, 'output');
      output = result.output;
      if (options.action === 'verify') {
        const passed = isDeepStrictEqual(output, test.expected);
        cases.push({ name: test.name, passed });
        if (!passed) throw new Error(`Verification case failed: ${test.name}`);
      }
    }
    record.status = 'passed';
  } catch (error) {
    record.status = 'failed';
    record.error = redactSecrets((error as Error).message);
  }
  record.completedAt = new Date().toISOString();
  record.durationMs = Date.now() - started;
  record.exitCode = exitCode;
  record.stderrTail = stderrTail;
  record.resultReceived = resultReceived;
  record.receiveMs = receiveMs;
  if (options.action === 'verify') record.cases = cases;
  // Persist metadata only: raw inputs, outputs, error text and logs may contain
  // arbitrary private data that pattern-based redaction cannot recognize.
  // Deliberate, narrow exception to that rule: the child exit code and a
  // bounded, redacted stderr tail are retained so a died-child failure (e.g.
  // exit 0 with no IPC result) stays diagnosable. Raw inputs, results and
  // unbounded logs are still never written here.
  const persisted = {
    ...record,
    error: record.error ? 'Execution failed; see session result' : undefined,
    stderrTail: record.stderrTail
      ? redactSecrets(record.stderrTail).slice(-STDERR_TAIL_LIMIT)
      : undefined,
  };
  await atomicWrite(recordFile, JSON.stringify(persisted, null, 2));
  return {
    ...record,
    output: options.action === 'run' && record.status === 'passed' ? output : undefined,
    logs,
    sourceSnapshot: path.relative(options.root, snapshot),
  };
}
