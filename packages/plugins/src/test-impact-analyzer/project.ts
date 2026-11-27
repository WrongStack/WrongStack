import { parseUnifiedDiff } from '../evidence-analyzer/diff.js';
import {
  changedFiles,
  type EvidenceFinding,
  exists,
  gitRead,
  isTestPath,
  type ProjectCollectContext,
  type ProjectCollection,
  readText,
  SOURCE_EXTENSIONS,
} from '../evidence-analyzer/project.js';

const MAX_TEST_FILES_READ = 3000;
const MAX_CANDIDATES = 5;

export function isCodePath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot > 0 && SOURCE_EXTENSIONS.has(path.slice(dot)) && !path.endsWith('.d.ts');
}

/** `src/tool-diff.ts` and `tests/tool-diff.test.ts` share the stem `tool-diff`. */
export function testStem(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base
    .replace(/\.[^.]+$/, '')
    .replace(/\.(?:test|spec)$/, '')
    .replace(/^test_/, '')
    .replace(/_test$/, '')
    .toLowerCase();
}

const FOCUS_RULE = /\b(?:(?:it|test|describe|context)\.only\(|f(?:it|describe)\()/;
const SKIP_RULE =
  /\b(?:(?:it|test|describe)\.(?:skip|todo)\(|x(?:it|describe|test)\(|@pytest\.mark\.skip|t\.Skip\()/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Map changed source to existing tests and flag focus/skip markers added to tests. */
export async function collectTestImpact(
  context: ProjectCollectContext,
): Promise<ProjectCollection> {
  const { root, signal } = context;
  const changed = await changedFiles(root, signal);
  if (changed === null) {
    throw new Error(
      'test_impact_analyze could not read the changed files (not a git repository, no commits, or git unavailable); pass a diff as content instead',
    );
  }
  const code = changed.filter(isCodePath);
  const changedTests = code.filter(isTestPath);
  const changedSource = code.filter((path) => !isTestPath(path));
  const allFiles = ((await gitRead(root, ['ls-files'], signal)) ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const testIndex = [...new Set([...allFiles, ...changedTests])].filter(
    (path) => isTestPath(path) && isCodePath(path),
  );
  const packageRootCache = new Map<string, string>();
  const packageRoot = async (path: string): Promise<string> => {
    const parts = path.split('/');
    for (let i = parts.length - 1; i > 0; i--) {
      const dir = parts.slice(0, i).join('/');
      const cached = packageRootCache.get(dir);
      if (cached !== undefined) return cached;
      for (const marker of ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']) {
        if (await exists(root, `${dir}/${marker}`)) {
          packageRootCache.set(dir, dir);
          return dir;
        }
      }
    }
    return '';
  };
  const testContent = new Map<string, string>();
  let testsRead = 0;
  const readTest = async (path: string): Promise<string> => {
    const cached = testContent.get(path);
    if (cached !== undefined) return cached;
    if (testsRead >= MAX_TEST_FILES_READ) return '';
    testsRead += 1;
    const text = (await readText(root, path, 512 * 1024)) ?? '';
    testContent.set(path, text);
    return text;
  };

  const findings: EvidenceFinding[] = [];
  const suggested = new Set<string>();
  const changedTestStems = new Set(changedTests.map(testStem));
  let untested = 0;
  for (const source of changedSource) {
    signal.throwIfAborted();
    const stem = testStem(source);
    const pkg = await packageRoot(source);
    const inPackage = testIndex.filter((test) => (pkg ? test.startsWith(`${pkg}/`) : true));
    let candidates = inPackage.filter((test) => {
      const testName = testStem(test);
      return (
        testName === stem || testName.startsWith(`${stem}-`) || testName.startsWith(`${stem}.`)
      );
    });
    if (candidates.length === 0 && stem.length >= 3 && stem !== 'index') {
      const importRef = new RegExp(`[/'"]${escapeRegExp(stem)}(?:\\.[cm]?[jt]sx?)?['"]`, 'i');
      const referencing: string[] = [];
      for (const test of inPackage) {
        if (importRef.test(await readTest(test))) referencing.push(test);
        if (referencing.length >= MAX_CANDIDATES) break;
      }
      candidates = referencing;
    }
    candidates = candidates.slice(0, MAX_CANDIDATES);
    for (const candidate of candidates) suggested.add(candidate);
    const covered =
      changedTestStems.has(stem) ||
      candidates.some((candidate) => changedTests.includes(candidate));
    if (covered) continue;
    untested += 1;
    findings.push({
      rule: 'source change without a changed test',
      severity: 'warning',
      file: source,
      line: 0,
      excerpt:
        candidates.length > 0
          ? `existing tests to run: ${candidates.join(', ')}`
          : 'no existing test file found by name or import',
      advice:
        candidates.length > 0
          ? 'Run the listed tests; add a regression case there if the behavior changed.'
          : 'Add a focused test for the changed behavior.',
    });
  }

  if (changedTests.length > 0) {
    const diff =
      (await gitRead(
        root,
        [
          'diff',
          'HEAD',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '-U0',
          '--',
          ...changedTests,
        ],
        signal,
      )) ?? '';
    const added = new Map<string, Array<{ line: number; text: string }>>();
    for (const file of parseUnifiedDiff(diff)) added.set(file.path, file.added);
    for (const test of changedTests) {
      if (added.has(test)) continue;
      // Untracked test file: every line is new.
      const text = await readTest(test);
      added.set(
        test,
        text.split('\n').map((line, index) => ({ line: index + 1, text: line })),
      );
    }
    for (const [file, lines] of added) {
      for (const { line, text } of lines) {
        if (FOCUS_RULE.test(text)) {
          findings.push({
            rule: 'focused test committed',
            severity: 'error',
            file,
            line,
            excerpt: text.trim().slice(0, 240),
            advice: 'Remove .only before merging: it silently skips every other test in the file.',
          });
        } else if (SKIP_RULE.test(text)) {
          findings.push({
            rule: 'skipped test added',
            severity: 'warning',
            file,
            line,
            excerpt: text.trim().slice(0, 240),
            advice: 'Record why the scenario is skipped and restore coverage when practical.',
          });
        }
      }
    }
  }
  const rank = { error: 0, warning: 1, info: 2 } as const;
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return {
    findings,
    inspected: [
      'git diff HEAD',
      'git ls-files',
      ...(testsRead > 0 ? [`${testsRead} test file(s)`] : []),
    ],
    facts: {
      changedSource: changedSource.length,
      changedTests: changedTests.length,
      untestedSource: untested,
      suggestedTests: [...suggested].slice(0, 30),
    },
    limitation:
      'Tests are matched to source by file name and literal import references, not by executing coverage. Run facts.suggestedTests to measure.',
  };
}
