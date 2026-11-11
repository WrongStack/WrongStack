import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portableDirectory } from '../scripts/portable.ts';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '../..');
const source = await readFile(join(app, 'tests/native-smoke.mjs'), 'utf8');
const available = [
  ...source.matchAll(/^const \w+Only = process\.argv\.includes\('([^']+)'\);/gm),
].map((match) => match[1]);
const priorities = [
  '--parity-cards',
  '--chimera',
  '--brain-policy',
  '--multi',
  '--perf',
  '--a11y',
  '--gaps',
];
const selected = process.argv.slice(2);
if (selected.some((scope) => scope !== 'default' && !available.includes(scope)))
  throw Error('Unknown native scope');
const scopes = selected.length
  ? selected
  : [
      ...new Set([...priorities.filter((scope) => available.includes(scope)), ...available]),
      'default',
    ];
const portable = process.env.WRONGSTACK_DESKTOP_TEST_PORTABLE ?? portableDirectory(app);
const identity = portable.split(/[/\\]/).at(-1);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = join(repo, '.temp_files', 'desktop-parity-acceptance', 'matrix-' + stamp);
await mkdir(directory, { recursive: true });
const fingerprint = async () => {
  const files = (await readdir(join(app, 'tests')))
    .filter(
      (name) =>
        /^native-.*\.(?:mjs|ps1)$/.test(name) ||
        name === 'local-provider.mjs' ||
        name === 'transcript-test-helpers.mjs',
    )
    .sort();
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update(await readFile(join(app, 'tests', file)));
  return hash.digest('hex');
};
const harnessHash = await fingerprint();
const report = {
  startedAt: new Date().toISOString(),
  finishedAt: null,
  portableIdentity: identity,
  portable,
  artifactDirectory: directory,
  harnessHash,
  runtime: { bun: process.versions.bun ?? null, nodeCompatibility: process.version },
  scopes,
  results: [],
};
const save = () =>
  writeFile(
    join(directory, 'matrix.json'),
    JSON.stringify({ ...report, notRun: scopes.length - report.results.length }, null, 2) + '\n',
  );
await save();
console.log(
  'MATRIX ' + JSON.stringify({ portableIdentity: identity, cases: scopes.length, directory }),
);
for (const scope of scopes) {
  if ((await fingerprint()) !== harnessHash)
    throw Error(
      'Native test sources changed during the matrix; previous case records remain available',
    );
  const started = Date.now();
  const label = scope === 'default' ? 'default' : scope.slice(2);
  console.log('RUN ' + label);
  const child = spawn(
    process.execPath,
    ['tests/native-smoke.mjs', ...(scope === 'default' ? [] : [scope]), '--release', '--bundled'],
    {
      cwd: app,
      windowsHide: true,
      env: { ...process.env, WRONGSTACK_DESKTOP_TEST_PORTABLE: portable },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '',
    stderr = '';
  let pendingLine = '';
  child.stdout.on('data', (data) => {
    const chunk = String(data);
    stdout += chunk;
    pendingLine += chunk;
    const lines = pendingLine.split('\n');
    pendingLine = lines.pop() ?? '';
    for (const line of lines)
      if (line.startsWith('PASS:')) console.log('STEP ' + label + ' ' + line.slice(6).trim());
  });
  child.stderr.on('data', (data) => (stderr += String(data)));
  const timer = setInterval(
    () => console.log('RUNNING ' + label + ' ' + Math.round((Date.now() - started) / 1000) + 's'),
    30000,
  );
  const code = await new Promise((done) => {
    child.once('error', (error) => {
      stderr += String(error);
      done(-1);
    });
    child.once('exit', (value) => done(value ?? -1));
  });
  clearInterval(timer);
  await writeFile(join(directory, label + '.log'), stdout + '\n' + stderr);
  let native = null;
  for (const line of stdout.split('\n')) {
    try {
      const value = JSON.parse(line);
      if (value?.result === 'PASS' && value?.portableIdentity === identity) native = value;
    } catch {}
  }
  const entry = {
    scope,
    code,
    result: code === 0 && native ? 'PASS' : 'FAIL',
    seconds: Math.round((Date.now() - started) / 1000),
    verifiedAt: new Date().toISOString(),
    native,
    log: join(directory, label + '.log'),
  };
  report.results.push(entry);
  await save();
  console.log(entry.result + ' ' + label + ' ' + entry.seconds + 's');
  if (entry.result === 'FAIL') console.log((stderr || stdout).slice(-2200));
  if (entry.result === 'FAIL' && process.env.WRONGSTACK_DESKTOP_NATIVE_MATRIX_FAIL_FAST === '1')
    break;
}
report.finishedAt = new Date().toISOString();
await save();
const passed = report.results.filter((entry) => entry.result === 'PASS').length;
console.log(
  'MATRIX RESULT ' +
    JSON.stringify({
      passed,
      failed: report.results.length - passed,
      total: scopes.length,
      notRun: scopes.length - report.results.length,
      directory,
      portableIdentity: identity,
    }),
);
process.exitCode = passed === scopes.length ? 0 : 1;
