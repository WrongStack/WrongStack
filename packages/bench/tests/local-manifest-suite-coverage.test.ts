import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalManifestSuite } from '../src/suites/local-manifest.js';

let tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tmpDirs = [];
});

async function makeTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-local-cov-'));
  tmpDirs.push(dir);
  return dir;
}

describe('createLocalManifestSuite — validation errors', () => {
  describe('readManifest errors', () => {
    it('throws on invalid JSON', async () => {
      const dir = await makeTmp();
      await fs.writeFile(path.join(dir, 'bench.local.json'), 'not valid json', 'utf8');
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/cannot read.*bench manifest/);
    });

    it('throws when manifest is not an object', async () => {
      const dir = await makeTmp();
      await fs.writeFile(path.join(dir, 'bench.local.json'), '"just a string"', 'utf8');
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/must be a JSON object/);
    });

    it('throws when manifest has no tasks array', async () => {
      const dir = await makeTmp();
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({ name: 'test' }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/missing a "tasks" array/);
    });

    it('throws when tasks array is empty', async () => {
      const dir = await makeTmp();
      await fs.writeFile(path.join(dir, 'bench.local.json'), JSON.stringify({ tasks: [] }), 'utf8');
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/no tasks/);
    });
  });

  describe('parseTask validation', () => {
    it('throws when a task is not an object', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: ['not-an-object'],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/must be an object/);
    });

    it('throws when task has no id', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(path.join(dir, 'fixture', 'x.txt'), 'x');
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              prompt: 'Do it',
              templateDir: './fixture',
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/must be a non-empty string/);
    });
  });

  describe('parseOptionalGrader validation', () => {
    it('throws when grader is not an object', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'bad-grader',
              prompt: 'Do it',
              templateDir: './fixture',
              grader: 'not-an-object',
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/must be an object/);
    });

    it('throws when grader type is not "command"', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'wrong-type',
              prompt: 'Do it',
              templateDir: './fixture',
              grader: { type: 'not-command', command: 'test' },
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/type must be "command"/);
    });

    it('throws when grader command is missing', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'no-cmd',
              prompt: 'Do it',
              templateDir: './fixture',
              grader: { type: 'command' },
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/must be a non-empty string/);
    });
  });

  describe('parseAssertion validation', () => {
    it('throws when assertion is not an object', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'bad-assert',
              prompt: 'Do it',
              templateDir: './fixture',
              assertions: ['string-not-object'],
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/must be an object/);
    });

    it('throws when assertion type is invalid', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'bad-type',
              prompt: 'Do it',
              templateDir: './fixture',
              assertions: [{ type: 'unknown_type', path: 'x.txt' }],
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/must be one of/);
    });

    it('throws when assertion has no path', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'no-path',
              prompt: 'Do it',
              templateDir: './fixture',
              assertions: [{ type: 'file_exists' }],
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/must be a non-empty string/);
    });

    it('throws when file_contains has no text', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'no-text',
              prompt: 'Do it',
              templateDir: './fixture',
              assertions: [{ type: 'file_contains', path: 'x.txt' }],
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/must be a non-empty string/);
    });
  });

  describe('parseOptionalTraceEval validation', () => {
    it('throws when traceEval is not an object', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'bad-te',
              prompt: 'Do it',
              templateDir: './fixture',
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
              traceEval: 'not-an-object',
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/must be an object/);
    });

    it('throws when traceEval.source is not an object', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      const transcript = path.join(dir, 'corpus', 'source.jsonl');
      await fs.mkdir(path.dirname(transcript), { recursive: true });
      await fs.writeFile(
        transcript,
        JSON.stringify({ type: 'session_start', id: 's' }) + '\n',
        'utf8',
      );
      const _sha256 = createHash('sha256')
        .update(JSON.stringify({ type: 'session_start', id: 's' }) + '\n')
        .digest('hex');
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'bad-source',
              prompt: 'Do it',
              templateDir: './fixture',
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
              traceEval: {
                source: 'not-an-object',
                retrieval: [{ toolNames: ['read'], contains: 'x' }],
                recall: { inputContains: ['a'] },
              },
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/must be an object/);
    });

    it('throws when sha256 is not a valid hex digest', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'bad-sha',
              prompt: 'Do it',
              templateDir: './fixture',
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
              traceEval: {
                source: {
                  sessionId: 's',
                  transcriptPath: './corpus/t.jsonl',
                  sha256: 'not-a-valid-sha',
                  eventStart: 0,
                  eventEnd: 1,
                },
                retrieval: [{ toolNames: ['read'], contains: 'x' }],
                recall: { inputContains: ['a'] },
              },
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/must be a SHA-256 hex digest/);
    });
  });

  describe('resolveAndValidateTraceEval errors', () => {
    it('throws when traceEval source transcript is missing', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      const sha256 = createHash('sha256').update('content').digest('hex');
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'missing-transcript',
              prompt: 'Do it',
              templateDir: './fixture',
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
              traceEval: {
                source: {
                  sessionId: 's',
                  transcriptPath: './corpus/missing.jsonl',
                  sha256,
                  eventStart: 0,
                  eventEnd: 1,
                },
                retrieval: [{ toolNames: ['read'], contains: 'x' }],
                recall: { inputContains: ['a'] },
              },
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/cannot read traceEval source transcript/);
    });

    it('throws when traceEval event range exceeds events', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      const transcriptDir = path.join(dir, 'corpus');
      await fs.mkdir(transcriptDir, { recursive: true });
      const transcriptPath = path.join(transcriptDir, 'short.jsonl');
      const events = [JSON.stringify({ type: 'session_start', id: 's' }) + '\n'];
      const content = events.join('');
      await fs.writeFile(transcriptPath, content, 'utf8');
      const sha256 = createHash('sha256').update(content).digest('hex');
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'out-of-range',
              prompt: 'Do it',
              templateDir: './fixture',
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
              traceEval: {
                source: {
                  sessionId: 's',
                  transcriptPath: './corpus/short.jsonl',
                  sha256,
                  eventStart: 0,
                  eventEnd: 5,
                },
                retrieval: [{ toolNames: ['read'], contains: 'x' }],
                recall: { inputContains: ['a'] },
              },
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/event range is outside/);
    });
  });

  describe('optional field parsing errors', () => {
    it('throws when shell field is not a boolean', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'bad-shell',
              prompt: 'Do it',
              templateDir: './fixture',
              grader: { type: 'command', command: 'test', shell: 'not-boolean' },
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/must be a boolean/);
    });

    it('throws when timeoutMs is not a positive number', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'bad-timeout',
              prompt: 'Do it',
              templateDir: './fixture',
              grader: { type: 'command', command: 'test', timeoutMs: -5 },
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/must be a positive number/);
    });

    it('throws when maxBufferBytes is not a positive number', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'bad-buffer',
              prompt: 'Do it',
              templateDir: './fixture',
              grader: { type: 'command', command: 'test', maxBufferBytes: 0 },
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/must be a positive number/);
    });

    it('throws when templateExclude is not a string array', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'bad-exclude',
              prompt: 'Do it',
              templateDir: './fixture',
              templateExclude: [42],
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/must be an array of strings/);
    });

    it('throws when assertions is not an array', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'bad-assertions',
              prompt: 'Do it',
              templateDir: './fixture',
              assertions: 'not-an-array',
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/must be an array/);
    });

    it('throws when retrieval is empty array', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'empty-retrieval',
              prompt: 'Do it',
              templateDir: './fixture',
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
              traceEval: {
                source: {
                  sessionId: 's',
                  transcriptPath: './t.jsonl',
                  sha256: 'a'.repeat(64),
                  eventStart: 0,
                  eventEnd: 1,
                },
                retrieval: [],
                recall: { inputContains: ['a'] },
              },
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/must be a non-empty array/);
    });

    it('throws when env is not a string record', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'bad-env',
              prompt: 'Do it',
              templateDir: './fixture',
              grader: { type: 'command', command: 'test', env: { KEY: 42 } },
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/must be a string/);
    });

    it('throws when name is not a string in manifest', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          name: 42,
          tasks: [
            {
              id: 't',
              prompt: 'Do it',
              templateDir: './fixture',
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      // name being invalid type is accepted by optionalString which throws
      await expect(suite.loadTasks({})).rejects.toThrow(/must be a string/);
    });
  });

  describe('hashTemplateDir edge cases', () => {
    it('handles symbolic links', async () => {
      const dir = await makeTmp();
      const fixture = path.join(dir, 'fixture');
      await fs.mkdir(fixture, { recursive: true });
      await fs.writeFile(path.join(fixture, 'target.txt'), 'symlink target', 'utf8');
      // Create a symlink — this exercises the isSymbolicLink() branch
      const linkPath = path.join(fixture, 'link.txt');
      try {
        await fs.symlink('target.txt', linkPath);
      } catch {
        // On Windows, symlink creation may require admin. Skip.
        return;
      }
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'sym',
              prompt: 'Do it',
              templateDir: './fixture',
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      const tasks = await suite.loadTasks({});
      expect(tasks).toHaveLength(1);
    });
  });

  describe('parseOptionalTraceEval eventEnd < eventStart', () => {
    it('throws when eventEnd is before eventStart', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      const transcriptDir = path.join(dir, 'corpus');
      await fs.mkdir(transcriptDir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'bad-range',
              prompt: 'Do it',
              templateDir: './fixture',
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
              traceEval: {
                source: {
                  sessionId: 's',
                  transcriptPath: './corpus/t.jsonl',
                  sha256: 'a'.repeat(64),
                  eventStart: 5,
                  eventEnd: 3,
                },
                retrieval: [{ toolNames: ['read'], contains: 'x' }],
                recall: { inputContains: ['a'] },
              },
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/eventEnd must be >= eventStart/);
    });
  });

  describe('resolveAndValidateTraceEval — session id not found', () => {
    it('throws when session id does not match', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      const transcriptDir = path.join(dir, 'corpus');
      await fs.mkdir(transcriptDir, { recursive: true });
      const content = JSON.stringify({ type: 'session_start', id: 'actual-id' }) + '\n';
      await fs.writeFile(path.join(transcriptDir, 'test.jsonl'), content, 'utf8');
      const sha256 = createHash('sha256').update(content).digest('hex');
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'wrong-sid',
              prompt: 'Do it',
              templateDir: './fixture',
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
              traceEval: {
                source: {
                  sessionId: 'wrong-id',
                  transcriptPath: './corpus/test.jsonl',
                  sha256,
                  eventStart: 0,
                  eventEnd: 0,
                },
                retrieval: [{ toolNames: ['read'], contains: 'x' }],
                recall: { inputContains: ['a'] },
              },
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/sessionId.*was not found/);
    });
  });

  describe('parseRetrievalExpectation without toolNames', () => {
    it('accepts retrieval expectation without toolNames', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'no-toolnames',
              prompt: 'Do it',
              templateDir: './fixture',
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
              traceEval: {
                source: {
                  sessionId: 's',
                  transcriptPath: './corpus/t.jsonl',
                  sha256: 'a'.repeat(64),
                  eventStart: 0,
                  eventEnd: 1,
                },
                retrieval: [{ contains: 'expected content' }],
                recall: { inputContains: ['marker'] },
              },
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      // Will fail on traceEval validation because transcript doesn't exist,
      // but the retrieval parsing should succeed
      await expect(suite.loadTasks({})).rejects.toThrow(/cannot read traceEval source/);
    });
  });

  describe('hashTemplateDir directory read error', () => {
    it('throws when template directory cannot be read', async () => {
      const dir = await makeTmp();
      // reference non-existent template dir
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'bad-tmpl',
              prompt: 'Do it',
              templateDir: './nonexistent',
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/cannot read local bench template/);
    });
  });

  describe('requiredNonEmptyStringArray validation', () => {
    it('throws when recall.inputContains contains an empty string', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'empty-string',
              prompt: 'Test',
              templateDir: './fixture',
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
              traceEval: {
                source: {
                  sessionId: 's',
                  transcriptPath: './corpus/t.jsonl',
                  sha256: 'a'.repeat(64),
                  eventStart: 0,
                  eventEnd: 1,
                },
                retrieval: [{ contains: 'x' }],
                recall: { inputContains: ['valid', ''] },
              },
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/non-empty strings/);
    });
  });

  describe('optionalStringRecord with valid env', () => {
    it('accepts a valid env object', async () => {
      const dir = await makeTmp();
      const fixture = path.join(dir, 'fixture');
      await fs.mkdir(fixture, { recursive: true });
      await fs.writeFile(path.join(fixture, 'x.txt'), 'data');
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'valid-env',
              prompt: 'Do it',
              templateDir: './fixture',
              grader: {
                type: 'command',
                command: process.execPath,
                args: ['-e', 'undefined'],
                shell: false,
                env: { MY_VAR: 'hello' },
              },
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      const tasks = await suite.loadTasks({});
      expect(tasks).toHaveLength(1);
    });
  });

  describe('manifest with name field', () => {
    it('accepts a manifest with a name', async () => {
      const dir = await makeTmp();
      const fixture = path.join(dir, 'fixture');
      await fs.mkdir(fixture, { recursive: true });
      await fs.writeFile(path.join(fixture, 'x.txt'), 'data');
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          name: 'My Benchmark',
          tasks: [
            {
              id: 'named',
              prompt: 'Do it',
              templateDir: './fixture',
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      const tasks = await suite.loadTasks({});
      expect(tasks).toHaveLength(1);
    });
  });

  describe('hashTemplateDir subdirectory recursion', () => {
    it('hashes files in nested subdirectories', async () => {
      const dir = await makeTmp();
      const fixture = path.join(dir, 'fixture');
      await fs.mkdir(path.join(fixture, 'subdir'), { recursive: true });
      await fs.writeFile(path.join(fixture, 'subdir', 'nested.txt'), 'nested content', 'utf8');
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'nested',
              prompt: 'Do it',
              templateDir: './fixture',
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      const tasks = await suite.loadTasks({});
      expect(tasks).toHaveLength(1);
    });
  });

  describe('optionalStringRecord with non-object env', () => {
    it('throws when env is not a record (object)', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'bad-env-type',
              prompt: 'Do it',
              templateDir: './fixture',
              grader: { type: 'command', command: 'test', env: 'not-an-object' },
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/must be an object/);
    });
  });

  describe('requiredNonNegativeInteger validation', () => {
    it('throws when eventStart is not a non-negative integer', async () => {
      const dir = await makeTmp();
      await fs.mkdir(path.join(dir, 'fixture'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'bad-eventstart',
              prompt: 'Do it',
              templateDir: './fixture',
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
              traceEval: {
                source: {
                  sessionId: 's',
                  transcriptPath: './corpus/t.jsonl',
                  sha256: 'a'.repeat(64),
                  eventStart: -1,
                  eventEnd: 0,
                },
                retrieval: [{ toolNames: ['read'], contains: 'x' }],
                recall: { inputContains: ['a'] },
              },
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/must be a non-negative integer/);
    });
  });

  describe('parseAssertion — all assertion types in suite loading', () => {
    it('parses file_not_exists and file_not_contains assertions through suite loading', async () => {
      const dir = await makeTmp();
      const fixture = path.join(dir, 'fixture');
      await fs.mkdir(fixture, { recursive: true });
      await fs.writeFile(path.join(fixture, 'exists.txt'), 'hello', 'utf8');
      await fs.writeFile(path.join(fixture, 'clean.txt'), 'no bad text', 'utf8');
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'all-assertions',
              prompt: 'Do the task',
              templateDir: './fixture',
              assertions: [
                { type: 'file_exists', path: 'exists.txt' },
                { type: 'file_not_exists', path: 'should-not-exist.txt' },
                { type: 'file_contains', path: 'exists.txt', text: 'hello' },
                { type: 'file_not_contains', path: 'clean.txt', text: 'bad' },
              ],
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      const tasks = await suite.loadTasks({});
      expect(tasks).toHaveLength(1);
    });
  });

  describe('optionalPositiveNumber with valid value', () => {
    it('accepts valid timeoutMs and maxBufferBytes in grader', async () => {
      const dir = await makeTmp();
      const fixture = path.join(dir, 'fixture');
      await fs.mkdir(fixture, { recursive: true });
      await fs.writeFile(path.join(fixture, 'x.txt'), 'data');
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'valid-numbers',
              prompt: 'Do it',
              templateDir: './fixture',
              grader: {
                type: 'command',
                command: process.execPath,
                args: ['-e', 'undefined'],
                shell: false,
                timeoutMs: 30000,
                maxBufferBytes: 5000,
              },
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      const tasks = await suite.loadTasks({});
      expect(tasks).toHaveLength(1);
    });
  });

  describe('duplicate task id detection', () => {
    it('throws on duplicate ids', async () => {
      const dir = await makeTmp();
      const fixture = path.join(dir, 'fixture');
      await fs.mkdir(fixture, { recursive: true });
      await fs.writeFile(path.join(fixture, 'x.txt'), 'data');
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'same-id',
              prompt: 'First',
              templateDir: './fixture',
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
            },
            {
              id: 'same-id',
              prompt: 'Second (duplicate)',
              templateDir: './fixture',
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      await expect(suite.loadTasks({})).rejects.toThrow(/duplicate local task id/);
    });
  });

  describe('subsetId with multiple tasks', () => {
    it('sorts tasks by id for subset hash', async () => {
      const dir = await makeTmp();
      const fixture = path.join(dir, 'fixture');
      await fs.mkdir(fixture, { recursive: true });
      await fs.writeFile(path.join(fixture, 'x.txt'), 'data');
      await fs.writeFile(
        path.join(dir, 'bench.local.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'b-task',
              prompt: 'Task B',
              templateDir: './fixture',
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
            },
            {
              id: 'a-task',
              prompt: 'Task A',
              templateDir: './fixture',
              assertions: [{ type: 'file_exists', path: 'x.txt' }],
            },
          ],
        }),
        'utf8',
      );
      const suite = createLocalManifestSuite({ suiteDir: dir });
      const tasks = await suite.loadTasks({});
      expect(tasks).toHaveLength(2);
      const id1 = suite.subsetId(tasks);
      const id2 = suite.subsetId([...tasks].reverse()); // reverse order
      // Should produce same hash regardless of input order
      expect(id1).toBe(id2);
    });
  });
});
