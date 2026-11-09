import { record } from './engine-values';
export interface BrainMessage {
  id: string;
  kind: string;
  question?: string;
  source?: string;
  risk?: string;
  tier?: string;
  decisionType?: string;
  text?: string;
  rationale?: string;
  reason?: string;
  optionId?: string;
  confidence?: number;
  pending?: boolean;
}
export function brainMessage(payload: Record<string, unknown>): BrainMessage | null {
  const event = String(payload['event'] ?? '');
  const kinds: Record<string, string> = {
    'brain.decision_answered': 'answered',
    'brain.decision_denied': 'denied',
    'brain.decision_ask_human': 'ask_human',
    'brain.intervention': payload['intervened'] ? 'intervention' : 'check',
  };
  const kind = kinds[event];
  const request = record(payload['request']),
    decision = record(payload['decision']);
  const id = payload['requestId'] ?? request['id'];
  if (!kind || typeof id !== 'string' || !id) return null;
  const result: BrainMessage = { id, kind };
  const fields = {
    question: request['question'],
    source: request['source'],
    risk: request['risk'],
    tier: payload['tier'],
    decisionType: decision['type'],
    text: decision['text'],
    rationale: decision['rationale'],
    reason: decision['reason'],
    optionId: decision['optionId'],
  };
  for (const [key, value] of Object.entries(fields))
    if (typeof value === 'string') Object.assign(result, { [key]: value });
  if (
    typeof decision['confidence'] === 'number' &&
    Number.isFinite(decision['confidence']) &&
    decision['confidence'] >= 0 &&
    decision['confidence'] <= 1
  )
    result.confidence = decision['confidence'];
  if (typeof payload['pending'] === 'boolean') result.pending = payload['pending'];
  return result;
}
/** Recognize the historical plain-text fallback; absent structured facts stay absent. */
export function replayedBrainMessage(text: string): BrainMessage | null {
  if (!text.startsWith('🧠')) return null;
  const headline = text.split('\n\n')[0]?.replace(/^🧠\s*/, '') ?? '';
  const kind = headline.includes('Brain intervention')
    ? 'intervention'
    : headline.includes('Brain check')
      ? 'check'
      : /^Denied:/i.test(headline)
        ? 'denied'
        : /needs human judgement|escalated this question/.test(headline)
          ? 'ask_human'
          : 'answered';
  return {
    id: 'replayed',
    kind,
    text: headline,
    ...(text.includes('\n\n')
      ? { rationale: text.slice(text.indexOf('\n\n') + 2).replace(/^_|_$/g, '') }
      : {}),
  };
}
