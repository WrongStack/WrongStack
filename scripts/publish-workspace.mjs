#!/usr/bin/env node
/**
 * Publish the workspace to npm in dependency layers, proving each layer is
 * resolvable on the registry before the next one goes out.
 *
 * The bug this replaces
 * --------------------
 * `pnpm publish -r` walks the workspace topologically but runs several
 * publishes concurrently, so the registry can observe them out of order. On
 * 0.317.2 the registry recorded:
 *
 *     wrongstack@0.317.2             2026-08-31T23:30:15.616Z
 *     @wrongstack/webui-hq@0.317.2   2026-08-31T23:30:40.814Z
 *
 * `wrongstack` -> `@wrongstack/cli` -> `@wrongstack/webui-hq`, all pinned to
 * the exact version, so for those 25 seconds the install target was on npm and
 * one of its transitive dependencies was not. `npm i -g wrongstack` in that
 * window died with `ETARGET No matching version found for
 * @wrongstack/webui-hq@0.317.2`, and because both npm's CDN and the client
 * cache packuments for about five minutes, users kept hitting the broken
 * resolution long after the 25-second gap closed.
 *
 * What this does instead
 * ----------------------
 *  1. Groups the publishable packages into layers (layer N depends only on
 *     layers < N) - see `scripts/lib/publishable-packages.mjs`.
 *  2. Publishes one layer at a time. (`pnpm publish` has no
 *     `--workspace-concurrency`, so the recursive publish could not just be
 *     serialized in place - the ordering has to come from outside pnpm.)
 *  3. After each layer, polls the registry until EVERY package in it resolves
 *     - abbreviated packument contains the version, and its tarball is
 *     fetchable - before publishing the next layer.
 *
 * Step 3 is the load-bearing one: it makes "the entrypoint is on npm before
 * its dependencies are" unrepresentable rather than unlikely. Re-running is
 * safe; npm rejects a duplicate version and pnpm skips packages already at the
 * target version.
 *
 * Usage:
 *   node scripts/publish-workspace.mjs [--dry-run] [--plan] [options] [-- <pnpm args>]
 *
 * Exit codes: 0 success; 1 publish or verification failure; 2 usage error.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { collectPublishablePackages, layerByDependencies } from './lib/publishable-packages.mjs';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
/** npm asks for this shape on install; verifying the same document is what proves a user can resolve. */
const PACKUMENT_ACCEPT = 'application/vnd.npm.install-v1+json';

const USAGE = `Usage: node scripts/publish-workspace.mjs [options] [-- <extra pnpm publish args>]

  --plan                 print the dependency-layer plan and exit
  --dry-run              pass --dry-run to pnpm/npm; skip registry verification
  --verify-only          verify the working-tree versions are live; publish nothing
  --no-verify            publish in order but skip registry verification
  --registry <url>       registry URL (default $WRONGSTACK_PUBLISH_REGISTRY or ${DEFAULT_REGISTRY})
  --verify-timeout <s>   per-layer verification budget, seconds (default 300)
  --verify-interval <s>  verification poll interval, seconds (default 5)
  --settle <s>           extra settle wait after the final layer (default 0)
  --pack                 pack every publishable package into tarballs and exit
                        (no publish). Run this in an UNPRIVILEGED job: packing
                        runs lifecycle scripts (prepack), which is exactly the
                        code that must never see the OIDC credential.
  --pack-destination <d> where --pack writes tarballs (default artifacts/npm-packs)
  --tarballs-dir <d>     publish PRE-PACKED tarballs from <d> with \`npm publish\`
                        instead of packing from the working tree. Designed for
                        the id-token job: no pnpm install, no lifecycle scripts,
                        no dependency code executes — only this script and the
                        Node-bundled npm. Tarball names follow npm's convention
                        (@scope/name@version -> scope-name-version.tgz) and are
                        asserted to exist before publishing.
  -h, --help             show this message
`;

/** Usage errors exit 2, matching the other script entrypoints in this repo. */
export class UsageError extends Error {}

/**
 * @param {string[]} argv
 * @returns {import('./publish-workspace.d.mts').PublishOptions}
 *   Parsed options — the field set is declared ONCE in publish-workspace.d.mts
 *   and imported here, so the two cannot drift (Chimera review).
 */
export function parseArgs(argv) {
  const options = {
    plan: false,
    dryRun: false,
    verifyOnly: false,
    verify: true,
    pack: false,
    packDestination: 'artifacts/npm-packs',
    tarballsDir: null,
    help: false,
    registry: process.env.WRONGSTACK_PUBLISH_REGISTRY || DEFAULT_REGISTRY,
    timeoutMs: 300_000,
    intervalMs: 5_000,
    settleMs: 0,
    /** @type {string[]} */ passthrough: [],
  };

  const separator = argv.indexOf('--');
  const flags = separator === -1 ? argv : argv.slice(0, separator);
  if (separator !== -1) options.passthrough = argv.slice(separator + 1);

  /**
   * @param {number} index
   * @param {string} flag
   * @returns {string}
   */
  const valueAt = (index, flag) => {
    const value = flags[index + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new UsageError(`Missing value for ${flag}.`);
    }
    return value;
  };
  /**
   * @param {string} raw
   * @param {string} flag
   * @returns {number} milliseconds
   */
  const seconds = (raw, flag) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new UsageError(`Invalid value for ${flag}: ${raw}`);
    }
    return Math.round(parsed * 1000);
  };

  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    switch (flag) {
      case '-h':
      case '--help':
        options.help = true;
        return options;
      case '--plan':
        options.plan = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--verify-only':
        options.verifyOnly = true;
        break;
      case '--pack':
        options.pack = true;
        break;
      case '--pack-destination':
        options.packDestination = valueAt(i, flag);
        i += 1;
        break;
      case '--tarballs-dir':
        options.tarballsDir = valueAt(i, flag);
        i += 1;
        break;
      case '--no-verify':
        options.verify = false;
        break;
      case '--registry':
        options.registry = valueAt(i, flag).replace(/\/+$/, '');
        i += 1;
        break;
      case '--verify-timeout':
        options.timeoutMs = seconds(valueAt(i, flag), flag);
        i += 1;
        break;
      case '--verify-interval':
        options.intervalMs = seconds(valueAt(i, flag), flag);
        i += 1;
        break;
      case '--settle':
        options.settleMs = seconds(valueAt(i, flag), flag);
        i += 1;
        break;
      default:
        throw new UsageError(`Unknown argument: ${flag}`);
    }
  }

  return options;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run pnpm, streaming its output. Rejects on a non-zero exit.
 * @param {string[]} args
 * @returns {Promise<void>}
 */
function runPnpm(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', args, {
      stdio: 'inherit',
      // pnpm ships as a .cmd shim on Windows, which cannot be exec'd directly.
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pnpm ${args.join(' ')} exited with code ${code}`));
    });
  });
}

/**
 * Run npm, streaming its output. Rejects on a non-zero exit. Used by the
 * tarball publish mode, which must not invoke pnpm (and therefore cannot run
 * any workspace lifecycle code) in the privileged job.
 * @param {string[]} args
 * @returns {Promise<void>}
 */
function runNpm(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm ${args.join(' ')} exited with code ${code}`));
    });
  });
}

/**
 * npm's tarball naming convention: `@scope/name@version` packs to
 * `scope-name-version.tgz` in the destination directory.
 * @param {string} dir
 * @param {string} name
 * @param {string} version
 * @returns {string}
 */
function tarballPath(dir, name, version) {
  return path.join(dir, `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`);
}

/**
 * Resolve the packed tarball for `name@version` inside `dir`. Expected name
 * first; a case-insensitive fallback second — pnpm's emitted filename can
 * diverge from the simple normalization formula for mixed-case names
 * (Chimera review). Matching by version suffix alone would be ambiguous
 * here: every workspace package shares one version in a pack run.
 * Ambiguity or absence stays a loud error with the directory listing —
 * publishing from a mismatched pack would ship layers out of sync.
 * @param {string} dir
 * @param {string} name
 * @param {string} version
 * @returns {string} resolved tarball path
 */
function resolveTarball(dir, name, version) {
  const expected = tarballPath(dir, name, version);
  if (existsSync(expected)) return expected;
  const expectedBasename = path.basename(expected).toLowerCase();
  if (existsSync(dir)) {
    const match = readdirSync(dir).find((f) => f.toLowerCase() === expectedBasename);
    if (match) return path.join(dir, match);
  }
  const produced = existsSync(dir) ? readdirSync(dir).join('\n  ') : '(directory missing)';
  throw new Error(
    `Expected packed tarball not found: ${expected}\n` +
      `Pack destination contains:\n  ${produced}\n\n` +
      `Refusing to continue: the pack step and this publish step disagree ` +
      `about what was built. Re-run the pack job.`,
  );
}

/**
 * Ask the registry whether `name@version` is installable right now.
 *
 * Deliberately fetches the abbreviated packument WITHOUT a cache-busting query
 * parameter: a unique URL would bypass the CDN edge and report the origin's
 * state, which is exactly the state that was already true during the 0.317.2
 * outage. `Cache-Control: no-cache` asks the edge to revalidate, so what comes
 * back is what a user's npm would be served.
 *
 * @param {string} registry
 * @param {string} name
 * @param {string} version
 * @param {{fetch?: typeof globalThis.fetch}} [deps] injection seam for tests
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function checkPublished(registry, name, version, deps = {}) {
  const get = deps.fetch ?? globalThis.fetch;
  let packument;
  try {
    const response = await get(`${registry}/${name.replace('/', '%2f')}`, {
      headers: { accept: PACKUMENT_ACCEPT, 'cache-control': 'no-cache' },
    });
    if (!response.ok) return { ok: false, reason: `packument HTTP ${response.status}` };
    packument = await response.json();
  } catch (error) {
    return { ok: false, reason: `packument fetch failed: ${error?.message ?? error}` };
  }

  const manifest = packument?.versions?.[version];
  if (!manifest) return { ok: false, reason: 'version missing from packument' };

  const tarball = manifest?.dist?.tarball;
  if (typeof tarball !== 'string') return { ok: false, reason: 'version has no dist.tarball' };

  // Metadata can land before the tarball is servable; an install needs both.
  try {
    const head = await get(tarball, { method: 'HEAD' });
    if (!head.ok) return { ok: false, reason: `tarball HTTP ${head.status}` };
  } catch (error) {
    return { ok: false, reason: `tarball fetch failed: ${error?.message ?? error}` };
  }

  return { ok: true };
}

/**
 * Poll until every package in the layer resolves, or the budget runs out.
 * @param {import('./lib/publishable-packages.d.mts').PublishablePackage[]} layer
 * @param {{registry: string, timeoutMs: number, intervalMs: number}} options
 * @returns {Promise<void>}
 */
async function verifyLayer(layer, { registry, timeoutMs, intervalMs }) {
  const deadline = Date.now() + timeoutMs;
  let pending = [...layer];
  /** @type {Map<string, string>} */
  const lastReason = new Map();

  for (;;) {
    const results = await Promise.all(
      pending.map(async (pkg) => ({
        pkg,
        result: await checkPublished(registry, pkg.name, pkg.version),
      })),
    );
    /** @type {typeof pending} */
    const stillPending = [];
    for (const { pkg, result } of results) {
      if (result.ok) {
        console.log(`   OK  ${pkg.name}@${pkg.version} resolvable`);
      } else {
        lastReason.set(pkg.name, result.reason);
        stillPending.push(pkg);
      }
    }
    pending = stillPending;
    if (pending.length === 0) return;

    if (Date.now() >= deadline) {
      const detail = pending
        .map((p) => `  ${p.name}@${p.version} - ${lastReason.get(p.name) ?? 'unknown'}`)
        .join('\n');
      throw new Error(
        `Registry did not serve ${pending.length} package(s) within ` +
          `${Math.round(timeoutMs / 1000)}s:\n${detail}\n\n` +
          'Publishing the next layer now would put a dependent on npm ahead of ' +
          'its dependencies - the exact failure this ordering exists to prevent.',
      );
    }
    console.log(`   ... waiting on ${pending.map((p) => p.name).join(', ')}`);
    await sleep(intervalMs);
  }
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} process exit code
 */
export async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const { publishable, skipped } = collectPublishablePackages();
  if (publishable.length === 0) {
    console.error('No publishable workspace packages found.');
    return 1;
  }

  const { layers, cycles } = layerByDependencies(publishable);

  console.log(
    `${publishable.length} publishable package(s) in ${layers.length} dependency layer(s):\n`,
  );
  layers.forEach((layer, index) => {
    console.log(`  layer ${index + 1}: ${layer.map((p) => p.name).join(', ')}`);
  });
  if (cycles.length > 0) {
    console.warn(
      `\n! Dependency cycle among: ${cycles.join(', ')}\n` +
        '  These publish together; their relative order is not guaranteed.',
    );
  }
  if (skipped.length > 0) console.log(`\nNot published: ${skipped.join(', ')}`);
  console.log('');

  if (options.plan) return 0;

  if (options.pack) {
    // Pack mode (M13/VF-19): produce npm tarballs WITHOUT publishing. Runs in
    // the unprivileged `pack` CI job — packing executes lifecycle scripts
    // (prepack), which is exactly the code that must never see the OIDC
    // credential held by the publish job.
    const total = layers.reduce((n, l) => n + l.length, 0);
    console.log(`\nPacking ${total} publishable package(s) into ${options.packDestination}`);
    for (const layer of layers) {
      for (const p of layer) {
        await runPnpm([
          '--filter',
          p.name,
          'pack',
          '--pack-destination',
          options.packDestination,
        ]);
        resolveTarball(options.packDestination, p.name, p.version);
      }
    }
    console.log(`\nPacked ${total} tarball(s) into ${options.packDestination}`);
    return 0;
  }

  const verify = options.verify && !options.dryRun;

  if (options.verifyOnly) {
    console.log(`Verifying working-tree versions against ${options.registry} ...`);
    try {
      for (const [index, layer] of layers.entries()) {
        console.log(`\nLayer ${index + 1}/${layers.length}`);
        await verifyLayer(layer, options);
      }
    } catch (error) {
      console.error(`\n${error.message}`);
      return 1;
    }
    console.log('\nAll working-tree versions are live and installable.');
    return 0;
  }

  for (const [index, layer] of layers.entries()) {
    console.log(`\n-- Layer ${index + 1}/${layers.length}: publishing ${layer.length} package(s)`);
    const filters = layer.flatMap((p) => ['--filter', p.name]);
    const args = [
      ...filters,
      'publish',
      '--access',
      'public',
      // No concurrency flag: `pnpm publish` rejects `--workspace-concurrency`,
      // which is exactly why `pnpm publish -r` could not simply be serialized
      // and why the ordering has to be imposed from outside. Concurrency
      // WITHIN a layer is harmless — by construction nothing in a layer
      // depends on anything else in it.
      ...(options.registry === DEFAULT_REGISTRY ? [] : ['--registry', options.registry]),
      ...(options.dryRun ? ['--dry-run'] : []),
      ...options.passthrough,
    ];
    try {
      if (options.tarballsDir) {
        // Tarball mode (M13/VF-19): publish exactly what the unprivileged
        // pack job already packed, in dependency layers, via `npm publish`.
        // No pnpm runs here — no install, build, or lifecycle script of any
        // dependency can execute under this job's OIDC credential; only this
        // script and the Node-bundled npm run. npm attaches the provenance
        // attestation automatically from the ambient OIDC token; an explicit
        // --provenance flag would break every non-GitHub-Actions invocation
        // (Chimera review).
        for (const p of layer) {
          const tarball = resolveTarball(options.tarballsDir, p.name, p.version);
          // workflow_dispatch re-run recovery: npm publish of an existing
          // version fails the whole job with E403 instead of skipping it
          // (Chimera review), which would break the documented "re-run
          // resumes a partly-failed publish" contract. Ask the registry
          // first and skip packages that are already live — the same
          // semantics pnpm's own publish path has.
          if (!options.dryRun) {
            const live = await checkPublished(options.registry, p.name, p.version);
            if (live.ok) {
              console.log(`   SKIP ${p.name}@${p.version} — already live on the registry`);
              continue;
            }
          }
          await runNpm([
            'publish',
            tarball,
            '--access',
            'public',
            ...(options.registry === DEFAULT_REGISTRY ? [] : ['--registry', options.registry]),
            ...(options.dryRun ? ['--dry-run'] : []),
          ]);
        }
      } else {
        await runPnpm(args);
      }
    } catch (error) {
      console.error(`\nLayer ${index + 1} publish failed: ${error.message}`);
      console.error('Already-published layers stay published; re-running this script skips them.');
      return 1;
    }

    if (!verify) {
      console.log('   (verification skipped)');
      continue;
    }
    console.log(`   verifying layer ${index + 1} against ${options.registry} ...`);
    try {
      await verifyLayer(layer, options);
    } catch (error) {
      console.error(`\n${error.message}`);
      return 1;
    }
  }

  if (verify && options.settleMs > 0) {
    console.log(`\nSettling for ${Math.round(options.settleMs / 1000)}s ...`);
    await sleep(options.settleMs);
  }

  console.log(
    options.dryRun
      ? '\nDry run complete - nothing was published.'
      : '\nAll layers published and confirmed resolvable.',
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
