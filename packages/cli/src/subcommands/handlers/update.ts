import { spawn } from 'node:child_process';
import { checkForUpdate } from '../../update-check.js';
import type { SubcommandHandler } from '../index.js';

/** `wrongstack update` — Update the CLI via npm */
export const updateCmd: SubcommandHandler = async (args, deps) => {
  const cwd = deps.cwd;

  // --check-only: check only, don't install
  const checkOnly = args.includes('--check-only') || args.includes('-c');

  const info = await checkForUpdate();

  if (checkOnly) {
    if (info.outdated) {
      deps.renderer.write(`Update available: v${info.current} → v${info.latest}\n`);
    } else {
      deps.renderer.write(`You are on the latest version: v${info.current}\n`);
    }
    return 0;
  }

  if (!info.outdated) {
    deps.renderer.write(`You are already on the latest version: v${info.current}\n`);
    return 0;
  }

  deps.renderer.write(`Updating wrongstack from v${info.current} to v${info.latest}...\n`);

  // npm install -g wrongstack@latest
  try {
    const result = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
      const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const child = spawn(npmCommand, ['install', '-g', 'wrongstack@latest'], {
        cwd,
        stdio: 'pipe',
        signal: AbortSignal.timeout(120_000),
        windowsHide: true,
      });
      let stderr = '';
      child.stderr?.on('data', (d) => {
        stderr += d;
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 0, stderr }));
    });

    if (result.code === 0) {
      deps.renderer.write(
        `\nUpdated to v${info.latest}. Restart wrongstack to use the new version.\n`,
      );
    } else {
      // A bare "exit code 243" is opaque — npm's actual reason (EACCES, a custom
      // prefix it can't write, a pnpm/yarn/bun global that npm doesn't own) lives
      // in stderr, which used to be collected and thrown away (#13). Surface it,
      // then point at the package-manager-specific update command so users who
      // didn't install via npm have a working path forward.
      deps.renderer.write(`\nUpdate failed with exit code ${result.code}.\n`);
      const detail = result.stderr.trim();
      if (detail) deps.renderer.write(`\n${detail}\n`);
      deps.renderer.write(
        '\nWrongStack updates itself with npm. If you installed it with a different\n' +
          'package manager, update with the matching command instead:\n' +
          '  pnpm add -g wrongstack@latest\n' +
          '  yarn global add wrongstack@latest\n' +
          '  bun  add -g wrongstack@latest\n',
      );
    }
    return result.code;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) {
      deps.renderer.write(`\nUpdate failed: npm not found in PATH.\n`);
      return 1;
    }
    deps.renderer.write(`\nUpdate failed: ${msg}\n`);
    return 1;
  }
};
