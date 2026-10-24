/**
 * `explain()` is a second, side-effect-free walk of the same rules as
 * `evaluate()`. Two implementations drift unless something compares them, so
 * this runs both over a matrix of tools, inputs, trust files, YOLO,
 * `--allowed-tools`, one-shot session answers and `/permissions allow|deny`
 * session rules, and requires the same decision, source and grant from each.
 *
 * It also holds the compiled rule list to the policy: every decision must
 * land on a listed rule (`matchedPermissionRule`), and a deny on a deny rule.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionPermissionOverride, Tool } from '@wrongstack/contracts/types';
import { expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { ToolCapabilities } from '../../src/security/capabilities.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import {
  compilePermissionRules,
  matchedPermissionRule,
} from '../../src/security/permission-rules.js';

const T = (
  name: string,
  permission: 'auto' | 'confirm' | 'deny',
  mutating: boolean,
  capabilities: string[] = [],
  riskTier?: 'safe' | 'standard' | 'destructive',
  subjectKey?: string,
): Tool =>
  ({
    name,
    description: name,
    inputSchema: { type: 'object' },
    permission,
    mutating,
    capabilities,
    riskTier,
    ...(subjectKey ? { subjectKey } : {}),
    async execute() {
      return 'ok';
    },
  }) as Tool;

const tools: Array<[Tool, unknown[]]> = [
  [
    T('read', 'auto', false, [ToolCapabilities.FS_READ]),
    [{ path: 'src/a.ts' }, { path: '.env' }, { path: '/home/u/.ssh/id_rsa' }],
  ],
  [
    T('write', 'confirm', true, [ToolCapabilities.FS_WRITE]),
    [
      { path: 'src/a.ts', content: 'x' },
      { path: '.env', content: 'x' },
      { path: '.wrongstack/config.json', content: '{}' },
    ],
  ],
  [
    T('edit', 'confirm', true, [ToolCapabilities.FS_WRITE]),
    [{ path: 'src/a.ts' }, { path: '.env' }],
  ],
  [
    T('bash', 'confirm', true, [ToolCapabilities.SHELL_ARBITRARY], undefined, 'command'),
    [
      { command: 'git status' },
      { command: 'rm -rf /' },
      { command: 'pnpm test --run' },
      { command: 'git push --force' },
      {},
    ],
  ],
  [T('mcp__gh__issue', 'confirm', true), [{ title: 'x' }]],
  [T('nuke', 'confirm', true, [], 'destructive'), [{ target: 'a' }]],
  [T('forbidden', 'deny', true), [{}]],
  [T('ls_auto_mut', 'auto', true), [{ path: 'x' }]],
  [T('grep', 'auto', false, [ToolCapabilities.FS_READ]), [{ pattern: 'x', path: 'src' }]],
];

const policies: Array<[string, unknown]> = [
  ['empty', {}],
  ['bash allow git*', { bash: { allow: ['git *'] } }],
  ['bash allow * deny rm', { bash: { allow: ['*'], deny: ['rm *'] } }],
  ['wildcard deny env', { '*': { deny: ['**/.env*', '.env*'] } }],
  ['mcp auto', { 'mcp__*': { auto: true } }],
  ['edit auto + deny env', { edit: { auto: true, deny: ['.env*'] } }],
  ['expired allow', { bash: { allow: ['*'], allowUntil: 1 } }],
  ['tool scope bash', { bash: { allow: ['wrongstack-approval:v1:tool'] } }],
  ['tool scope nuke', { nuke: { allow: ['wrongstack-approval:v1:tool'] } }],
  ['read tool scope', { read: { allow: ['wrongstack-approval:v1:tool'] } }],
  ['write tool scope', { write: { allow: ['wrongstack-approval:v1:tool'] } }],
  ['mcp tool scope', { mcp__gh__issue: { allow: ['wrongstack-approval:v1:tool'] } }],
  ['write allow all', { write: { allow: ['**'] } }],
  ['bash deny, no subject', { bash: { deny: ['rm *'] } }],
];

const sessionRules: Array<[string, SessionPermissionOverride[]]> = [
  ['no session rules', []],
  ['allow bash pnpm test*', [{ effect: 'allow', tool: 'bash', pattern: 'pnpm test*' }]],
  ['allow bash any', [{ effect: 'allow', tool: 'bash' }]],
  ['deny bash git *', [{ effect: 'deny', tool: 'bash', pattern: 'git *' }]],
  ['allow * any', [{ effect: 'allow', tool: '*' }]],
  [
    'deny read .env*, allow read',
    [
      { effect: 'deny', tool: 'read', pattern: '.env*' },
      { effect: 'allow', tool: 'read' },
    ],
  ],
  ['allow mcp__* any', [{ effect: 'allow', tool: 'mcp__*' }]],
];

it('explain() reaches the decision evaluate() makes, for every combination', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'probe-explain-'));
  const diffs: string[] = [];
  const unlisted: string[] = [];
  let total = 0;
  try {
    for (const [pname, pol] of policies) {
      for (const yolo of [false, true]) {
        for (const launch of [[], ['bash'], ['mcp__*']]) {
          for (const session of ['none', 'allowOnce', 'denyOnce']) {
            for (const [rname, overrides] of sessionRules) {
              // Session rules crossed with the plain answers and grants only.
              if (overrides.length > 0 && (launch.length > 0 || session !== 'none')) continue;
              for (const [tool, inputs] of tools) {
                for (const input of inputs) {
                  const trustFile = path.join(dir, `t${total}.json`);
                  await fs.writeFile(trustFile, JSON.stringify(pol));
                  const p = new DefaultPermissionPolicy({
                    trustFile,
                    yolo,
                    launchAllowedTools: launch,
                  });
                  const ctx = {
                    session: { id: 's1' },
                    hasRead: (f: string) => f === 'src/a.ts',
                    cwd: dir,
                    projectRoot: dir,
                    meta: overrides.length > 0 ? { permissionOverrides: overrides } : {},
                  } as unknown as Context;
                  const subj =
                    (input as { command?: string; path?: string }).command ??
                    (input as { path?: string }).path ??
                    tool.name;
                  if (session === 'allowOnce') p.allowOnce({ tool: tool.name, pattern: subj });
                  if (session === 'denyOnce') p.denyOnce({ tool: tool.name, pattern: subj });
                  let ex: string;
                  let ev: string;
                  const combo = `[${pname}] yolo=${yolo} launch=${launch.join(',') || '-'} session=${session} rules=${rname} ${tool.name} ${JSON.stringify(input)}`;
                  try {
                    const trace = await p.explain(tool, input, ctx);
                    ex = `${trace.decision.permission}/${trace.decision.source}/${trace.decision.launchGrant ?? '-'}/${trace.decision.approvalGrant ?? '-'}`;
                    const rule = matchedPermissionRule(
                      await compilePermissionRules(p, ctx, { yolo }),
                      trace,
                    );
                    if (!rule)
                      unlisted.push(`${combo}  winner=${trace.steps[trace.winnerIndex]?.rule}`);
                    else if (trace.decision.permission === 'deny' && rule.effect !== 'deny') {
                      unlisted.push(`${combo}  deny decided by #${rule.n} ${rule.effect}`);
                    }
                  } catch (e) {
                    ex = `THROW ${(e as Error).message}`;
                  }
                  try {
                    const d = await p.evaluate(tool, input, ctx);
                    ev = `${d.permission}/${d.source}/${d.launchGrant ?? '-'}/${d.approvalGrant ?? '-'}`;
                  } catch (e) {
                    ev = `THROW ${(e as Error).message}`;
                  }
                  total++;
                  if (ex !== ev) diffs.push(`${combo}  evaluate=${ev}  explain=${ex}`);
                }
              }
            }
          }
        }
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  expect(total).toBeGreaterThan(4_000);
  expect(diffs).toEqual([]);
  expect(unlisted).toEqual([]);
}, 600_000);
