import { describe, expect, it } from 'vitest';
import {
  acceptWrongIndexQuery,
  captureWrongIndexPublications,
  getWrongIndexPublication,
  onWrongIndexPublication,
} from '../src/codebase-index/wrongindex/publication.js';

describe('WrongIndex publication boundary', () => {
  it('accepts a new project registration at the same index without reviving its old lineage', () => {
    const reply = {
      projectRoot: '/',
      indexDir: '/',
      projectId: 'old-project',
      daemonInstanceId: 'same-daemon',
      generation: 9,
      observedAt: 1,
      result: {},
    };
    acceptWrongIndexQuery(reply, '/', '/registered-again');
    expect(() =>
      acceptWrongIndexQuery(
        { ...reply, projectId: 'new-project', generation: 1 },
        '/',
        '/registered-again',
      ),
    ).not.toThrow();
    expect(() => acceptWrongIndexQuery(reply, '/', '/registered-again')).toThrow(/superseded/);
  });
  it('isolates concurrent composite tool publication scopes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const reply = (projectId: string, generation: number) => ({
      projectRoot: '/',
      indexDir: '/',
      projectId,
      daemonInstanceId: 'scope-fixture',
      generation,
      observedAt: 1,
      result: {},
    });
    const a = captureWrongIndexPublications(async () => {
      acceptWrongIndexQuery(reply('a', 1), '/a', '/scope-a');
      await gate;
      acceptWrongIndexQuery(reply('a', 2), '/a', '/scope-a');
      return 'a';
    });
    const b = await captureWrongIndexPublications(async () => {
      acceptWrongIndexQuery(reply('b', 7), '/b', '/scope-b');
      return 'b';
    });
    release();
    expect((await a).publications.map((p) => p.generation)).toEqual([1, 2]);
    expect(b.publications.map((p) => p.generation)).toEqual([7]);
  });
  it('keeps the wire payload intact and tracks generation, rebuild and restart identity', () => {
    const seen: string[] = [];
    const stop = onWrongIndexPublication((p) => {
      seen.push(`${p.daemonInstanceId}:${p.generation}:${p.graphStamp}`);
    });
    try {
      const reply = {
        projectRoot: '',
        indexDir: '',
        projectId: 'p',
        daemonInstanceId: 'one',
        generation: 1,
        graphStamp: 'a',
        observedAt: 1,
        result: { hits: ['a'] },
      };
      const result = acceptWrongIndexQuery(reply, '/project', '/publication-test');
      expect(JSON.stringify(result)).toBe('{"hits":["a"]}');
      expect(getWrongIndexPublication(result)).toMatchObject({
        generation: 1,
        projectRoot: '/project',
      });
      acceptWrongIndexQuery(reply, '/project', '/publication-test');
      acceptWrongIndexQuery({ ...reply, generation: 2 }, '/project', '/publication-test');
      acceptWrongIndexQuery(
        { ...reply, generation: 2, graphStamp: 'rebuild' },
        '/project',
        '/publication-test',
      );
      acceptWrongIndexQuery({ ...reply, daemonInstanceId: 'two' }, '/project', '/publication-test');
      expect(() => acceptWrongIndexQuery(reply, '/project', '/publication-test')).toThrow(
        /superseded/,
      );
      expect(seen).toEqual(['one:1:a', 'one:2:a', 'one:2:rebuild', 'two:1:a']);
    } finally {
      stop();
    }
  });
  it('does not serve pending or corrupt results as usable publications', () => {
    const reply = {
      projectRoot: '',
      indexDir: '',
      projectId: 'p',
      daemonInstanceId: 'one',
      generation: 1,
      observedAt: 1,
      result: {},
    };
    expect(() =>
      acceptWrongIndexQuery({ ...reply, publicationPending: true }, '/', '/pending-test'),
    ).toThrow(/publication is pending/);
    expect(() =>
      acceptWrongIndexQuery({ ...reply, indexCorrupt: 'fixture' }, '/', '/corrupt-test'),
    ).toThrow(/damaged index/);
  });

  it('normalizes trailing separators, mixed slashes, and relative indexDir overrides (F169)', () => {
    const root = '/f169-publication-root';
    const reply = {
      projectRoot: root,
      indexDir: `${root}/.idx/`,
      projectId: 'proj-1',
      daemonInstanceId: 'daemon-1',
      generation: 6,
      observedAt: 1,
      result: {},
    };
    acceptWrongIndexQuery(reply, root, `${root}/.idx/`);
    expect(() => acceptWrongIndexQuery({ ...reply, generation: 3 }, root, `${root}/.idx`)).toThrow(
      /superseded/,
    );
    expect(() => acceptWrongIndexQuery({ ...reply, generation: 3 }, root, '.idx')).toThrow(
      /superseded/,
    );
  });
});
