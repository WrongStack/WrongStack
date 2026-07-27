/**
 * Interactive prompt for an abandoned-session recovery decision.
 *
 * Three branches:
 *   - `autoRecover` is true (caller passed `--recover`): resume silently.
 *   - stdin is not a TTY (CI / piped): skip, leave the session alone.
 *   - interactive: ask the user — y/Y/Enter resume, n/N skip, d/D delete.
 *
 * Exists as a free function so it can be unit-tested with a fake
 * `ReadlineInputReader` and a renderer stub. Previously a private nested
 * function in `index.ts`; extracted as part of the cli/index.ts decompose
 * pass to make the recovery contract independently testable.
 */

import type { AbandonedSession } from '@wrongstack/core/storage';
import { color, isStdinTTY } from '@wrongstack/core/utils';
import type { ReadlineInputReader } from './input-reader.js';
import type { TerminalRenderer } from './renderer.js';

export type RecoveryDecision = 'resume' | 'delete' | 'skip';

export async function promptRecovery(
  reader: ReadlineInputReader,
  renderer: TerminalRenderer,
  abandoned: AbandonedSession,
  autoRecover: boolean,
): Promise<RecoveryDecision> {
  const minutes = Math.round(abandoned.ageMs / 60_000);
  const ageLabel =
    minutes < 1
      ? `${Math.round(abandoned.ageMs / 1000)}s ago`
      : minutes < 60
        ? `${minutes} min ago`
        : `${Math.round(minutes / 60)}h ago`;
  const displayName = abandoned.title?.trim() || abandoned.sessionId;
  const summary = `Previous session was killed mid-run: ${displayName} [${abandoned.sessionId}] (${abandoned.messageCount} messages, ${ageLabel}).`;
  const content = abandoned.lastUserMessage
    ? ` Latest request: ${abandoned.lastUserMessage}`
    : '';
  if (autoRecover) {
    renderer.writeInfo(`${summary}${content} Auto-resuming (--recover).`);
    return 'resume';
  }
  if (!isStdinTTY()) {
    renderer.writeInfo(
      `${summary} Non-interactive — leaving as-is. Use \`wstack resume ${abandoned.sessionId}\` or pass \`--recover\` to auto-resume.`,
    );
    return 'skip';
  }
  renderer.writeInfo(summary);
  const answer = await reader.readKey(
    `${color.amber('?')} Recover it? ${color.dim('[')}${color.bold('Y')}es / ${color.bold('n')}o / ${color.bold('d')}elete${color.dim(']')} `,
    [
      { key: 'y', label: 'yes', value: 'resume' },
      { key: 'Y', label: 'yes', value: 'resume' },
      { key: '\r', label: 'yes', value: 'resume' },
      { key: '\n', label: 'yes', value: 'resume' },
      { key: 'n', label: 'no', value: 'skip' },
      { key: 'N', label: 'no', value: 'skip' },
      { key: 'd', label: 'delete', value: 'delete' },
      { key: 'D', label: 'delete', value: 'delete' },
    ],
  );
  return answer as RecoveryDecision;
}
