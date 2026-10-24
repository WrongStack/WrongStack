/**
 * `wstack typesafe` — the account surface for the System One features.
 *
 * TypeSafe is not a provider and deliberately does not appear in `wstack auth`:
 * it answers typed questions rather than generating text, so putting it in the
 * provider list would leak `jev-latest` into the model picker, the subagent
 * lanes and the fallback chain, where selecting it would simply break a turn.
 * But "not a provider" is not "not an account" — it has a credential, a host
 * and a bill, and until this command existed the only way to configure any of
 * that was to hand-edit a config file. Nothing in any UI mentioned it.
 *
 *   wstack typesafe                  what is configured (no network request)
 *   wstack typesafe login            store a key (and pick a route)
 *   wstack typesafe test             spend one cheap question proving it works
 *
 * `test` is the point of the whole command. Both consumers degrade silently by
 * design, so a wrong or revoked key produces no error anywhere — it produces
 * slightly worse routing and no skill suggestions, forever. This is the only
 * place that asks the host directly and reports what it said.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Config } from '@wrongstack/contracts/types';
import {
  BUILT_IN_ROUTES,
  BUILT_IN_SEMANTIC_LINT_RULES,
  estimateTypeSafeCostUsd,
  findSemanticLintCandidates,
  isTypeSafeJudgmentEnabled,
  isTypeSafeRoute,
  judgeSemanticLintCandidates,
  parseSemanticLintRules,
  resolveTypeSafeAccount,
  resolveTypeSafeJudge,
  resolveTypeSafeRoute,
  TYPESAFE_JUDGMENT_FEATURES,
  TYPESAFE_ROUTES,
  type TypeSafeRoute,
} from '@wrongstack/core/typesafe';
import { buildChildEnv, color } from '@wrongstack/core/utils';
import { gitIsolationEnv } from '@wrongstack/primitives';
import { activeProfileConfigPath } from '../../profile-config-path.js';
import { maskedKey, mutateConfigProviders } from '../../provider-config-utils.js';
import type { SubcommandDeps, SubcommandHandler } from '../contracts.js';

type TypeSafeConfig = NonNullable<Config['typesafe']>;

const USAGE = [
  'Usage:',
  '  wstack typesafe [status]                 show account and feature configuration',
  '  wstack typesafe on|off                   enable/disable all Jev requests (keeps key)',
  '  wstack typesafe login [--route <id>]     store an API key in the active profile',
  '      [--endpoint <url>] [--model <id>]    configure a proxy or pin a model',
  '  wstack typesafe test                     send one question and report the answer',
  '  wstack typesafe lint-conventions         judge convention-rule hits in the diff',
  '      [--staged | --base <ref>] [--threshold <0..1>] [--json]',
  '      rules: built-in + .wrongstack/semantic-lint.json; exit 1 on findings',
  '  wstack typesafe check-judgments          run every judgment on known cases (live)',
  '  wstack typesafe replay-brain-ledger      compare Jev with past Brain decisions',
  '      [--ledger <path>] [--limit <per kind>] [--kind <signal>] [--json]',
  '  wstack typesafe replay-topic-shift       compare Jev with the provider on past session prompts',
  '      [--sessions <dir>] [--limit <n>] [--max-context <n>] [--no-llm] [--json]',
  '  wstack typesafe replay-memory-triage     compare Jev with the LLM on SAGE gray-zone memories',
  '      [--limit <n>] [--provider <id>] [--model <id>] [--llm-max-tokens <n>]',
  '      [--no-llm] [--json]',
  '',
  `Routes: ${BUILT_IN_ROUTES.map((r) => `${r} (${TYPESAFE_ROUTES[r].env})`).join(', ')}, custom (typesafe.endpoint)`,
  '',
  'TypeSafe is not a chat provider and is not listed by `wstack auth`.',
].join('\n');

export const typesafeCmd: SubcommandHandler = async (args, deps) => {
  const write = (line: string): void => deps.renderer.write(`${line}\n`);
  const flags = deps.flags ?? {};
  if (flags['help'] === true || flags['h'] === true) {
    write(USAGE);
    return 0;
  }

  const sub = (args[0] ?? 'status').toLowerCase();
  switch (sub) {
    case 'on':
    case 'off': {
      const configPath = activeProfileConfigPath(deps.paths, deps.config);
      await mutateConfigProviders(configPath, deps.vault, (_providers, config) => {
        config['typesafe'] = {
          ...(config['typesafe'] as TypeSafeConfig | undefined),
          enabled: sub === 'on',
        };
      });
      write(`Jev ${sub === 'on' ? 'enabled' : 'disabled'}. Saved in ${configPath}.`);
      return 0;
    }
    case 'status':
      return showStatus(deps, write);
    case 'login':
      return await login(deps, write);
    case 'test':
      return await test(deps, write);
    case 'lint-conventions':
      return await lintConventions(deps, write);
    case 'replay-topic-shift':
      return await (await import('./typesafe-topic-replay.js')).replayTopicShift(deps, write);
    case 'replay-memory-triage':
      return await (await import('./typesafe-triage-replay.js')).replayMemoryTriage(deps, write);
    case 'replay-brain-ledger':
      return await (await import('./typesafe-brain-replay.js')).replayBrainLedger(deps, write);
    case 'check-judgments':
      return await (await import('./typesafe-judgment-check.js')).checkJudgments(deps, write);
    default:
      write(`Unknown subcommand: ${sub}\n`);
      write(USAGE);
      return 1;
  }
};

/** Features that consume the account, and the switch that turns each one on. */
function requestedFeatures(deps: SubcommandDeps): string[] {
  const requested: string[] = [];
  if (deps.config.skills?.suggest?.enabled === true) requested.push('skills.suggest');
  if (deps.config.fleet?.dispatch?.typesafeClassifier === true) {
    requested.push('fleet.dispatch.typesafeClassifier');
  }
  return requested;
}

function showStatus(deps: SubcommandDeps, write: (line: string) => void): number {
  const account = resolveTypeSafeAccount({ config: deps.config });
  const route = resolveTypeSafeRoute(deps.config, process.env);
  const features = requestedFeatures(deps);

  write(color.bold('TypeSafe account'));
  write(`  route      ${route}${route === 'custom' ? color.dim(' (from typesafe.endpoint)') : ''}`);

  if (account.status === 'ready') {
    write(`  endpoint   ${account.endpoint}`);
    write(`  model      ${account.model}`);
    write(
      `  key        ${
        account.keySource === 'config'
          ? `${maskedKey(deps.config.typesafe?.apiKey ?? '')} ${color.dim('(typesafe.apiKey)')}`
          : color.dim(`from $${account.keyEnv}`)
      }`,
    );
    write('  connection not tested — run `wstack typesafe test` to verify');
  } else {
    write(`  key        ${color.dim('—')}`);
    write(`  ${color.amber('!')} ${account.reason}`);
  }

  write('');
  write(
    color.bold('Judgments') +
      color.dim(
        '  (requires typesafe.enabled: true; typesafe.judgments.<id>: false turns one off)',
      ),
  );
  for (const feature of TYPESAFE_JUDGMENT_FEATURES) {
    const on = isTypeSafeJudgmentEnabled(deps.config, feature);
    write(
      `  ${
        !on ? color.dim('off') : account.status === 'ready' ? color.green('on ') : color.dim('idle')
      }  ${feature}`,
    );
  }

  write('');
  write(color.bold('Features'));
  if (features.length === 0) {
    // Not a problem to fix: an account with nothing switched on is a perfectly
    // ordinary state, and this command is also how someone checks a key before
    // turning anything on.
    write(`  ${color.dim('none enabled')} — see docs/skills-suggestion.md`);
  } else {
    for (const feature of features) {
      write(
        account.status === 'ready'
          ? `  ${color.green('on')}  ${feature}`
          : `  ${color.amber('on, but not running')}  ${feature}`,
      );
    }
  }

  if (account.status !== 'ready' && account.status !== 'disabled' && features.length > 0) {
    write('');
    write(`  ${color.amber('Run `wstack typesafe login` — these switches do nothing today.')}`);
    return 1;
  }
  return 0;
}

async function login(deps: SubcommandDeps, write: (line: string) => void): Promise<number> {
  const flags = deps.flags ?? {};
  for (const name of ['route', 'endpoint', 'model', 'key']) {
    if (
      flags[name] !== undefined &&
      (typeof flags[name] !== 'string' || !String(flags[name]).trim())
    ) {
      write(`--${name} requires a value.`);
      return 1;
    }
  }
  const requested = flags['route'];
  let route: TypeSafeRoute | undefined;
  if (typeof requested === 'string') {
    if (!isTypeSafeRoute(requested)) {
      write(`Unknown route: ${requested}`);
      write(USAGE);
      return 1;
    }
    route = requested;
  }

  const endpoint = typeof flags['endpoint'] === 'string' ? flags['endpoint'].trim() : undefined;
  const model = typeof flags['model'] === 'string' ? flags['model'].trim() : undefined;
  if (endpoint && !route) route = 'custom';
  const update = (existing: TypeSafeConfig): TypeSafeConfig => {
    const next = { ...existing };
    if (route && route !== resolveTypeSafeRoute({ typesafe: existing }, {})) {
      // A route switch must not send its new credential to the previous host,
      // or keep a model id in the previous host's namespace.
      delete next.endpoint;
      delete next.model;
    }
    if (route) next.route = route;
    if (endpoint) next.endpoint = endpoint;
    if (model) next.model = model;
    return next;
  };
  const settings = update(deps.config.typesafe ?? {});
  const preview = resolveTypeSafeAccount({
    config: { typesafe: { ...settings, enabled: true } },
    env: {},
  });
  if (preview.status === 'unusable') {
    write(`${preview.reason}. For a custom route, pass --endpoint <url>.`);
    return 1;
  }
  const effectiveRoute = resolveTypeSafeRoute({ typesafe: settings }, {});
  const label =
    effectiveRoute !== 'custom' ? TYPESAFE_ROUTES[effectiveRoute].label : 'TypeSafe (custom)';
  const fromFlag = typeof flags['key'] === 'string' ? flags['key'].trim() : '';
  // `readSecret` keeps the key off the screen and out of shell history. The
  // `--key` flag exists for provisioning scripts and is the caller's choice to
  // put a secret on a command line, not ours.
  const key =
    fromFlag || (await deps.reader.readSecret(`  ${color.amber('?')} ${label} API key: `));
  if (!key.trim()) {
    write('No key entered; nothing written.');
    return 1;
  }

  // Written through the same vault-aware, locked, atomic config mutation the
  // provider keys use. The helper is named for providers because that was its
  // first caller, but its job is "mutate the profile config safely" and a
  // second implementation of that would be a second place to get encryption,
  // locking or corruption handling wrong. `typesafe.apiKey` is encrypted on
  // write by `encryptConfigSecrets` because the field name matches
  // `isSecretField` — this is exactly why the field must keep that name.
  const configPath = activeProfileConfigPath(deps.paths, deps.config);
  await mutateConfigProviders(configPath, deps.vault, (_providers, config) => {
    const existing =
      typeof config['typesafe'] === 'object' && config['typesafe'] !== null
        ? (config['typesafe'] as Record<string, unknown>)
        : {};
    config['typesafe'] = { ...update(existing as TypeSafeConfig), apiKey: key.trim() };
  });

  write(`${color.green('✓')} Key stored in ${configPath}`);
  write('  Storing a key does not enable Jev. Use `wstack typesafe on` when you want it.');
  if (route) write(`  route set to ${route}`);
  write(`  Verify it with ${color.bold('wstack typesafe test')}.`);
  return 0;
}

async function test(deps: SubcommandDeps, write: (line: string) => void): Promise<number> {
  // No rest gate: this probe exists to find out whether the host answers NOW,
  // so it must not be short-circuited by an earlier rest in this process.
  const account = resolveTypeSafeAccount({ config: deps.config, restGate: null });
  if (account.status !== 'ready') {
    write(`${color.red('✗')} ${account.reason}`);
    if (account.status !== 'disabled') write('  Run `wstack typesafe login`.');
    return 1;
  }

  write(`Asking ${account.endpoint} (${account.model})…`);
  const started = Date.now();
  try {
    // One Noul with an unambiguous answer. The point is not the judgment — it
    // is that the credential, the route, the model id and the response shape
    // all work end to end, which nothing else in the system ever proves.
    const result = await account.client.systemOne({
      state: { text: 'The service returned this request successfully.' },
      questions: {
        reachable: {
          type: 'noul',
          instructions: 'Is the text in the state written in English?',
        },
      },
    });
    const answer = result.answers['reachable'];
    const elapsed = Date.now() - started;
    if (answer?.type !== 'noul') {
      // A 200 whose body does not carry the answer we asked for is a real
      // failure — and the exact one the client is built to swallow, because a
      // live turn is better off with no suggestion than with a thrown shape.
      write(`${color.red('✗')} Reached the host but the answer was missing or malformed.`);
      return 1;
    }
    write(`${color.green('✓')} ${account.route} route works — answered in ${elapsed}ms`);
    write(`  model reported  ${result.model ?? color.dim('(none in response)')}`);
    write(
      `  cost            ${result.usage.inputTokens} input tokens ` +
        color.dim(`(~$${estimateTypeSafeCostUsd(result.usage.inputTokens).toFixed(6)})`),
    );
    if (
      result.model &&
      deps.config.typesafe?.model &&
      result.model !== deps.config.typesafe.model
    ) {
      // `jev-latest` is an alias. Saying which version answered is the only
      // way a calibrated threshold can be tied to what it was calibrated on.
      write(
        color.dim(`  note: asked for ${deps.config.typesafe.model}, answered by ${result.model}`),
      );
    }
    return 0;
  } catch (err) {
    const status = (err as { status?: number }).status;
    write(`${color.red('✗')} ${err instanceof Error ? err.message : String(err)}`);
    if (status === 401 || status === 403) {
      write('  The host rejected the key. Re-run `wstack typesafe login`.');
    } else if (status === 429 || status === 529) {
      write('  Rate limited or overloaded — the key is probably fine; try again shortly.');
    } else if (status === 422) {
      write('  The host rejected the request shape, not the key. This is a bug; please report it.');
    }
    return 1;
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  // The repository's config names programs `diff` runs on working-tree
  // files (fsmonitor, `.gitattributes` filters); when they cannot be switched
  // off, git does not run.
  const isolation = await gitIsolationEnv(cwd, { baseEnv: buildChildEnv() });
  if (!isolation)
    throw new Error('git isolation unavailable: the repository config could not be read');
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: { ...buildChildEnv(), ...isolation },
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/**
 * `lint-conventions`: regexes find candidate lines in the diff, System One
 * decides which are real violations. Unlike the in-session judgments this is
 * something the user ran on purpose, so an unavailable account is an error,
 * not a silent fallback.
 */
async function lintConventions(
  deps: SubcommandDeps,
  write: (line: string) => void,
): Promise<number> {
  const flags = deps.flags ?? {};
  // A flag given no value parses as `true`, and Number(true) is 1 — inside the
  // accepted range, so a bare `--threshold` ran the gate at 1.0 and cleared
  // every finding.
  if (typeof flags['threshold'] === 'boolean') {
    write(`${color.red('✗')} --threshold needs a number between 0 and 1.`);
    return 2;
  }
  const judge = resolveTypeSafeJudge({ config: deps.config, feature: 'semanticLint' });
  if (!judge) {
    const account = resolveTypeSafeAccount({ config: deps.config });
    write(
      `${color.red('✗')} ${
        account.status === 'ready'
          ? 'typesafe.judgments.semanticLint is false.'
          : `${account.reason}. Run \`wstack typesafe login\`.`
      }`,
    );
    return 2;
  }

  const rules = [...BUILT_IN_SEMANTIC_LINT_RULES];
  const rulesPath = path.join(deps.projectRoot, '.wrongstack', 'semantic-lint.json');
  try {
    const parsed = parseSemanticLintRules(JSON.parse(await readFile(rulesPath, 'utf8')));
    for (const error of parsed.errors) write(color.amber(`! ${rulesPath}: ${error}`));
    rules.push(...parsed.rules);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      write(color.amber(`! ${rulesPath}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  const base = typeof flags['base'] === 'string' ? flags['base'] : undefined;
  // Prefixes pinned: findSemanticLintCandidates strips only `b/`, so the user's
  // diff.mnemonicPrefix (`w/src/x.ts`) mis-named every file and an anchored
  // rule `files` pattern (`^src/`) never matched; no textconv for the same reason.
  const diffArgs = [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '-U24',
  ];
  if (flags['staged'] === true) diffArgs.push('--cached');
  else if (base) diffArgs.push(`${base}...HEAD`);
  let diff: string;
  try {
    diff = await runGit(deps.projectRoot, diffArgs);
  } catch (err) {
    write(`${color.red('✗')} git diff failed: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const candidates = findSemanticLintCandidates(diff, rules);
  const thresholdFlag = Number(flags['threshold']);
  const threshold =
    Number.isFinite(thresholdFlag) && thresholdFlag > 0 && thresholdFlag <= 1 ? thresholdFlag : 0.7;
  const result =
    candidates.length === 0
      ? { findings: [], cleared: 0, unjudged: 0 }
      : await judgeSemanticLintCandidates(judge, rules, candidates, { threshold });

  if (flags['json'] === true) {
    write(JSON.stringify({ candidates: candidates.length, ...result }, null, 2));
  } else {
    for (const f of result.findings) {
      write(
        `${color.amber(`${f.file}:${f.line}`)}  ${color.bold(f.ruleId)}  ` +
          color.dim(`p=${f.probability.toFixed(2)}`),
      );
      write(`    ${f.text.slice(0, 160)}`);
    }
    write(
      color.dim(
        `${candidates.length} candidate(s) across ${rules.length} rule(s): ` +
          `${result.findings.length} finding(s), ${result.cleared} cleared` +
          (result.unjudged ? `, ${result.unjudged} not judged (host unavailable)` : ''),
      ),
    );
  }
  if (result.findings.length > 0) return 1;
  return result.unjudged > 0 ? 2 : 0;
}
