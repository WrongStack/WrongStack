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
 * its dependencies are" unrepresentable rather than unlikely.
 *
 * Resuming a partial release
 * --------------------------
 * Steps 1-3 are sequential, so anything that stops the run - a slow registry, a
 * dropped connection, Ctrl-C - stops it midway with the earlier layers already
 * published. That is fine by design, but only if re-running finishes the job.
 * It did not: `pnpm publish` invoked per-package through `--filter` does not
 * skip a version npm already has, it exits non-zero on E403, so the re-run died
 * on layer 1 of a release that had reached layer 8. The recovery that looked
 * available was a version bump, which republishes every unchanged package and
 * strands the half-finished version on npm forever.
 *
 * So step 0: before publishing a layer, ask the registry which of its packages
 * are already live and publish only the rest (`partitionLive`). The registry is
 * the resume state - there is no local file to go stale across machines, CI
 * re-runs, or crashes. A verification timeout is also reported as its own thing
 * (exit 3, `VerificationTimeoutError`) rather than as a publish failure, because
 * the two call for opposite reactions and only one of them is alarming.
 *
 * Usage:
 *   node scripts/publish-workspace.mjs [--dry-run] [--plan] [options] [-- <pnpm args>]
 *
 * Exit codes: 0 success; 1 publish failure; 2 usage error; 3 published but the
 * registry had not served a layer in time - re-run to resume.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { collectPublishablePackages, layerByDependencies } from './lib/publishable-packages.mjs';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
/**
 * Printed on every non-success exit. Spelling out "do not bump" is the point:
 * the release that motivated this text stalled on layer 8 of 10, and the bump
 * that followed turned 5 remaining publishes into 36.
 */
const RESUME_HINT =
  'Nothing is lost and no version bump is needed. Re-run the same command: ' +
  'every package already on the registry is skipped, so only the remainder ' +
  'publishes. `pnpm release:verify` shows what is still missing.';
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
 * The registry did not serve a layer within its budget.
 *
 * Distinct from a publish failure on purpose. A publish failure means bits did
 * not leave the machine; a verification timeout means they did and npm has not
 * caught up. Collapsing the two into "exit 1, layer N failed" is what made a
 * slow propagation read as a broken release and pushed the operator into a
 * version bump - the one recovery that cannot be undone.
 */
export class VerificationTimeoutError extends Error {}

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
    return {
      ok: false,
      reason: `packument fetch failed: ${error?.message ?? error}`,
    };
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
    return {
      ok: false,
      reason: `tarball fetch failed: ${error?.message ?? error}`,
    };
  }

  return { ok: true };
}

/**
 * Ask the registry ORIGIN whether it has already accepted `name@version`.
 *
 * This answers a different question from `checkPublished`, and conflating the
 * two is what broke the 1.0.6 release. `checkPublished` answers "can a user
 * install this right now?", so it must read through the CDN edge - the edge IS
 * the user's view. The resume path asks "did I already send this?", and for
 * that the edge is the wrong oracle: npm had `@wrongstack/cli@1.0.6` staged
 * while the edge still served a packument without it, so the re-run decided the
 * package was unpublished, published it again, and npm answered
 * `409 Cannot publish over previously staged version "1.0.6"` - a hard failure
 * on a release that had, in fact, fully succeeded.
 *
 * `?write=true` is npm's documented origin read (it is what the publish client
 * itself uses) and returns the full packument, bypassing the edge cache.
 * There is no tarball check here on purpose: whether the bits are servable yet
 * is a propagation question, and propagation is `verifyLayer`'s job. All this
 * decides is whether publishing again would be a duplicate.
 *
 * @param {string} registry
 * @param {string} name
 * @param {string} version
 * @param {{fetch?: typeof globalThis.fetch}} [deps] injection seam for tests
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function checkOriginHasVersion(registry, name, version, deps = {}) {
  const get = deps.fetch ?? globalThis.fetch;
  try {
    const response = await get(`${registry}/${name.replace('/', '%2f')}?write=true`, {
      headers: { accept: 'application/json', 'cache-control': 'no-store' },
    });
    if (!response.ok) return { ok: false, reason: `origin packument HTTP ${response.status}` };
    const packument = await response.json();
    if (!packument?.versions?.[version]) {
      return { ok: false, reason: 'version missing from origin packument' };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `origin packument fetch failed: ${error?.message ?? error}`,
    };
  }
}

/**
 * Split a layer into what the registry already serves and what still has to be
 * published.
 *
 * This is the resume primitive, and it is the difference between "re-running is
 * safe" being a claim in a comment and being true. `pnpm publish` does NOT
 * reliably skip a version that is already on the registry when it is invoked
 * per-package through `--filter`: npm answers E403 ("cannot publish over the
 * previously published version") and pnpm surfaces that as a non-zero exit, so
 * a re-run after a partial release died on layer 1 with every earlier layer
 * already live. The only recoveries left were bumping the version - republishing
 * 31 unchanged packages to get 5 out - or hand-editing the layer list.
 *
 * The registry is the state store here on purpose. A local resume file would be
 * one more thing that can disagree with reality after a crash, a different
 * machine, or a CI re-run; asking npm what it serves cannot go stale.
 *
 * Three buckets, not two, because "npm has it" and "users can install it" are
 * different facts and the gap between them is real (see
 * `checkOriginHasVersion`):
 *
 *   live    - the edge serves it. Nothing to publish, nothing to wait for.
 *   staged  - the origin has it, the edge does not. Publishing again is the
 *             409 that killed the 1.0.6 re-run, so it must be SKIPPED - but it
 *             is NOT yet installable, so it must still be VERIFIED before the
 *             next layer goes out. Dropping it from the verify set would hand
 *             back exactly the ETARGET window this script exists to close.
 *   pending - neither. Publish it.
 *
 * @param {import('./lib/publishable-packages.d.mts').PublishablePackage[]} layer
 * @param {{registry: string}} options
 * @param {{checkPublished?: typeof checkPublished,
 *          checkOriginHasVersion?: typeof checkOriginHasVersion}} [deps] injection seam for tests
 * @returns {Promise<{live: typeof layer, staged: typeof layer, pending: typeof layer}>}
 */
export async function partitionLive(layer, { registry }, deps = {}) {
  const check = deps.checkPublished ?? checkPublished;
  const checkOrigin = deps.checkOriginHasVersion ?? checkOriginHasVersion;
  const results = await Promise.all(
    layer.map(async (pkg) => {
      if ((await check(registry, pkg.name, pkg.version)).ok) return { pkg, bucket: 'live' };
      // Only ask the origin once the edge has said no: on a fresh release that
      // is one extra round trip for packages that were never published, and on
      // a resume it is the whole difference between skipping and a 409.
      const staged = (await checkOrigin(registry, pkg.name, pkg.version)).ok;
      return { pkg, bucket: staged ? 'staged' : 'pending' };
    }),
  );
  const bucket = (name) => results.filter((r) => r.bucket === name).map((r) => r.pkg);
  return {
    live: bucket('live'),
    staged: bucket('staged'),
    pending: bucket('pending'),
  };
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
      throw new VerificationTimeoutError(
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
        await runPnpm(['--filter', p.name, 'pack', '--pack-destination', options.packDestination]);
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
    console.log(`\n-- Layer ${index + 1}/${layers.length}: ${layer.length} package(s)`);

    // Resume: ask the registry what it already serves and publish only the rest.
    // On a fresh release this costs one round trip per package and skips
    // nothing; after a partial release it is the whole recovery.
    let todo = layer;
    /**
     * Published by an earlier run but not yet servable. Skipped by the publish
     * step and added back for verification — see `partitionLive`.
     * @type {typeof layer}
     */
    let staged = [];
    if (!options.dryRun) {
      const partitioned = await partitionLive(layer, options);
      staged = partitioned.staged;
      for (const p of partitioned.live) {
        console.log(`   SKIP ${p.name}@${p.version} - already live on the registry`);
      }
      for (const p of staged) {
        console.log(`   SKIP ${p.name}@${p.version} - npm already has it; waiting on propagation`);
      }
      todo = partitioned.pending;
      if (todo.length === 0 && staged.length === 0) {
        // Nothing to publish and nothing in flight: `live` came from the same
        // check `verifyLayer` polls, so the layer is already proven.
        console.log('   layer already complete');
        continue;
      }
    }

    if (todo.length > 0) console.log(`   publishing ${todo.length} package(s)`);
    const filters = todo.flatMap((p) => ['--filter', p.name]);
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
      if (todo.length === 0) {
        // Only propagation left. Fall through to verification.
      } else if (options.tarballsDir) {
        // Tarball mode (M13/VF-19): publish exactly what the unprivileged
        // pack job already packed, in dependency layers, via `npm publish`.
        // No pnpm runs here — no install, build, or lifecycle script of any
        // dependency can execute under this job's OIDC credential; only this
        // script and the Node-bundled npm run. npm attaches the provenance
        // attestation automatically from the ambient OIDC token; an explicit
        // --provenance flag would break every non-GitHub-Actions invocation
        // (Chimera review).
        // Already-live packages were filtered out above, which is what makes a
        // workflow_dispatch re-run resume instead of dying on npm's E403.
        for (const p of todo) {
          const tarball = resolveTarball(options.tarballsDir, p.name, p.version);
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
      // A non-zero exit is not proof that nothing landed. npm rejects a
      // duplicate with E403 ("cannot publish over the previously published
      // version") or 409 ("cannot publish over previously staged version"),
      // and pnpm surfaces both as exit 1 — so the run that already succeeded
      // reports itself as failed. Ask the origin what it actually holds rather
      // than parsing that message: the text differs across npm and pnpm
      // versions and is localized, while the registry's answer is the fact we
      // need. If every package in this layer is there, the layer is done and
      // the only thing left is propagation.
      //
      // Not in --dry-run: nothing was being published there, so a non-zero exit
      // is a fact about THIS run (an unclean tree, a bad flag) and must stay
      // loud. Without this guard a dry run of an already-released version
      // reports every real problem as "npm already holds it - continuing".
      const stillMissing = options.dryRun ? todo : [];
      if (!options.dryRun) {
        for (const p of todo) {
          if (!(await checkOriginHasVersion(options.registry, p.name, p.version)).ok) {
            stillMissing.push(p);
          }
        }
      }
      if (stillMissing.length > 0) {
        console.error(`\nLayer ${index + 1} publish failed: ${error.message}`);
        console.error(
          `Not on the registry: ${stillMissing.map((p) => `${p.name}@${p.version}`).join(', ')}`,
        );
        console.error(RESUME_HINT);
        return 1;
      }
      console.log(
        `   publish exited non-zero, but npm holds every package in layer ${index + 1} ` +
          '(duplicate publish of an already-accepted version) - continuing',
      );
      staged = [...staged, ...todo];
      todo = [];
    }

    if (!verify) {
      console.log('   (verification skipped)');
      continue;
    }
    console.log(`   verifying layer ${index + 1} against ${options.registry} ...`);
    try {
      await verifyLayer([...staged, ...todo], options);
    } catch (error) {
      console.error(`\n${error.message}`);
      if (error instanceof VerificationTimeoutError) {
        console.error(
          `\nThis is NOT a publish failure. Layers 1-${index + 1} left this machine and ` +
            'npm has them; the registry just has not served them yet.',
        );
        // The budget only buys the ORDERING guarantee: no dependent may reach
        // npm before its dependencies. On the last layer there is no next layer
        // to hold back, so waiting longer protects nothing — every package is
        // published and the edge will catch up on its own. Failing here is what
        // made a finished 1.0.6 release look broken and sent the operator into
        // a re-publish that answered 409.
        if (index === layers.length - 1) {
          console.error(
            '\nNothing depends on the final layer, so there is no ordering left to protect: ' +
              'the release is COMPLETE and the edge is still catching up. ' +
              'Confirm with `pnpm release:verify` when it settles.',
          );
          return 0;
        }
        console.error(RESUME_HINT);
        return 3;
      }
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
