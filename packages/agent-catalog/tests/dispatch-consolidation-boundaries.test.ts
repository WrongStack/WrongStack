import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dispatchLogPath, recordDispatchOutcome } from '../src/dispatch-log.js';
import { loadConsolidationMetadata } from '../src/project-agent-consolidation.js';
import { roleDir } from '../src/project-agent-paths.js';

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(join(tmpdir(), 'agent-catalog-boundary-'));
  roots.push(value);
  return value;
};

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('dispatch and consolidation boundary regressions', () => {
  it('omits non-finite dispatch durations instead of persisting null', () => {
    const projectRoot = root();
    recordDispatchOutcome(
      { at: 'x', subagentId: 's', role: 'r', status: 'success', durationMs: Number.NaN },
      projectRoot,
    );
    expect(JSON.parse(readFileSync(dispatchLogPath(projectRoot), 'utf8'))).not.toHaveProperty(
      'durationMs',
    );
  });

  it('omits non-finite dispatch costs instead of persisting null', () => {
    const projectRoot = root();
    recordDispatchOutcome(
      {
        at: 'x',
        subagentId: 's',
        role: 'r',
        status: 'success',
        costUsd: Number.POSITIVE_INFINITY,
      },
      projectRoot,
    );
    expect(JSON.parse(readFileSync(dispatchLogPath(projectRoot), 'utf8'))).not.toHaveProperty(
      'costUsd',
    );
  });

  it('rejects incomplete and non-finite consolidation metadata', () => {
    const projectRoot = root();
    mkdirSync(roleDir('executor', projectRoot), { recursive: true });
    writeFileSync(
      join(roleDir('executor', projectRoot), 'consolidation.json'),
      '{"consolidatedAt":"bad","sourceEntryCount":1e999}',
    );
    expect(loadConsolidationMetadata('executor', projectRoot)).toBeUndefined();
  });
});
