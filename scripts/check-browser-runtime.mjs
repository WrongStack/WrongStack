#!/usr/bin/env node
/**
 * First-party browser runtime doctor and repair command.
 *
 * This intentionally invokes Playwright's CLI through Node instead of a package
 * manager shim, so it also works in npm installations and release jobs where
 * `pnpm exec` is not available.
 *
 *   node scripts/check-browser-runtime.mjs
 *   node scripts/check-browser-runtime.mjs --install [--with-deps]
 *   node scripts/check-browser-runtime.mjs --smoke
 */
import { spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

function usage() {
  return `Usage: node scripts/check-browser-runtime.mjs [options]

Options:
  --install     Install the bundled Chromium revision when it is missing
  --with-deps   Also install Linux system dependencies (requires --install)
  --smoke       Launch Chromium and run a local interaction smoke test
  --json        Emit the final diagnostic as JSON
  --help        Show this help
`;
}

function parseArgs(argv) {
  const known = new Set(['--install', '--with-deps', '--smoke', '--json', '--help']);
  const unknown = argv.filter((arg) => !known.has(arg));
  if (unknown.length > 0) throw new Error(`Unknown option: ${unknown.join(', ')}`);

  const options = {
    install: argv.includes('--install'),
    withDeps: argv.includes('--with-deps'),
    smoke: argv.includes('--smoke'),
    json: argv.includes('--json'),
    help: argv.includes('--help'),
  };
  if (options.withDeps && !options.install) {
    throw new Error('--with-deps requires --install');
  }
  return options;
}

async function loadPlaywright() {
  try {
    return await import('@playwright/test');
  } catch (error) {
    throw new Error(
      `Cannot load @playwright/test. Install project dependencies first. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function resolvePlaywrightCli() {
  const testPackage = require.resolve('@playwright/test/package.json');
  const packageRequire = createRequire(testPackage);
  const playwrightPackage = packageRequire.resolve('playwright/package.json');
  const cli = join(dirname(playwrightPackage), 'cli.js');
  if (!existsSync(cli)) throw new Error(`Playwright CLI was not found at ${cli}`);
  return cli;
}

async function inspect(chromium) {
  const executablePath = chromium.executablePath();
  try {
    await access(executablePath, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return { available: true, executablePath };
  } catch {
    return { available: false, executablePath };
  }
}

async function installChromium(withDeps) {
  const cli = resolvePlaywrightCli();
  const args = [cli, 'install'];
  if (withDeps) args.push('--with-deps');
  args.push('chromium');

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Playwright installer terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) throw new Error(`Playwright installer exited with code ${exitCode}`);
}

async function smokeTest(chromium) {
  const args = process.platform === 'linux' ? ['--disable-gpu'] : [];
  const browser = await chromium.launch({ headless: true, timeout: 20_000, args });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<!doctype html><title>WrongStack browser smoke</title>' +
        '<button id="probe" onclick="this.textContent=\'ready\'">probe</button>',
    );
    await page.locator('#probe').click();
    const title = await page.title();
    const text = await page.locator('#probe').textContent();
    if (title !== 'WrongStack browser smoke' || text !== 'ready') {
      throw new Error(
        `Unexpected smoke result: title=${JSON.stringify(title)}, text=${JSON.stringify(text)}`,
      );
    }
    return { passed: true, title };
  } finally {
    await browser.close();
  }
}

function report(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const mark = result.available ? 'PASS' : 'FAIL';
  process.stdout.write(`[${mark}] Chromium executable  ${result.executablePath}\n`);
  if (result.installed) process.stdout.write('[PASS] Chromium repair     installation completed\n');
  if (result.smoke?.passed)
    process.stdout.write(`[PASS] Browser smoke       ${result.smoke.title}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const { chromium } = await loadPlaywright();
  let diagnostic = await inspect(chromium);
  let installed = false;

  if (options.install && (!diagnostic.available || options.withDeps)) {
    await installChromium(options.withDeps);
    installed = true;
    diagnostic = await inspect(chromium);
  }

  if (!diagnostic.available) {
    report({ ...diagnostic, installed }, options.json);
    throw new Error('Chromium is not installed. Re-run with --install.');
  }

  const smoke = options.smoke ? await smokeTest(chromium) : undefined;
  report({ ...diagnostic, installed, smoke }, options.json);
}

main().catch((error) => {
  process.stderr.write(
    `Browser runtime check failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
