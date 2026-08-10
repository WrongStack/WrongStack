/**
 * Long-lived regression coverage for `SageDomainTermExtractor.extractFromCommits`.
 *
 * Why this file exists
 * --------------------
 * `extractFromConversation` has a deep test bench; `extractFromCommits`
 * did not. The session-end subscriber (see
 * `packages/sage/src/middleware/session-end-commit-extractor.ts`) calls
 * it on every TUI/WebUI/CLI session termination, and a regression here
 * would silently drop project jargon from the dictionary. The `exec`
 * option on `ExtractFromCommitsOptions` is the seam we inject through —
 * any future refactor that drops the override (or hard-codes the real
 * `git` invocation) breaks every test below loudly.
 *
 * The fake `exec` returns a canonical `--pretty=format:--SUBJECT--%n%s%n%b`
 * payload so we exercise the same parser path production runs against.
 */
import { describe, expect, it } from 'vitest';
import { SageDomainTermExtractor } from '../src/domain-term-extractor.js';

const SUBJECT_HEADER = '--SUBJECT--';

interface FakeExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Build a `git log`-shaped payload that `extractCandidatesFromCommitSection`
 * actually consumes: header line, then subject, then body (-b implies the
 * body is on its own line(s) after the subject). The fake mimics the
 * output of `git --no-pager log --no-decorate -n N --pretty=format:--
 * SUBJECT--%n%s%n%b -p -U8`.
 */
function commitSection(subject: string, body = '', diff = ''): string {
  return `${SUBJECT_HEADER}\n${subject}\n${body}\n${diff}`;
}

function fakeExecFor(
  sections: readonly string[],
): (cmd: string, args: readonly string[]) => Promise<FakeExecResult> {
  return async () => ({
    stdout: sections.join('\n'),
    stderr: '',
  });
}

describe('SageDomainTermExtractor.extractFromCommits', () => {
  it('places the global --no-pager option before the log subcommand', async () => {
    const extractor = new SageDomainTermExtractor();
    let receivedArgs: readonly string[] = [];
    await extractor.extractFromCommits({
      projectRoot: '/fake/project',
      exec: async (_command, args) => {
        receivedArgs = args;
        return { stdout: '', stderr: '' };
      },
    });

    expect(receivedArgs.indexOf('--no-pager')).toBeGreaterThanOrEqual(0);
    expect(receivedArgs.indexOf('--no-pager')).toBeLessThan(receivedArgs.indexOf('log'));
  });

  it('returns an empty list when the fake exec yields zero commits', async () => {
    const extractor = new SageDomainTermExtractor();
    const terms = await extractor.extractFromCommits({
      projectRoot: '/fake/project',
      exec: fakeExecFor([]),
    });
    expect(terms).toEqual([]);
  });

  it('skips commits whose candidates are below minConfidence', async () => {
    const extractor = new SageDomainTermExtractor();
    const terms = await extractor.extractFromCommits({
      projectRoot: '/fake/project',
      minConfidence: 0.95, // very high bar — drops almost everything
      exec: fakeExecFor([commitSection('refactor: tighten regex')]),
    });
    // 'regex' is below 0.95 confidence; expect zero terms.
    expect(terms).toEqual([]);
  });

  it('extracts candidates that meet the confidence floor and sorts by confidence desc', async () => {
    const extractor = new SageDomainTermExtractor();
    const terms = await extractor.extractFromCommits({
      projectRoot: '/fake/project',
      minConfidence: 0.4,
      exec: fakeExecFor([
        commitSection(
          'feat: introduce DomainTermsPipeline and MailboxBridge subscriber',
          'Routes the session-end event through the new wiring.',
        ),
        commitSection('chore: lower noise in SageLogger'),
      ]),
    });
    // Both sections are above 0.4. The PascalCase identifier "MailboxBridge"
    // and the symbol "DomainTermsPipeline" should appear at minimum.
    const termNames = terms.map((t) => t.term);
    expect(termNames).toContain('MailboxBridge');
    expect(termNames).toContain('DomainTermsPipeline');
    // Sorted by confidence desc.
    for (let i = 1; i < terms.length; i += 1) {
      expect(terms[i - 1]!.confidence).toBeGreaterThanOrEqual(terms[i]!.confidence);
    }
  });

  it('caps the result to the requested limit', async () => {
    const extractor = new SageDomainTermExtractor();
    const sections = Array.from({ length: 6 }, (_, i) =>
      commitSection(`feat: rename Feature${i}Module and Other${i}Helper`),
    );
    const terms = await extractor.extractFromCommits({
      projectRoot: '/fake/project',
      limit: 3,
      exec: fakeExecFor(sections),
    });
    expect(terms.length).toBeLessThanOrEqual(3);
  });

  it('swallows exec failures and returns an empty list (never throws)', async () => {
    const extractor = new SageDomainTermExtractor();
    const failingExec = async () => {
      throw new Error('git not found');
    };
    const terms = await extractor.extractFromCommits({
      projectRoot: '/fake/project',
      exec: failingExec as unknown as Parameters<typeof extractor.extractFromCommits>[0]['exec'],
    });
    expect(terms).toEqual([]);
  });
});
