import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isGovernanceProjectDaemonEntrypoint,
  parseGovernanceDaemonArguments,
} from '../src/project-daemon.js';

describe('governance project daemon entrypoint', () => {
  it('parses only the two explicit bootstrap arguments', () => {
    expect(
      parseGovernanceDaemonArguments([
        '--project-root',
        'D:\\work\\repo',
        '--project-id',
        'project-1',
      ]),
    ).toEqual({
      projectRoot: path.resolve('D:\\work\\repo'),
      projectId: 'project-1',
    });
    expect(() =>
      parseGovernanceDaemonArguments(['--project-root', 'D:\\repo', '--unknown', 'value']),
    ).toThrow('requires only');
    expect(() =>
      parseGovernanceDaemonArguments(['--project-root', 'D:\\repo', '--project-root', 'D:\\other']),
    ).toThrow('provided twice');
    expect(() => parseGovernanceDaemonArguments(['--project-root', 'D:\\repo'])).toThrow(
      'requires valid',
    );
  });

  it('starts only when the resolved script path matches this module URL', () => {
    const entrypoint = path.resolve('packages/governance/src/project-daemon.ts');
    expect(isGovernanceProjectDaemonEntrypoint(entrypoint, pathToFileURL(entrypoint).href)).toBe(
      true,
    );
    expect(
      isGovernanceProjectDaemonEntrypoint(
        path.resolve('packages/governance/tests/importer.ts'),
        pathToFileURL(entrypoint).href,
      ),
    ).toBe(false);
  });
});
