import {
  parseHuntSlashArgs,
  resolveHuntSlashCommand,
} from '@wrongstack/project-surfaces/lib/bug-hunt-commands';
import {
  BUG_HUNT_MODE_DESCRIPTIONS,
  BUG_HUNT_MODE_LABELS,
  BUG_HUNT_MODE_SLUGS,
  buildBugHuntMessage,
  firstHuntRoundInstruction,
} from '@/lib/bug-hunt-message';
import { launchBuiltinRound, type RoundLauncherClient } from '@/lib/launch-builtin-round';
import { useBugHuntRunStore } from '@/stores/bug-hunt-run-store';
import { useLocalPrefs } from '@/stores/local-prefs';
import type { ChatAssistantMessage, SlashRoutingClient } from './slash-routing-types.js';

function isFullRoundLauncherClient(
  client: SlashRoutingClient | null | undefined,
): client is SlashRoutingClient & RoundLauncherClient {
  return Boolean(
    client &&
      typeof client.on === 'function' &&
      typeof client.sendMessage === 'function' &&
      typeof client.send === 'function',
  );
}

export interface RunHuntSlashCommandOptions {
  cmd: string;
  args: string;
  sessionId?: string | null | undefined;
  isLoading: boolean;
  client: SlashRoutingClient | null | undefined;
  addMessage: (message: ChatAssistantMessage) => void;
  setLoading: (loading: boolean) => void;
}

export function runHuntSlashCommand(options: RunHuntSlashCommandOptions): boolean {
  const route = resolveHuntSlashCommand(options.cmd);
  if (!route) return false;

  const { mode, canonicalCmd } = route;
  const label = BUG_HUNT_MODE_LABELS[mode];
  const slug = BUG_HUNT_MODE_SLUGS[mode];
  const parsed = parseHuntSlashArgs(options.args);

  if (parsed.kind === 'help') {
    options.addMessage({
      role: 'assistant',
      content: `Usage: \`${canonicalCmd} [--rounds 1..10] [scope]\` or \`${canonicalCmd} stop\` — **${label}** (${BUG_HUNT_MODE_DESCRIPTIONS[mode]})`,
    });
    return true;
  }

  if (parsed.kind === 'error') {
    options.addMessage({
      role: 'assistant',
      content: `Usage: \`${canonicalCmd} [--rounds 1..10] [scope]\` — WebUI supports 1 to 10 rounds per run.`,
    });
    return true;
  }

  if (parsed.kind === 'stop') {
    const store = useBugHuntRunStore.getState();
    // A caller with a session stops only its own hunt; falling back to the
    // first run stopped another tab's hunt.
    const targetSessionId = options.sessionId
      ? store.runs[options.sessionId]
        ? options.sessionId
        : undefined
      : Object.keys(store.runs)[0];
    const activeRun = targetSessionId ? store.runs[targetSessionId] : undefined;
    if (!targetSessionId || !activeRun) {
      options.addMessage({
        role: 'assistant',
        content: 'No Proof-Driven Hunt is currently active in this session.',
      });
      return true;
    }
    const activeLabel =
      activeRun.mode && activeRun.mode !== 'bughunt' ? BUG_HUNT_MODE_LABELS[activeRun.mode] : label;
    store.clear(targetSessionId);
    options.addMessage({
      role: 'assistant',
      content: `🛑 Stopping **${activeLabel}** after round ${activeRun.currentRound}/${activeRun.totalRounds} finishes. (Use \`/stop\` to abort the in-flight turn immediately.)`,
    });
    return true;
  }

  if (options.isLoading) {
    options.addMessage({
      role: 'assistant',
      content: `⏳ Wait for the current turn to finish (or use \`/stop\`) before starting **${label}**.`,
    });
    return true;
  }

  if (options.client?.isConnected === false) {
    options.addMessage({
      role: 'assistant',
      content: `⚠️ Not connected to the WrongStack server. Reconnect before starting **${label}**.`,
    });
    return true;
  }

  const { maxBugs, scope } = parsed;
  const modePatch = mode === 'bughunt' ? {} : { mode };
  const resolvedSessionId = options.sessionId ?? undefined;

  if (isFullRoundLauncherClient(options.client)) {
    const prefsState = useLocalPrefs.getState();
    launchBuiltinRound({
      client: options.client,
      slug,
      requireSoloSession: true,
      keepCompanions: true,
      subagentsAllowed: prefsState.subagentsAllowed,
      sessionId: resolvedSessionId,
      setPrefs: (patch) => useLocalPrefs.getState().set(patch),
      compose: (content) =>
        buildBugHuntMessage(firstHuntRoundInstruction(content, { scope, maxBugs }, 'WebUI'), {
          scope,
          maxBugs,
          currentRound: 1,
          ...modePatch,
        }),
      onSent: (id, content) => {
        if (resolvedSessionId) {
          useBugHuntRunStore.getState().start(resolvedSessionId, {
            scope,
            totalRounds: maxBugs,
            currentRound: 1,
            requestId: id,
            ...modePatch,
          });
        }
        options.addMessage({
          id,
          role: 'user',
          content,
          bugHunt: { scope, maxBugs, currentRound: 1, ...modePatch },
        });
        options.setLoading(true);
      },
      onSettle: (state) => {
        if (state === 'error') {
          options.addMessage({
            role: 'assistant',
            content: `⚠️ Could not launch **${label}** (builtin prompt \`${slug}\` unavailable or connection timed out).`,
          });
        }
      },
    });
    return true;
  }

  const sessionKey = resolvedSessionId ?? 'default';
  useBugHuntRunStore.getState().start(sessionKey, {
    scope,
    totalRounds: maxBugs,
    currentRound: 1,
    requestId: null,
    ...modePatch,
  });
  options.client?.send?.({ type: 'prompts.content', payload: { slug } });
  options.addMessage({
    role: 'assistant',
    content: `🎯 Launching **${label}** (round 1/${maxBugs}, scope: ${scope || 'whole project'})…`,
  });
  return true;
}
