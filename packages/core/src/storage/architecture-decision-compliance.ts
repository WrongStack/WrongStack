import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import type { PermissionPolicy } from '@wrongstack/contracts/types/permission';
import type { Tool } from '@wrongstack/contracts/types/tool';
import type { ArchitectureDecisionCheck } from './architecture-decision-check.js';
import { ArchitectureDecisionStore } from './architecture-decision-store.js';

export interface ArchitectureDecisionCheckResult {
  decisionId: string;
  revision: number;
  contentHash: string;
  checkId: string;
  path: string;
  status: 'pass' | 'fail' | 'blocked';
  message: string;
  fileHash?: string;
}
export interface ArchitectureDecisionCompliance {
  projectId: string;
  checkedAt: string;
  status: 'pass' | 'fail' | 'blocked' | 'not_configured';
  results: ArchitectureDecisionCheckResult[];
}

class CheckBlocked extends Error {}

export async function checkArchitectureDecisions(
  projectRoot: string,
  authorizeRead: (absolutePath: string) => Promise<boolean>,
  decisionId?: string,
): Promise<ArchitectureDecisionCompliance> {
  const store = new ArchitectureDecisionStore(projectRoot);
  const active = store
    .list()
    .filter((record) => record.status === 'accepted' && (!decisionId || record.id === decisionId));
  if (decisionId && !active.length) throw new Error('Only an accepted ADR can be checked.');
  const fingerprint = (records: typeof active) =>
    JSON.stringify(records.map(({ id, revision, contentHash }) => [id, revision, contentHash]));
  const initial = fingerprint(active);
  const results: ArchitectureDecisionCheckResult[] = [];
  let remainingBytes = 4 * 1024 * 1024;
  const read = async (relative: string, existsOnly: boolean) => {
    const candidate = path.resolve(projectRoot, relative);
    // No filesystem probe before the host read policy allows this exact path.
    if (!(await authorizeRead(candidate)))
      throw new CheckBlocked('Read permission is unavailable or requires confirmation.');
    let root: string;
    let target: string;
    try {
      root = await realpath(projectRoot);
      target = await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true as const };
      throw error;
    }
    const rel = path.relative(root, target);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
      throw new CheckBlocked('Check path resolves outside the project.');
    if (candidate !== target && !(await authorizeRead(target)))
      throw new CheckBlocked('Resolved path is not authorized.');
    // Do not wait for a writer if a POSIX path was replaced with a FIFO.
    const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
    const handle = await open(target, flags);
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new CheckBlocked('Check target is not a regular file.');
      const assertBinding = async () => {
        if ((await realpath(candidate)) !== target)
          throw new CheckBlocked('Check path changed during evaluation.');
        const current = await open(target, flags);
        try {
          const stat = await current.stat();
          if (stat.ino !== before.ino || stat.dev !== before.dev)
            throw new CheckBlocked('Check target changed during evaluation.');
        } finally {
          await current.close();
        }
      };
      await assertBinding();
      if (existsOnly) return { missing: false as const };
      if (before.size > 1024 * 1024 || before.size > remainingBytes)
        throw new CheckBlocked('Check exceeds the file or run byte budget.');
      // Bounded read even if a writer grows the file after stat().
      const bytes = Buffer.alloc(Math.min(1024 * 1024, remainingBytes) + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > 1024 * 1024 || length > remainingBytes)
        throw new CheckBlocked('Check exceeds the file or run byte budget.');
      remainingBytes -= length;
      const after = await handle.stat();
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new CheckBlocked('File changed during evaluation.');
      await assertBinding();
      return {
        missing: false as const,
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)),
        hash: createHash('sha256').update(bytes.subarray(0, length)).digest('hex'),
      };
    } finally {
      await handle.close();
    }
  };

  checks: for (const record of active)
    for (const rule of record.checks ?? []) {
      const base = {
        decisionId: record.id,
        revision: record.revision,
        contentHash: record.contentHash,
        checkId: rule.id,
        path: rule.path,
      };
      if (results.length >= 32) {
        results.push({ ...base, status: 'blocked', message: 'Run exceeds 32 checks.' });
        break checks;
      }
      try {
        const file = await read(rule.path, rule.kind === 'file_exists');
        if (file.missing) {
          results.push({ ...base, status: 'fail', message: 'Required check target is missing.' });
          continue;
        }
        let passed = true;
        if (rule.kind === 'contains_text') passed = file.text!.includes(rule.text);
        if (rule.kind === 'excludes_text') passed = !file.text!.includes(rule.text);
        if (rule.kind === 'json_equals') passed = matchesJson(file.text!, rule);
        results.push({
          ...base,
          status: passed ? 'pass' : 'fail',
          message: passed
            ? 'Constraint satisfied for the inspected file.'
            : 'Constraint is not satisfied.',
          ...(file.hash ? { fileHash: file.hash } : {}),
        });
      } catch (error) {
        // Never echo file contents, actual JSON values, or low-level errors containing secrets.
        results.push({
          ...base,
          status: 'blocked',
          message:
            error instanceof CheckBlocked
              ? error.message
              : 'Check target is unreadable or is not valid UTF-8 / JSON.',
        });
      }
    }
  const current = store
    .list()
    .filter((record) => record.status === 'accepted' && (!decisionId || record.id === decisionId));
  if (initial !== fingerprint(current))
    for (const result of results) {
      result.status = 'blocked';
      result.message = 'Accepted decisions changed during evaluation. Run the checks again.';
    }
  return {
    projectId: store.projectId,
    checkedAt: new Date().toISOString(),
    status: !results.length
      ? 'not_configured'
      : results.some((result) => result.status === 'blocked')
        ? 'blocked'
        : results.some((result) => result.status === 'fail')
          ? 'fail'
          : 'pass',
    results,
  };
}

/** Automatic inspection never consumes one-shot approvals or opens a confirmation dialog. */
export function architectureDecisionReadAuthorizer(
  ctx?: AgentContext,
  policy?: Pick<PermissionPolicy, 'explain'>,
  readTool?: Tool,
): (absolutePath: string) => Promise<boolean> {
  return async (absolutePath) => {
    if (!ctx || !policy?.explain || !readTool) return false;
    try {
      return (
        (await policy.explain(readTool, { path: absolutePath }, ctx)).decision.permission === 'auto'
      );
    } catch {
      return false;
    }
  };
}

function matchesJson(
  text: string,
  rule: Extract<ArchitectureDecisionCheck, { kind: 'json_equals' }>,
): boolean {
  let value: unknown = JSON.parse(text);
  if (rule.pointer)
    for (const raw of rule.pointer.slice(1).split('/')) {
      const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
      if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) return false;
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return false;
      value = (value as Record<string, unknown>)[key];
    }
  return value === rule.value;
}
