import { afterEach, describe, expect, it } from 'vitest';
import {
  isWorkerParseLang,
  resolveParserWorkerCount,
} from '../src/codebase-index/parser-worker-pool.js';

const originalWorkers = process.env.WRONGSTACK_INDEX_PARSE_WORKERS;
const originalProfile = process.env.WRONGSTACK_PERF_PROFILE;

afterEach(() => {
  if (originalWorkers === undefined) delete process.env.WRONGSTACK_INDEX_PARSE_WORKERS;
  else process.env.WRONGSTACK_INDEX_PARSE_WORKERS = originalWorkers;
  if (originalProfile === undefined) delete process.env.WRONGSTACK_PERF_PROFILE;
  else process.env.WRONGSTACK_PERF_PROFILE = originalProfile;
});

describe('parser worker sizing', () => {
  it('supports an explicit bounded override', () => {
    process.env.WRONGSTACK_INDEX_PARSE_WORKERS = '3';
    expect(resolveParserWorkerCount(1)).toBe(3);
    process.env.WRONGSTACK_INDEX_PARSE_WORKERS = '99';
    expect(resolveParserWorkerCount(1)).toBe(4);
    process.env.WRONGSTACK_INDEX_PARSE_WORKERS = '-2';
    expect(resolveParserWorkerCount(10_000)).toBe(0);
  });

  it('keeps small and frugal runs inline', () => {
    delete process.env.WRONGSTACK_INDEX_PARSE_WORKERS;
    process.env.WRONGSTACK_PERF_PROFILE = 'balanced';
    expect(resolveParserWorkerCount(1)).toBe(0);
    process.env.WRONGSTACK_PERF_PROFILE = 'frugal';
    expect(resolveParserWorkerCount(10_000)).toBe(0);
  });

  it('delegates only compiler-AST languages', () => {
    expect(isWorkerParseLang('ts')).toBe(true);
    expect(isWorkerParseLang('tsx')).toBe(true);
    expect(isWorkerParseLang('json')).toBe(false);
    expect(isWorkerParseLang('md')).toBe(false);
  });
});
