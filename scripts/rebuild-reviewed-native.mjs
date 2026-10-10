import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep the CI allowlist independent of branch-controlled trustedDependencies.
const reviewed = [
  ['electron-winstaller', '../apps/desktop/package.json'],
  ['esbuild', '../package.json'],
  ['node-pty', '../packages/webui/package.json'],
];
for (const [name, manifest] of reviewed) {
  const require = createRequire(new URL(manifest, import.meta.url));
  let packageFile;
  try {
    packageFile = require.resolve(`${name}/package.json`);
  } catch {
    // Transitive packages are intentionally hidden by the isolated linker.
    const root = fileURLToPath(new URL('..', import.meta.url));
    const candidates = [
      ...new Set(
        [
          ...new Bun.Glob(`node_modules/.bun/*/node_modules/${name}/package.json`).scanSync({
            cwd: root,
            dot: true,
          }),
        ].map((file) => realpathSync(resolve(root, file))),
      ),
    ];
    if (candidates.length !== 1)
      throw new Error(`Expected one installed ${name}, found ${candidates.length}`);
    packageFile = resolve(candidates[0]);
  }
  const pkg = JSON.parse(readFileSync(packageFile, 'utf8'));
  for (const phase of ['preinstall', 'install', 'postinstall']) {
    if (!pkg.scripts?.[phase]) continue;
    console.log(`Reviewed native dependency: ${name} ${phase}`);
    const result = spawnSync(process.execPath, ['--bun', 'run', phase], {
      cwd: dirname(packageFile),
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
