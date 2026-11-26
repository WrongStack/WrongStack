import { gitSubcommand, kubectlDeleteResource, longOptionAbbrev } from './_danger-rule-utils.js';
import type { DangerRule } from './_danger-types.js';

export const VCS_INFRA_DANGER_RULES: readonly DangerRule[] = [
  // ----- VCS history rewrite (destructive) -----
  // `git push --force` / `-f` rewrites remote history. `--force-with-lease`
  // is the safer variant (checks remote hasn't moved) but still rewrites.
  // A refspec prefixed with `+` (`git push origin +main`,
  // `+HEAD:refs/heads/main`) is per-refspec force — documented git shorthand
  // equivalent to `--force` for that ref — so it classifies identically. A
  // `+` anywhere else in a refspec (branch `feature+fix`) is just a
  // character, and a leading `^` EXCLUDES the ref (with --all/--mirror);
  // neither is force syntax. `--dry-run` / `-n` rewrites nothing and is
  // exempt, like the PowerShell -WhatIf carve-out above (combined short
  // clusters like `-nf` count as dry-run too — git push's short flags are
  // only -q -v -f -n -u -o, so an 'n' in a cluster means dry-run).
  {
    id: 'git-push-delete',
    level: 'destructive',
    // `--mirror` force-updates every remote ref and deletes the ones missing
    // locally (git-push(1)); `--delete` / `-d`, `--prune` and a `:ref`
    // deletion refspec remove remote branches. None carries a force flag, so
    // the force rule below never saw them.
    test: (cmd, args) => {
      if (cmd !== 'git') return false;
      const pushIdx = args.indexOf('push');
      if (pushIdx < 0) return false;
      const pushArgs = args.slice(pushIdx + 1);
      if (pushArgs.some((a) => a === '--dry-run' || a === '-n' || /^-[a-z]*n[a-z]*$/i.test(a))) {
        return false;
      }
      return pushArgs.some(
        (a) =>
          // F11: unambiguous prefixes — mirror: --m…; delete: --de… ("d" is
          // ambiguous with --dry-run); prune: --pru… ("p"/"pr" collide with
          // --porcelain/--progress/--push-option).
          longOptionAbbrev(a, 'mirror', 1) ||
          longOptionAbbrev(a, 'delete', 2) ||
          longOptionAbbrev(a, 'prune', 3) ||
          /^-[a-z]*d[a-z]*$/i.test(a) ||
          (a.startsWith(':') && a.length > 1),
      );
    },
    reason: 'git push --mirror / --delete / :ref (overwrites or deletes remote branches)',
  },

  {
    id: 'git-push-force',
    level: 'destructive',
    test: (cmd, args) => {
      if (cmd !== 'git') return false;
      const pushIdx = args.indexOf('push');
      if (pushIdx < 0) return false;
      if (
        args
          .slice(pushIdx + 1)
          .some((a) => a === '--dry-run' || a === '-n' || /^-[a-z]*n[a-z]*$/i.test(a))
      ) {
        return false;
      }
      for (let i = pushIdx + 1; i < args.length; i++) {
        const a = args[i]!;
        if (a === '--force' || a === '-f' || a === '--force-with-lease') return true;
        if (!a.startsWith('-') && !a.includes('=')) {
          if (a.startsWith('+')) return true;
          continue;
        }
        if (a.startsWith('--force') /* covers --force-with-lease already */) return true;
        // Combined short-flag cluster: git combines short flags, so
        // `-fv` ≡ `-f -v` and is a verbatim force-push that rewrites history.
        // Only single-dash all-letter clusters qualify; the dry-run exemption
        // above already returned early on any `n`, so an `f` reaching here is
        // a genuine (non-dry-run) force. This is the flag-cluster shape-variance
        // gap already fixed for rm-recursive / powershell rules but missed here.
        if (/^-[a-z]+$/i.test(a) && a.toLowerCase().includes('f')) return true;
      }
      return false;
    },
    reason: 'git push with --force / -f (rewrites remote history)',
  },

  // ----- git reset --hard (destructive) -----
  {
    id: 'git-reset-hard',
    level: 'destructive',
    // F11: reset's only h-option is --hard (--h… unambiguous; the =value
    // over-match is kept, fail-safe).
    test: (cmd, args) => cmd === 'git' && args.some((a) => longOptionAbbrev(a, 'hard', 1)),
    reason: 'git reset --hard (discards working tree + index)',
  },

  // ----- git clean -f / -fd (destructive) -----
  {
    id: 'git-clean-force',
    level: 'destructive',
    test: (cmd, args) => {
      if (cmd !== 'git') return false;
      const cleanIdx = args.indexOf('clean');
      if (cleanIdx < 0) return false;
      // Must include -f / --force (without it, git clean errors out and does
      // nothing). Short flags combine, so the force flag is any single-dash
      // all-letter cluster containing `f` — `-fd`, `-df`, `-xdf` — not just
      // ones where `f` happens to be first.
      const after = args.slice(cleanIdx + 1);
      // A dry run rewrites nothing; exempt it before the force check, the same
      // shape the git-push-force rule uses (`-n`, `-nd`, `--dry-run`).
      if (after.some((a) => a === '--dry-run' || /^-[a-z]*n[a-z]*$/i.test(a))) return false;
      return after.some(
        (a) =>
          // F11: clean's only f-option is --force (--f… unambiguous; the
          // helper also covers the =value spelling).
          longOptionAbbrev(a, 'force', 1) ||
          (/^-[a-z]+$/i.test(a) && a.toLowerCase().includes('f')),
      );
    },
    reason: 'git clean -f (deletes untracked files)',
  },

  // ----- git history rewriters (destructive) -----
  // `filter-branch` and `filter-repo` rewrite every commit in place — the one
  // pair of commands that can destroy a repository's whole history — and the
  // YOLO gate's `git-history` kind lists them beside `reset --hard`,
  // `clean -f` and `push --force`, which this module already classifies. Keyed
  // on the real subcommand so a branch or path named `filter-branch` (or a
  // commit message mentioning it) does not fire.
  {
    id: 'git-history-rewrite',
    level: 'destructive',
    test: (cmd, args) => {
      if (cmd !== 'git') return false;
      const { sub } = gitSubcommand(args);
      return sub === 'filter-branch' || sub === 'filter-repo';
    },
    reason: 'git filter-branch / filter-repo (rewrites every commit in the history)',
  },

  // ----- git: other irreversible discards of local work (destructive) -----
  // The same set the YOLO gate treats like `reset --hard` / `clean -f`, keyed
  // on the real subcommand (git's global options skipped): worktree discard
  // (`checkout -- <paths>` / `checkout .` / `checkout -f`, `switch -f|
  // --discard-changes`, `restore <paths>` unless it only unstages), `stash
  // drop|clear`, and recovery-data destruction (`reflog expire|delete`,
  // `gc --prune=now|all`, `prune`) after which not even the reflog can bring
  // discarded commits back. F12: force branch-ref manipulation (`switch
  // -C/--force-create`, `checkout -B`, `branch -f/-D/-M/-C` and verb+force
  // combos) is included — it discards a branch's unique commits (core F10
  // parity). F14: `worktree remove --force` (dirty checkout deleted,
  // uncommitted work lost — core F13 parity). Branch switches, `restore --staged`, `stash`
  // push/pop/list and plain `gc` stay safe.
  {
    id: 'git-discard-local-work',
    level: 'destructive',
    test: (cmd, args) => {
      if (cmd !== 'git') return false;
      let i = 0;
      while (i < args.length && args[i]!.startsWith('-')) {
        const a = args[i]!;
        i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(a)
          ? 2
          : 1;
      }
      const sub = args[i];
      const rest = args.slice(i + 1);
      // F11: checkout's only f-option is --force (--f… unambiguous, minLen 1);
      // switch also has --force-create, so every --force abbreviation is
      // ambiguous there and git rejects it — switch passes the full length.
      const forceFlag = (a: string, minLen: number) =>
        longOptionAbbrev(a, 'force', minLen) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a);
      const pathspec = (a: string) => !a.startsWith('-') || a.startsWith('--pathspec-from-file');
      switch (sub) {
        case 'checkout': {
          const dashDash = rest.indexOf('--');
          if (dashDash >= 0 && rest.slice(dashDash + 1).some(pathspec)) return true;
          // F12: -B[branch] (also clustered/attached) force-resets the branch;
          // no long form exists. Args are case-sensitive, so -b (safe create)
          // never matches.
          if (rest.some((a) => /^-[a-zA-Z]*B/.test(a))) return true;
          return rest.some((a) => forceFlag(a, 1)) || rest.includes('.') || rest.includes(':/');
        }
        case 'switch':
          // F11: --di…--discard-changes are unambiguous ("d" collides with
          // --detach).
          // F12: -C[branch] (also clustered/attached) or --force-c…
          // --force-create force-resets the branch (probe-verified); -c (safe
          // create) never matches the case-sensitive regex.
          return (
            rest.some((a) => /^-[a-zA-Z]*C/.test(a)) ||
            rest.some((a) => longOptionAbbrev(a, 'force-create', 7)) ||
            rest.some((a) => longOptionAbbrev(a, 'discard-changes', 2)) ||
            rest.some((a) => forceFlag(a, 'force'.length))
          );
        case 'branch': {
          // F12 (core F10 parity): force branch-ref manipulation discards a
          // branch's unique commits (reflog-only recovery); move/copy also
          // OVERWRITES an existing target. -D/-M/-C force delete/move/copy,
          // also clustered (-fd) or attached (-Mfeat).
          if (rest.some((a) => /^-[a-zA-Z]*[DMC]/.test(a))) return true;
          // --force minLen 4: "for"/"f" collide with --forked/--format.
          const force =
            rest.some((a) => longOptionAbbrev(a, 'force', 4)) ||
            rest.some((a) => /^-[a-zA-Z]*f/.test(a));
          if (!force) return false;
          // Verb + force: --delete EXACT only ("del" is ambiguous with
          // --delete-merged), --mo…--move, --cop…--copy, or a short d/m/c in a
          // cluster combined with f (-fd ≡ -D).
          const verb =
            rest.includes('--delete') ||
            rest.some((a) => longOptionAbbrev(a, 'move', 2)) ||
            rest.some((a) => longOptionAbbrev(a, 'copy', 3)) ||
            rest.some((a) => /^-[a-zA-Z]*[dmc]/.test(a));
          if (verb) return true;
          // -f <name> [start] forces the branch ref to a new start point. List
          // and filter modes ignore -f (probe: `branch -f --list` is harmless).
          const listMode = rest.some(
            (a) =>
              a === '-a' ||
              a === '-r' ||
              /^(?:--list|--show-current|--all|--remotes|--contains|--no-contains|--merged|--no-merged|--points-at|--sort|--format|--column|--color|--abbrev)/.test(
                a,
              ),
          );
          return !listMode && rest.some((a) => !a.startsWith('-'));
        }
        case 'restore': {
          // F11: --sta…--staged / --w…--worktree are unambiguous prefixes
          // ("s"/"st" collide with --source). Missing --wor let the unstage-only
          // exemption hide a worktree-destroying restore (core F8 parity).
          const staged =
            rest.some((a) => longOptionAbbrev(a, 'staged', 3)) ||
            rest.some((a) => /^-[a-zA-Z]*S[a-zA-Z]*$/.test(a));
          const worktree =
            rest.some((a) => longOptionAbbrev(a, 'worktree', 1)) ||
            rest.some((a) => /^-[a-zA-Z]*W[a-zA-Z]*$/.test(a));
          if (staged && !worktree) return false;
          return rest.some(pathspec);
        }
        case 'stash': {
          const verb = rest.find((a) => !a.startsWith('-'));
          return verb === 'drop' || verb === 'clear';
        }
        case 'worktree': {
          // F14 (core F13 parity): `worktree remove --force` deletes the
          // worktree checkout even when dirty — uncommitted work is lost with
          // no reflog for it (probe-verified). Without --force git refuses a
          // dirty worktree and a clean removal loses nothing; the other verbs
          // (add/list/lock/unlock/move/prune/repair) discard no work. remove's
          // only f-option is --force, so --f… is unambiguous (minLen 1).
          const verb = rest.find((a) => !a.startsWith('-'));
          if (verb !== 'remove') return false;
          return rest.some((a) => forceFlag(a, 1));
        }
        case 'reflog':
          return rest.includes('expire') || rest.includes('delete');
        case 'gc':
          // F11: gc's only p-option is --prune (--p… unambiguous).
          return rest.some((a) => {
            if (!longOptionAbbrev(a, 'prune', 1) || !a.includes('=')) return false;
            const value = a.slice(a.indexOf('=') + 1);
            return value === 'now' || value === 'all';
          });
        case 'prune':
          return true;
        default:
          return false;
      }
    },
    reason:
      'git checkout/switch/branch/restore/stash/worktree/reflog/gc discarding local work (not recoverable)',
  },

  // ----- package publish (destructive — public, irreversible) -----
  {
    id: 'npm-publish',
    level: 'destructive',
    test: (cmd, args) => {
      if (!['npm', 'pnpm', 'yarn', 'bun', 'cargo'].includes(cmd)) return false;
      // For npm/pnpm/yarn/bun: subcommand is "publish".
      // For cargo: subcommand is "publish" OR "yank" (both touch the
      // public registry; yank is reversible, publish is not, but yank
      // is rare enough we treat it the same).
      // The subcommand may sit after global options, and a bare option may
      // take the next argv entry as its VALUE (`npm --access public publish`,
      // `pnpm --filter app publish`, `yarn --cwd dir publish`). A hand-kept
      // table of npm value flags missed pnpm/yarn/bun ones, so those
      // publishes were classified safe. Consider every positional up to and
      // including the first that does NOT directly follow a bare option —
      // that one is certainly the subcommand (same rule as exec's gate).
      const candidates: string[] = [];
      let previousWasBareOption = false;
      for (const a of args) {
        if (a === '--') break;
        if (a.startsWith('-')) {
          previousWasBareOption = !a.includes('=');
          continue;
        }
        candidates.push(a);
        if (!previousWasBareOption) break;
        previousWasBareOption = false;
      }
      const verbs = cmd === 'cargo' ? ['publish', 'yank'] : ['publish'];
      if (candidates.some((c) => verbs.includes(c))) return true;
      // Yarn 2+ publishes with `yarn npm publish` (also behind
      // `workspaces foreach`), so the subcommand scan above stops at `npm`.
      if (cmd === 'yarn') {
        const positionals = args.filter((a) => !a.startsWith('-'));
        return positionals.some((a, i) => a === 'npm' && positionals[i + 1] === 'publish');
      }
      return false;
    },
    reason: 'publishing to a public package registry (hard to reverse)',
  },

  // ----- other ecosystems' public registry publishes (destructive) -----
  {
    id: 'registry-publish',
    level: 'destructive',
    // The one-command publishes of the Python / Ruby / .NET / JVM / Dart
    // tooling the exec allowlist ships. Only the npm family and cargo were
    // recognised, so `twine upload` or `poetry publish` drew no banner.
    test: (cmd, args) => {
      const name = cmd
        .toLowerCase()
        .replace(/^.*[\\/]/, '')
        .replace(/\.(?:bat|cmd|exe)$/, '');
      const pos = args.filter((a) => !a.startsWith('-')).map((a) => a.toLowerCase());
      switch (name) {
        case 'twine':
          return pos[0] === 'upload';
        case 'poetry':
        case 'uv':
        case 'pdm':
        case 'hatch':
        case 'flit':
          return pos[0] === 'publish';
        case 'gem':
        case 'nuget':
          return pos[0] === 'push';
        case 'dotnet':
          return pos[0] === 'nuget' && pos[1] === 'push';
        case 'mvn':
          return pos.includes('deploy');
        case 'gradle':
        case 'gradlew':
          return pos.some((a) => a.startsWith('publish') && a !== 'publishtomavenlocal');
        case 'dart':
        case 'flutter':
          return pos[0] === 'pub' && pos[1] === 'publish';
        default:
          return false;
      }
    },
    reason: 'publishing to a public package registry (hard to reverse)',
  },

  // ----- k8s cluster-wide destructive ops (destructive) -----
  {
    id: 'kubectl-delete-namespace',
    level: 'destructive',
    test: (cmd, args) => {
      if (cmd !== 'kubectl') return false;
      const delIdx = args.indexOf('delete');
      if (delIdx < 0) return false;
      // Match `kubectl delete namespace <name>` or `kubectl delete ns <name>`.
      // Generic `kubectl delete pod foo` is left out — too common.
      //
      // The resource is the first POSITIONAL after `delete`, not literally the
      // next token: kubectl accepts its flags anywhere, so
      // `kubectl delete -n x namespace y` put `-n` in that slot and the rule
      // declined the same cluster-wide delete it flags in canonical order. It
      // also accepts the plural resource name (`namespaces`), which is the
      // spelling `kubectl api-resources` prints (probe-verified 2026-09-22).
      // A flag's VALUE is not a positional: without skipping it, `-n x` put `x`
      // in the resource slot. Only the value-taking flags are skipped, so a
      // boolean flag (`--force`) does not swallow the resource that follows it.
      const resource = kubectlDeleteResource(args.slice(delIdx + 1));
      // The TYPE/NAME form (`ns/prod`) names the same resource, and a
      // comma-separated TYPE list (`pods,ns prod`) deletes every listed type.
      return (resource ?? '').split(',').some((type) => /^(?:namespaces?|ns)(?:\/|$)/i.test(type));
    },
    reason: 'kubectl delete namespace (deletes all resources in the namespace)',
  },

  {
    id: 'kubectl-drain',
    level: 'destructive',
    test: (cmd, args) => cmd === 'kubectl' && args.includes('drain'),
    reason: 'kubectl drain (evicts pods, marks node unschedulable)',
  },

  // ----- remote infrastructure / storage teardown (destructive) -----
  // As irreversible as a namespace delete and the same set the YOLO gate
  // treats as hard to retract: terraform/tofu destroy (the subcommand is the
  // first non-flag, so `-chdir=` works and `plan -destroy` stays a plan),
  // pulumi destroy, cluster-wide or persistent-volume kubectl deletes, and
  // recursive cloud-storage deletes. Single-object deletes stay safe.
  {
    id: 'infra-teardown',
    level: 'destructive',
    test: (cmd, args) => {
      if (cmd === 'kubectl') {
        const delIdx = args.indexOf('delete');
        if (delIdx < 0) return false;
        if (args.some((a) => a === '--all' || a === '-A' || a === '--all-namespaces')) return true;
        const resource = kubectlDeleteResource(args.slice(delIdx + 1)) ?? '';
        // A comma-separated TYPE list deletes every listed type.
        return resource
          .split(',')
          .some((type) =>
            /^(?:pvc|pv|persistentvolumeclaims?|persistentvolumes?)(?:\/|$)/i.test(type),
          );
      }
      if (cmd === 'terraform' || cmd === 'tofu') {
        const sub = args.find((a) => !a.startsWith('-'));
        return sub === 'destroy' || (sub === 'apply' && args.includes('-destroy'));
      }
      if (cmd === 'pulumi') return args.includes('destroy');
      if (cmd === 'aws' && args.includes('s3')) {
        // F11: AWS CLI accepts unambiguous prefixes (verified aws-cli/2.39.7):
        // rm --rec… ("re" → global --region), rb --f…, sync --del… ("de"/"d"
        // → --debug, NOT --delete).
        return (
          (args.includes('rm') && args.some((a) => longOptionAbbrev(a, 'recursive', 3))) ||
          (args.includes('rb') && args.some((a) => longOptionAbbrev(a, 'force', 1))) ||
          (args.includes('sync') && args.some((a) => longOptionAbbrev(a, 'delete', 3)))
        );
      }
      const recursive = args.some((a) => a === '-r' || a === '-R' || a === '--recursive');
      if (cmd === 'gsutil') return args.includes('rm') && recursive;
      if (cmd === 'gcloud') return args.includes('storage') && args.includes('rm') && recursive;
      if (cmd === 'rclone') return args.includes('purge');
      return false;
    },
    reason: 'remote infrastructure / storage teardown (terraform destroy, recursive bucket delete)',
  },

  // ----- container volume deletion (destructive) -----
  // Volumes hold the persistent data of local databases and services:
  // `volume rm|remove|prune`, `system prune --volumes`, `compose down -v`.
  // Keyed on the leading subcommand positionals (docker/compose global options
  // and their values skipped), so `docker run --rm … rm x`, plain
  // `compose down` and `system prune` stay safe.
  {
    id: 'container-volume-destroy',
    level: 'destructive',
    test: (cmd, args) => {
      const m = /^(?:docker|podman|nerdctl)(-compose)?(?:\.exe)?$/i.exec(cmd);
      if (!m) return false;
      const valueFlags = new Set([
        '-H',
        '--host',
        '-c',
        '--context',
        '--config',
        '-l',
        '--log-level',
        '--tlscacert',
        '--tlscert',
        '--tlskey',
        '-f',
        '--file',
        '-p',
        '--project-name',
        '--profile',
        '--env-file',
        '--project-directory',
        '--ansi',
        '--progress',
        '--parallel',
      ]);
      const words: string[] = m[1] ? ['compose'] : [];
      for (let i = 0; i < args.length && words.length < 2; i += 1) {
        const a = args[i]!;
        if (a.startsWith('-')) {
          if (valueFlags.has(a)) i += 1;
          continue;
        }
        words.push(a);
      }
      const [group, action] = words;
      if (group === 'volume') return action === 'rm' || action === 'remove' || action === 'prune';
      if (group === 'system') return action === 'prune' && args.includes('--volumes');
      return (
        group === 'compose' &&
        action === 'down' &&
        args.some((a) => a === '--volumes' || /^-[a-zA-Z]*v[a-zA-Z]*$/.test(a))
      );
    },
    reason: 'container volume deletion (volume rm/prune, compose down -v — persistent data)',
  },

  // ----- database drop / wipe (destructive) -----
  // Client CLIs (dropdb, mysqladmin drop, redis FLUSHALL/FLUSHDB, mongosh
  // dropDatabase(), SQL DROP DATABASE|SCHEMA|TABLE / TRUNCATE passed to a SQL
  // client) and framework wipes (prisma migrate reset / db push --force-reset,
  // rails|rake db:drop|reset|purge, artisan migrate:fresh|reset|refresh /
  // db:wipe, manage.py flush). Up to two runner prefixes are peeled (`npx`,
  // `bundle exec`, `php`, `python`, `uv run`…) because that is how exec
  // receives the framework commands.
  {
    id: 'database-destroy',
    level: 'destructive',
    test: (cmd, args) => {
      const base = (s: string) =>
        s
          .toLowerCase()
          .replace(/^.*[\\/]/, '')
          .replace(/\.(?:exe|cmd|bat)$/, '');
      const runners = new Set([
        'npx',
        'pnpx',
        'bunx',
        'pnpm',
        'yarn',
        'bun',
        'bundle',
        'php',
        'python',
        'python3',
        'py',
        'uv',
        'poetry',
        'pipenv',
      ]);
      let tool = base(cmd);
      let rest = args.map((a) => a.toLowerCase());
      for (let hop = 0; hop < 2 && runners.has(tool); hop += 1) {
        const idx = rest.findIndex(
          (a) => !a.startsWith('-') && !['exec', 'run', 'dlx', 'x'].includes(a),
        );
        if (idx < 0) return false;
        tool = base(rest[idx]!);
        rest = rest.slice(idx + 1);
      }
      if (tool === 'dropdb') return true;
      if (tool === 'mysqladmin') return rest.includes('drop');
      if (['redis-cli', 'valkey-cli', 'keydb-cli'].includes(tool)) {
        return rest.some((a) => a === 'flushall' || a === 'flushdb');
      }
      if (tool === 'mongosh' || tool === 'mongo') {
        return rest.some((a) => a.includes('dropdatabase('));
      }
      if (
        [
          'psql',
          'mysql',
          'mariadb',
          'sqlite3',
          'sqlcmd',
          'clickhouse-client',
          'cockroach',
          'duckdb',
        ].includes(tool)
      ) {
        return /\b(?:drop\s+(?:database|schema|table)|truncate)\b/.test(rest.join(' '));
      }
      if (tool === 'prisma') {
        return (
          (rest.includes('migrate') && rest.includes('reset')) ||
          (rest.includes('push') && rest.includes('--force-reset'))
        );
      }
      if (tool === 'rails' || tool === 'rake') {
        return rest.some((a) => /^db:(?:drop|reset|purge|migrate:reset)(?::all)?$/.test(a));
      }
      if (tool === 'artisan') {
        return rest.some((a) => /^(?:migrate:(?:fresh|reset|refresh)|db:wipe)$/.test(a));
      }
      if (tool === 'manage.py') return rest.some((a) => a === 'flush' || a === 'reset_db');
      return false;
    },
    reason: 'database drop / wipe (dropdb, DROP DATABASE, FLUSHALL, migrate reset)',
  },
];
