import { useChatStore } from '@/stores';
import { parseNextSteps } from '../NextStepsBar.js';

function stepsFromMessage(
  m:
    | {
        content: string;
        nextSteps?: { steps: Array<{ index: number; text: string }> } | undefined;
      }
    | undefined,
): Array<{ index: number; text: string }> {
  if (!m) return [];
  if (m.nextSteps && m.nextSteps.steps.length > 0) {
    return m.nextSteps.steps.map((s) => ({ index: s.index, text: s.text }));
  }
  return parseNextSteps(m.content).steps.map((step) => ({
    index: step.index,
    text: step.text,
  }));
}

function stepsFromLastAssistant(): Array<{ index: number; text: string }> {
  const all = useChatStore.getState().messages;
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    if (m?.role === 'assistant' && m.content) {
      return stepsFromMessage(m);
    }
  }
  return [];
}

export function handleNextList(): true {
  const all = useChatStore.getState().messages;
  let lastMsg:
    | {
        content: string;
        nextSteps?: { steps: Array<{ index: number; text: string }> } | undefined;
      }
    | undefined;
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    if (m?.role === 'assistant' && m.content) {
      lastMsg = m;
      break;
    }
  }
  const steps = stepsFromMessage(lastMsg);
  if (steps.length === 0) {
    useChatStore.getState().addMessage({
      role: 'assistant',
      content: '💡 _No next-step suggestions found. Use `/suggest` to generate some._',
    });
    return true;
  }
  const lines = ['💡 **Next steps**', ''];
  for (const s of steps) lines.push(`${s.index}. ${s.text}`);
  lines.push('', '_Use `/next 1`, `/next 1 2 3` to execute._');
  useChatStore.getState().addMessage({ role: 'assistant', content: lines.join('\n') });
  return true;
}

export function handleNextSelect(
  input: string,
  sendMsg: (content: string) => void,
): true {
  const steps = stepsFromLastAssistant();
  if (steps.length === 0) {
    useChatStore.getState().addMessage({
      role: 'assistant',
      content: '💡 _No suggestions available. Use `/suggest` first._',
    });
    return true;
  }
  const parts = input.split(/[\s,]+/).filter(Boolean);
  const indices = parts
    .map((p) => Number.parseInt(p, 10))
    .filter((n) => !Number.isNaN(n) && n > 0);
  if (indices.length === 0) {
    useChatStore.getState().addMessage({ role: 'assistant', content: '💡 _No valid suggestion numbers._' });
    return true;
  }
  const invalid = indices.filter((i) => i > steps.length);
  if (invalid.length > 0) {
    useChatStore.getState().addMessage({
      role: 'assistant',
      content: `💡 _Invalid suggestion(s): ${invalid.join(', ')}. Valid range: 1–${steps.length}._`,
    });
    return true;
  }
  for (const i of indices) {
    const s = steps[i - 1];
    if (s) sendMsg(s.text);
  }
  return true;
}
