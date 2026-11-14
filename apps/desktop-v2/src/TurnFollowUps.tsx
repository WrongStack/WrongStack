import { type RefObject, useRef, useState } from 'react';
import { AutoContinue } from './AutoContinue';
import { autoContinueStep, sessionAutonomy } from './autonomy-model';
import type { EngineState } from './engine-state';
import { NextStepsPanel } from './NextStepsPanel';

/**
 * What follows a finished turn above the composer: its suggested next steps, to send or add to
 * the draft, and in automatic continuation the countdown to the step it would take.
 */
export function TurnFollowUps({
  state,
  composerEmpty,
  huntContinues,
  continued,
  sending,
  onAdd,
  send,
  report,
  onContinue,
}: {
  state: EngineState;
  /** No draft text, references or attachments: an automatic step must not cut across them. */
  composerEmpty: boolean;
  /** A hunt starts its own next round. */
  huntContinues: boolean;
  /** Automatic continuations in a row; any prompt the user sends resets it. */
  continued: RefObject<number>;
  sending: boolean;
  onAdd: (text: string) => void;
  /** Sends a prompt as it is; resolves with the composer notice. */
  send: (text: string) => Promise<string>;
  report: (notice: string, problem: string) => void;
  onContinue: (text: string) => void;
}) {
  const visibilityRoot = useRef<HTMLDivElement>(null);
  const [reviewing, setReviewing] = useState<EngineState['nextSteps'] | null>(null);
  const stepKey = state.nextSteps.map((item) => `${item.index}:${item.text}`).join('|');
  if (state.running || state.hydrating || state.inputs.length || state.approvals.length)
    return null;
  const step =
    composerEmpty && !huntContinues && !sending && reviewing !== state.nextSteps
      ? autoContinueStep({
          ...sessionAutonomy(state.results['prefs.updated']),
          count: continued.current,
          steps: state.nextSteps,
        })
      : null;
  return (
    <div
      ref={visibilityRoot}
      onPointerDownCapture={() => setReviewing(state.nextSteps)}
      onFocusCapture={() => setReviewing(state.nextSteps)}
      onKeyDownCapture={() => setReviewing(state.nextSteps)}
    >
      {state.nextSteps.length > 0 && (
        <NextStepsPanel
          steps={state.nextSteps}
          onAdd={onAdd}
          sending={sending}
          onSend={async (text) => {
            continued.current = 0;
            try {
              report(await send(text), '');
              return true;
            } catch (error) {
              report('', error instanceof Error ? error.message : String(error));
              return false;
            }
          }}
        />
      )}
      {step && (
        <AutoContinue
          stepKey={stepKey}
          visibilityRoot={visibilityRoot}
          text={step.text}
          onSubmit={(text) => {
            continued.current += 1;
            onContinue(text);
          }}
        />
      )}
    </div>
  );
}
