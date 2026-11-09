import { BUG_HUNT_LIMITS, type BugHuntLimit, type BugHuntMode } from './bug-hunt-message';

/** Proof-Driven Hunt slash commands, their aliases and argument grammar, shared by both apps. */

export interface HuntSlashCommandRoute {
  mode: BugHuntMode;
  canonicalCmd: string;
}

export const HUNT_COMMAND_ROUTES: Readonly<Record<string, HuntSlashCommandRoute>> = {
  '/bughunt': { mode: 'bughunt', canonicalCmd: '/bughunt' },
  '/sechunt': { mode: 'sechunt', canonicalCmd: '/sechunt' },
  '/secproof': { mode: 'sechunt', canonicalCmd: '/sechunt' },
  '/racehunt': { mode: 'racehunt', canonicalCmd: '/racehunt' },
  '/leakhunt': { mode: 'racehunt', canonicalCmd: '/racehunt' },
  '/flakehunt': { mode: 'racehunt', canonicalCmd: '/racehunt' },
  '/debloat': { mode: 'debloat', canonicalCmd: '/debloat' },
  '/deadcode': { mode: 'debloat', canonicalCmd: '/debloat' },
  '/excise': { mode: 'debloat', canonicalCmd: '/debloat' },
  '/uipolish': { mode: 'uipolish', canonicalCmd: '/uipolish' },
  '/a11yhunt': { mode: 'uipolish', canonicalCmd: '/uipolish' },
  '/uihunt': { mode: 'uipolish', canonicalCmd: '/uipolish' },
  '/typehunt': { mode: 'typehunt', canonicalCmd: '/typehunt' },
  '/boundaryhunt': { mode: 'typehunt', canonicalCmd: '/typehunt' },
  '/testgap': { mode: 'testgap', canonicalCmd: '/testgap' },
  '/covhunt': { mode: 'testgap', canonicalCmd: '/testgap' },
  '/invarianthunt': { mode: 'testgap', canonicalCmd: '/testgap' },
};

export function resolveHuntSlashCommand(cmd: string): HuntSlashCommandRoute | undefined {
  const key = cmd.trim().toLowerCase();
  return Object.hasOwn(HUNT_COMMAND_ROUTES, key) ? HUNT_COMMAND_ROUTES[key] : undefined;
}

function isBugHuntLimit(value: number): value is BugHuntLimit {
  return (BUG_HUNT_LIMITS as readonly number[]).includes(value);
}

export function parseHuntSlashArgs(
  rawArgs: string,
):
  | { kind: 'stop' }
  | { kind: 'help' }
  | { kind: 'error' }
  | { kind: 'start'; maxBugs: BugHuntLimit; scope: string } {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return { kind: 'start', maxBugs: 1, scope: '' };
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'stop') {
    return { kind: 'stop' };
  }
  if (lower === 'help' || lower === '--help' || lower === '-h') {
    return { kind: 'help' };
  }

  const tokens = trimmed.split(/\s+/);
  let maxBugs: BugHuntLimit = 1;
  const scopeParts: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '--rounds' || token === '-n') {
      const next = tokens[i + 1];
      if (!next || !/^\d+$/.test(next)) {
        return { kind: 'error' };
      }
      const parsed = Number.parseInt(next, 10);
      if (!isBugHuntLimit(parsed)) {
        return { kind: 'error' };
      }
      maxBugs = parsed;
      i++;
      continue;
    }
    if (token.startsWith('--rounds=')) {
      const value = token.slice('--rounds='.length);
      if (!/^\d+$/.test(value)) {
        return { kind: 'error' };
      }
      const parsed = Number.parseInt(value, 10);
      if (!isBugHuntLimit(parsed)) {
        return { kind: 'error' };
      }
      maxBugs = parsed;
      continue;
    }
    scopeParts.push(token);
  }

  return {
    kind: 'start',
    maxBugs,
    scope: scopeParts.join(' ').trim(),
  };
}
