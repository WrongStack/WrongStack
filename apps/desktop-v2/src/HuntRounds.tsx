import type { BugHuntSummary } from '@wrongstack/project-surfaces/lib/bug-hunt-message';
import { Crosshair } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  clearHuntStop,
  type HuntRequest,
  huntContinues,
  huntLabel,
  huntSlug,
  huntStopped,
  latestHuntRound,
  nextHuntRound,
  prepareHunt,
  requestHuntStop,
  stopHunt,
} from './desktop-hunt';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import './hunt.css';

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The composer's hunts: `start` sends a hunt's first round, `stop` answers `/<hunt> stop`,
 * `continues` holds back automatic next steps while a hunt has rounds left, and `view` runs the
 * rounds after it.
 */
export function useHunts({
  state,
  command,
  sendRound,
  onDraftChange,
  report,
}: {
  state: EngineState;
  command: EngineCommand;
  /** Sends one round as it is; resolves with the composer notice, rejects when not sent. */
  sendRound: (text: string) => Promise<string>;
  onDraftChange: (text: string) => unknown;
  /** Shows a notice and an error in the composer (empty strings clear them). */
  report: (notice: string, problem: string) => void;
}): {
  start(request: HuntRequest): Promise<void>;
  stop(): string | null;
  continues: boolean;
  view: ReactNode;
} {
  const start = async (request: HuntRequest) => {
    report(`Starting ${huntLabel(request.mode)}…`, '');
    try {
      const text = await prepareHunt(request, command, state.results['prefs.updated'] ?? {});
      clearHuntStop(state.sessionId);
      report(await sendRound(text), '');
      void onDraftChange('');
      void command('prompts.used', { slug: huntSlug(request.mode) }, ['prompts.used']).catch(
        () => {},
      );
    } catch (error) {
      report('', reason(error));
    }
  };
  const view = (
    <HuntRounds
      state={state}
      onContinue={(text, round) =>
        sendRound(text).then(
          (notice) => report(notice, ''),
          (error: unknown) => {
            report(
              '',
              `${huntLabel(round.mode)} paused: round ${round.currentRound + 1} could not be sent. ${reason(error)}`,
            );
            throw error;
          },
        )
      }
    />
  );
  return { start, stop: () => requestHuntStop(state), continues: huntContinues(state), view };
}

/**
 * Starts a hunt's next round once the previous one finished successfully, as the WebUI does. Only a
 * result that arrives while the conversation is open starts one by itself; a hunt whose round
 * finished while it was closed (or whose next round could not be sent) waits for Continue.
 */
function HuntRounds({
  state,
  onContinue,
}: {
  state: EngineState;
  /** Sends a round; rejects when it could not be sent. */
  onContinue: (text: string, round: BugHuntSummary) => Promise<void>;
}) {
  const result = state.results['run.result'];
  const live = state.connected && !state.hydrating;
  const seen = useRef<{ session: string; result: unknown } | null>(null);
  // The result the effect below has looked at; the Continue bar waits for it, so a fresh result
  // is never offered by hand while the effect is about to send its round.
  const [processed, setProcessed] = useState<{ session: string; result: unknown } | null>(null);
  const [started, setStarted] = useState<unknown>(null);
  const [, setDismissed] = useState(0);
  const latest = useRef({ state, onContinue });
  latest.current = { state, onContinue };
  const send = (round: BugHuntSummary, text: string) => {
    setStarted(result);
    void latest.current.onContinue(text, round).catch(() => setStarted(null));
  };
  useEffect(() => {
    const previous = seen.current;
    seen.current = { session: state.sessionId, result };
    setProcessed(seen.current);
    if (!live || previous?.session !== state.sessionId || previous.result === result) return;
    const now = latest.current.state;
    const round = latestHuntRound(now.messages);
    if (result?.['status'] !== 'done' || !round || huntStopped(now.sessionId)) return;
    const text = nextHuntRound(round);
    if (!text) return;
    setStarted(result);
    void latest.current.onContinue(text, round).catch(() => setStarted(null));
  }, [result, live, state.sessionId]);
  const round = latestHuntRound(state.messages);
  const next = round && nextHuntRound(round);
  if (
    !live ||
    state.running ||
    !round ||
    !next ||
    result?.['status'] !== 'done' ||
    started === result ||
    processed?.result !== result ||
    processed.session !== state.sessionId ||
    huntStopped(state.sessionId)
  )
    return null;
  return (
    <div className="hunt-paused" role="status">
      <Crosshair size={14} />
      <span>
        {huntLabel(round.mode)} paused after round {round.currentRound}/{round.maxBugs}.
      </span>
      <button type="button" className="button small" onClick={() => send(round, next)}>
        Continue with round {round.currentRound + 1}
      </button>
      <button
        type="button"
        className="button secondary small"
        onClick={() => {
          stopHunt(state.sessionId);
          setDismissed((count) => count + 1);
        }}
      >
        End hunt
      </button>
    </div>
  );
}

/** The card a hunt round shows in place of its long protocol text. */
export function HuntRoundCard({ round }: { round: BugHuntSummary }) {
  return (
    <div className="hunt-round-card">
      <strong>
        <Crosshair size={15} /> {huntLabel(round.mode)}
      </strong>
      <div>
        <span className="hunt-round">
          Round {round.currentRound} of {round.maxBugs}
        </span>
        <span title={round.scope || 'Whole project'}>
          {round.scope ? `${round.scope} and below` : 'Whole project'}
        </span>
      </div>
    </div>
  );
}
