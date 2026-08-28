import { readdir } from 'node:fs/promises';
import { leaderTierPolicy, resolveTier } from '@wrongstack/core/coordination';
import type { ProviderModelStatusTracker } from '@wrongstack/core/coordination';
import type { ConfigStore, MemoryPort } from '@wrongstack/core/types';
import type { WstackPaths } from '@wrongstack/core/utils';
import { readJsonObjectFile } from '@wrongstack/core/utils';
import type { ResourceMenuId, ResourceMenuItem, ResourceMenuSnapshot } from '@wrongstack/tui';
import { runGit } from './services/run-git.js';

interface TuiResourceMenuContext {
  configStore: ConfigStore;
  paths: WstackPaths;
  memoryStore?: MemoryPort | undefined;
  statusTracker?: ProviderModelStatusTracker | undefined;
  projectRoot: string;
}

export function createTuiResourceMenuGetter(
  ctx: TuiResourceMenuContext,
): (id: ResourceMenuId) => Promise<ResourceMenuSnapshot> {
  return async (id) => {
    switch (id) {
      case 'fallback':
        return fallbackMenu(ctx.configStore);
      case 'tier':
        return tierMenu(ctx.configStore);
      case 'profile':
        return profileMenu(ctx.configStore, ctx.paths);
      case 'provider-status':
        return providerStatusMenu(ctx.statusTracker);
      case 'memory':
        return memoryMenu(ctx.memoryStore);
      case 'worktree':
        return worktreeMenu(ctx.projectRoot);
      case 'git':
        return gitMenu(ctx.projectRoot);
    }
  };
}

function fallbackMenu(store: ConfigStore): ResourceMenuSnapshot {
  const config = store.get();
  const chain = config.fallbackModels ?? [];
  const profiles = config.fallbackProfiles ?? {};
  const favorites = config.favoriteModels ?? [];
  const auto = config.fallbackAuto !== false;
  const items: ResourceMenuItem[] = [
    {
      id: 'leader',
      label: 'Leader',
      status: 'good',
      summary: `${config.provider}/${config.model}`,
      details: [
        { label: 'provider', value: config.provider },
        { label: 'model', value: config.model },
        { label: 'bridge', value: config.fallbackBridge || 'disabled' },
      ],
      body: 'The active session model. The bridge, when configured, is tried before the ordered fallback chain.',
    },
    {
      id: 'auto',
      label: 'Smart fallback',
      status: auto ? 'good' : 'muted',
      summary: auto ? 'enabled' : 'disabled',
      details: [
        { label: 'mode', value: auto ? 'auto-derived when chain is empty' : 'explicit chain only' },
        { label: 'favorites only', value: config.favoriteModelsOnly ? 'yes' : 'no' },
        { label: 'favorites', value: String(favorites.length) },
      ],
      actions: [
        {
          key: 't',
          label: auto ? 'turn off' : 'turn on',
          command: `/fallback auto ${auto ? 'off' : 'on'}`,
        },
      ],
    },
    ...chain.map((ref, index) => ({
      id: `chain:${index}`,
      label: `${index + 1}. ${ref}`,
      status: 'warn' as const,
      summary: 'explicit fallback',
      details: [
        { label: 'position', value: String(index + 1) },
        { label: 'model ref', value: ref },
        { label: 'after', value: index === 0 ? 'leader/bridge' : (chain[index - 1] ?? 'leader') },
      ],
      actions: [
        { key: 'x', label: 'remove', command: `/fallback remove ${index + 1}`, confirm: true },
      ],
    })),
    ...Object.entries(profiles)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, refs]) => ({
        id: `profile:${name}`,
        label: `Profile: ${name}`,
        status: refs.length > 0 ? ('good' as const) : ('muted' as const),
        summary: `${refs.length} model${refs.length === 1 ? '' : 's'}`,
        details: [
          { label: 'name', value: name },
          { label: 'length', value: String(refs.length) },
        ],
        body: refs.join(' → ') || '(empty profile)',
        actions: [
          { key: 'u', label: 'use', command: `/fallback profile use ${name}`, confirm: true },
          { key: 'x', label: 'delete', command: `/fallback profile remove ${name}`, confirm: true },
        ],
      })),
    ...favorites.map((ref, index) => ({
      id: `favorite:${index}`,
      label: `★ ${ref}`,
      status: 'good' as const,
      summary: 'favorite model',
      details: [{ label: 'model ref', value: ref }],
      actions: [
        {
          key: 'x',
          label: 'unfavorite',
          command: `/fallback fav remove ${index + 1}`,
          confirm: true,
        },
      ],
    })),
  ];
  return {
    id: 'fallback',
    title: 'Fallback routing',
    subtitle: `${chain.length} explicit · ${Object.keys(profiles).length} profiles · ${favorites.length} favorites`,
    items,
  };
}

/**
 * Cost-tier browser. Deliberately a sibling of {@link fallbackMenu}: a profile
 * says WHICH models, a tier says HOW EXPENSIVE the job may be. Every action here
 * dispatches a `/tier ...` command, so the menu, the slash command and the WebUI
 * editor all write the same `modelTiers` config.
 */
function tierMenu(store: ConfigStore): ResourceMenuSnapshot {
  const config = store.get();
  const tiers = config.modelTiers;
  const enabled = tiers?.enabled === true;
  const levels = tiers?.levels ?? {};
  const routing = tiers?.routing ?? {};
  const policy = leaderTierPolicy(config);
  const levelIds = Object.keys(levels);

  const items: ResourceMenuItem[] = [
    {
      id: 'enabled',
      label: 'Model tiers',
      status: enabled ? 'good' : 'muted',
      summary: enabled ? 'enabled' : 'disabled',
      details: [
        { label: 'levels', value: String(levelIds.length) },
        { label: 'routing rules', value: String(Object.keys(routing).length) },
        { label: 'default', value: tiers?.default ?? 'standard' },
      ],
      body:
        'A tier binds a fallback profile, a spend budget and a runtime setting under one ' +
        'name, then routes work to it by role or phase. While disabled, spawns resolve ' +
        'exactly as they did before tiers existed.',
      actions: [
        { key: 't', label: enabled ? 'turn off' : 'turn on', command: `/tier ${enabled ? 'off' : 'on'}` },
      ],
    },
    {
      id: 'leader',
      label: 'Leader self-switching',
      status: policy.mode === 'auto' ? 'warn' : policy.mode === 'propose' ? 'good' : 'muted',
      summary: policy.mode,
      details: [
        { label: 'mode', value: policy.mode },
        { label: 'dwell', value: `${policy.dwellTurns} turn(s)` },
        { label: 'min saving', value: `$${policy.minSavingsUsd}` },
        { label: 'context cap', value: `${Math.round(policy.maxContextFillForSwitch * 100)}%` },
        { label: 'ceiling', value: policy.maxTier ?? 'none' },
      ],
      body:
        'propose (default): the leader asks before changing its own model. auto: it applies ' +
        'the switch itself, still bounded by dwell, context window, ceiling and a break-even ' +
        'test against the prompt-cache re-warm the switch costs. off: it never self-switches.',
      actions: [
        { key: 'p', label: 'propose', command: '/tier leader propose' },
        { key: 'a', label: 'auto', command: '/tier leader auto', confirm: true },
        { key: 'o', label: 'off', command: '/tier leader off' },
      ],
    },
    ...levelIds.map((id, index) => {
      const level = levels[id];
      const resolved = enabled ? resolveTier(config, { tier: id }) : undefined;
      const routedBy = Object.entries(routing)
        .filter(([, value]) => value === id)
        .map(([key]) => key);
      return {
        id: `level:${id}`,
        label: `${index + 1}. ${id}`,
        status: level?.fallbackProfile ? ('good' as const) : ('muted' as const),
        summary: resolved?.model
          ? `${resolved.provider ?? config.provider}/${resolved.model}`
          : (level?.fallbackProfile ?? '(no profile)'),
        details: [
          { label: 'rung', value: `${index + 1} of ${levelIds.length}` },
          { label: 'profile', value: level?.fallbackProfile ?? '(none)' },
          { label: 'max cost', value: level?.maxCostUsd !== undefined ? `$${level.maxCostUsd}` : '(role default)' },
          { label: 'max iterations', value: level?.maxIterations !== undefined ? String(level.maxIterations) : '(role default)' },
          { label: 'routed by', value: routedBy.join(', ') || '(nothing)' },
        ],
        body: [
          resolved?.fallbackModels?.length
            ? `Failover: ${resolved.fallbackModels.join(' → ')}`
            : 'No failover chain — the profile has a single entry.',
          'Declaration order is the ladder: rung 1 is the cheapest.',
        ].join('\n'),
        actions: [
          { key: 'x', label: 'delete', command: `/tier remove ${id}`, confirm: true },
          { key: 'd', label: 'make default', command: `/tier default ${id}` },
        ],
      };
    }),
    ...Object.entries(routing)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, tier]) => ({
        id: `route:${key}`,
        label: `${key} → ${tier}`,
        status: levels[tier] ? ('good' as const) : ('warn' as const),
        summary: levels[tier] ? 'routing rule' : 'points at a missing level',
        details: [
          { label: 'key', value: key },
          { label: 'tier', value: tier },
          { label: 'kind', value: key === '*' ? 'default' : 'role or phase' },
        ],
        actions: [{ key: 'x', label: 'remove', command: `/tier unroute ${key}`, confirm: true }],
      })),
  ];

  return {
    id: 'tier',
    title: 'Model cost tiers',
    subtitle: enabled
      ? `${levelIds.length} level(s) · ${Object.keys(routing).length} rule(s) · leader: ${policy.mode}`
      : 'disabled',
    items,
  };
}

async function profileMenu(store: ConfigStore, paths: WstackPaths): Promise<ResourceMenuSnapshot> {
  const active = store.get().activeProfile ?? paths.profileName ?? 'default';
  let names: string[] = [];
  try {
    names = (await readdir(paths.profilesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    // First-run installs may not have a profiles directory yet.
  }
  const items = await Promise.all(
    names.map(async (name): Promise<ResourceMenuItem> => {
      const path = paths.profileConfig(name);
      const data = await readJsonObjectFile(path);
      const provider = typeof data['provider'] === 'string' ? data['provider'] : 'unset';
      const model = typeof data['model'] === 'string' ? data['model'] : 'unset';
      const fallbackCount = Array.isArray(data['fallbackModels'])
        ? data['fallbackModels'].length
        : 0;
      const profileCount = isRecord(data['fallbackProfiles'])
        ? Object.keys(data['fallbackProfiles']).length
        : 0;
      const isActive = name === active;
      return {
        id: name,
        label: name,
        status: isActive ? 'good' : 'muted',
        summary: isActive ? 'active' : `${provider}/${model}`,
        details: [
          { label: 'active', value: isActive ? 'yes' : 'no' },
          { label: 'provider', value: provider },
          { label: 'model', value: model },
          {
            label: 'theme',
            value: typeof data['themePreset'] === 'string' ? data['themePreset'] : 'default',
          },
          { label: 'fallbacks', value: String(fallbackCount) },
          { label: 'fallback profiles', value: String(profileCount) },
          { label: 'config', value: path },
        ],
        body: isActive
          ? 'This profile owns the current session configuration.'
          : 'Switching profiles closes this session so every service restarts with the selected configuration.',
        actions: isActive
          ? []
          : [{ key: 's', label: 'switch', command: `/profile switch ${name}`, confirm: true }],
      };
    }),
  );
  return {
    id: 'profile',
    title: 'Profiles',
    subtitle: `active: ${active}`,
    emptyText: 'No profiles found.',
    items,
  };
}

function providerStatusMenu(tracker?: ProviderModelStatusTracker): ResourceMenuSnapshot {
  const snapshot = tracker?.getSnapshot();
  const items: ResourceMenuItem[] =
    snapshot?.statuses.map((status) => ({
      id: `${status.providerId}/${status.model}`,
      label: `${status.providerId}/${status.model}`,
      status: status.state === 'healthy' ? 'good' : status.state === 'degraded' ? 'warn' : 'bad',
      summary: status.state,
      details: [
        { label: 'state', value: status.state },
        { label: 'successes', value: String(status.totalSuccesses) },
        { label: 'failures', value: String(status.totalFailures) },
        { label: 'rate limits', value: String(status.rateLimitHits) },
        { label: 'consecutive failures', value: String(status.consecutiveFailures) },
        {
          label: 'cooldown',
          value: status.stateExpiresAt ? new Date(status.stateExpiresAt).toLocaleString() : 'none',
        },
        { label: 'last error kind', value: status.lastErrorKind ?? 'none' },
      ],
      body: status.lastErrorMessage ?? 'No recorded error.',
      actions: [
        ...(status.state !== 'healthy'
          ? [
              {
                key: 'r',
                label: 'retry now',
                command: `/provider-status retry ${status.providerId} ${status.model}`,
              },
            ]
          : []),
        {
          key: 'x',
          label: 'clear history',
          command: `/provider-status clear ${status.providerId} ${status.model}`,
          confirm: true,
        },
      ],
    })) ?? [];
  return {
    id: 'provider-status',
    title: 'Provider health',
    subtitle: snapshot
      ? `${snapshot.healthy} healthy · ${snapshot.degraded} degraded · ${snapshot.blocked} blocked`
      : 'tracker unavailable',
    emptyText: 'No provider/model activity has been recorded.',
    items,
  };
}

async function memoryMenu(store?: MemoryPort): Promise<ResourceMenuSnapshot> {
  if (!store)
    return {
      id: 'memory',
      title: 'Memory',
      emptyText: 'Memory is disabled in this host.',
      items: [],
    };
  const [health, entries] = await Promise.all([store.health(), store.list(undefined, 100)]);
  return {
    id: 'memory',
    title: 'Memory',
    subtitle: `${health.status} · ${health.backend} · newest 100`,
    emptyText: 'No memories found.',
    items: entries.map((entry, index) => ({
      id: `${entry.ts}:${index}`,
      label: truncate(entry.text.replace(/\s+/g, ' '), 52),
      status: entry.priority === 'critical' || entry.priority === 'high' ? 'warn' : 'muted',
      summary: `${entry.scope} · ${entry.type ?? 'fact'}`,
      details: [
        { label: 'scope', value: entry.scope },
        { label: 'type', value: entry.type ?? 'fact' },
        { label: 'priority', value: entry.priority ?? 'medium' },
        {
          label: 'confidence',
          value: entry.confidence === undefined ? 'unspecified' : entry.confidence.toFixed(2),
        },
        { label: 'created', value: entry.ts },
        { label: 'last accessed', value: entry.lastAccessed ?? 'never' },
        { label: 'tags', value: entry.tags?.join(', ') || 'none' },
        { label: 'source', value: entry.source ?? 'unknown' },
      ],
      body: entry.text,
      actions:
        entry.scope === 'project-memory'
          ? [
              {
                key: 'x',
                label: 'forget matching text',
                command: `/memory forget ${entry.text.replace(/\s+/g, ' ').trim()} --exact`,
                confirm: true,
              },
            ]
          : [],
    })),
  };
}

async function gitMenu(projectRoot: string): Promise<ResourceMenuSnapshot> {
  const [branch, head, status] = await Promise.all([
    runGit(['branch', '--show-current'], projectRoot),
    runGit(['rev-parse', '--short', 'HEAD'], projectRoot),
    runGit(['status', '--porcelain=v1'], projectRoot),
  ]);
  if (status.code !== 0)
    return { id: 'git', title: 'Git', emptyText: 'Not a git repository.', items: [] };
  const lines = status.stdout.split(/\r?\n/).filter(Boolean);
  const items: ResourceMenuItem[] = [
    {
      id: 'repo',
      label: branch.stdout.trim() || '(detached)',
      status: lines.length === 0 ? 'good' : 'warn',
      summary: `${head.stdout.trim() || 'no HEAD'} · ${lines.length === 0 ? 'clean' : `${lines.length} changes`}`,
      details: [
        { label: 'branch', value: branch.stdout.trim() || '(detached)' },
        { label: 'HEAD', value: head.stdout.trim() || '(unborn)' },
        {
          label: 'working tree',
          value: lines.length === 0 ? 'clean' : `${lines.length} changed paths`,
        },
      ],
      actions: [{ key: 'c', label: 'commit workflow', command: '/commit', confirm: true }],
    },
    ...lines.map((line, index) => {
      const code = line.slice(0, 2);
      const path = line.slice(3);
      const staged = code[0] !== ' ' && code[0] !== '?';
      const unstaged = code[1] !== ' ' || code === '??';
      return {
        id: `change:${index}:${path}`,
        label: path,
        status: staged ? ('good' as const) : ('warn' as const),
        summary: `${code} · ${staged ? 'staged' : 'not staged'}${unstaged ? ' · working tree' : ''}`,
        details: [
          { label: 'status', value: code },
          { label: 'staged', value: staged ? 'yes' : 'no' },
          { label: 'unstaged', value: unstaged ? 'yes' : 'no' },
          { label: 'path', value: path },
        ],
        actions: [
          { key: 'd', label: 'diff summary', command: staged ? '/git diff --staged' : '/git diff' },
        ],
      };
    }),
  ];
  return { id: 'git', title: 'Git', subtitle: projectRoot, items };
}

async function worktreeMenu(projectRoot: string): Promise<ResourceMenuSnapshot> {
  const result = await runGit(['worktree', 'list', '--porcelain'], projectRoot);
  if (result.code !== 0) {
    return {
      id: 'worktree',
      title: 'Worktrees',
      emptyText: result.stderr || 'Not a git repository.',
      items: [],
    };
  }
  const records = result.stdout
    .trim()
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/).filter(Boolean))
    .filter((lines) => lines.length > 0);
  const rows = await Promise.all(
    records.map(async (lines, index): Promise<ResourceMenuItem> => {
      const fields = Object.fromEntries(
        lines.map((line) => {
          const split = line.indexOf(' ');
          return split < 0 ? [line, 'yes'] : [line.slice(0, split), line.slice(split + 1)];
        }),
      );
      const path = fields['worktree'] ?? '(unknown path)';
      const branchRef = fields['branch'];
      const branch =
        branchRef?.replace(/^refs\/heads\//, '') ?? (fields['detached'] ? '(detached)' : '(bare)');
      const status =
        path === '(unknown path)' || fields['prunable']
          ? null
          : await runGit(['status', '--porcelain=v1'], path);
      const changes = status?.code === 0 ? status.stdout.split(/\r?\n/).filter(Boolean) : [];
      const dirty = changes.length > 0;
      const isMain = index === 0;
      return {
        id: path,
        label: branch,
        status: fields['prunable'] ? 'bad' : dirty ? 'warn' : 'good',
        summary: `${isMain ? 'main' : 'linked'} · ${dirty ? `${changes.length} changes` : 'clean'}`,
        details: [
          { label: 'path', value: path },
          { label: 'branch', value: branch },
          { label: 'HEAD', value: fields['HEAD']?.slice(0, 12) ?? 'unknown' },
          { label: 'working tree', value: dirty ? `${changes.length} changed paths` : 'clean' },
          { label: 'locked', value: fields['locked'] ?? 'no' },
          { label: 'prunable', value: fields['prunable'] ?? 'no' },
        ],
        body:
          changes.slice(0, 30).join('\n') || (isMain ? 'Primary checkout.' : 'Linked checkout.'),
        actions: isMain
          ? [
              { key: 'p', label: 'prune stale metadata', command: '/worktree prune' },
              {
                key: 'x',
                label: 'clean managed worktrees',
                command: '/worktree clean --yes',
                confirm: true,
              },
            ]
          : branchRef
            ? [
                {
                  key: 'm',
                  label: 'squash merge',
                  command: `/worktree merge ${branch} --yes`,
                  confirm: true,
                },
              ]
            : [],
      };
    }),
  );
  return {
    id: 'worktree',
    title: 'Worktrees',
    subtitle: `${rows.length} checkout${rows.length === 1 ? '' : 's'}`,
    emptyText: 'No worktrees found.',
    items: rows,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
