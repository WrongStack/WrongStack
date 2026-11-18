function sliceCodePoints(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > maxUnits) break;
    out += ch;
  }
  return `${out}…`;
}

function cleanUserIntentSnippet(raw: string): string {
  const withoutSystemBlocks = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/\[System:[\s\S]*?\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!withoutSystemBlocks || withoutSystemBlocks.startsWith('/')) return '';
  return sliceCodePoints(withoutSystemBlocks, 220);
}

/**
 * Extract up to the 3 most recent user request snippets from conversation
 * messages and/or explicit `agent.run.started` `inputText` entries, bounded to
 * ~540 UTF-16 code units total so the reviewer understands session intent
 * without bloating prompt tokens.
 */
export function extractSessionIntentSnippets(input: {
  messages?: ReadonlyArray<{ role?: string | undefined; content?: unknown }> | undefined;
  extraInputs?: readonly string[] | undefined;
}): string[] {
  const candidates: string[] = [];

  if (Array.isArray(input.messages)) {
    for (const msg of input.messages) {
      if (msg?.role !== 'user') continue;
      if (typeof msg.content === 'string') {
        const cleaned = cleanUserIntentSnippet(msg.content);
        if (cleaned) candidates.push(cleaned);
      } else if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        for (const block of msg.content) {
          if (
            typeof block === 'object' &&
            block !== null &&
            (block as { type?: unknown }).type === 'text' &&
            typeof (block as { text?: unknown }).text === 'string'
          ) {
            textParts.push((block as { text: string }).text);
          }
        }
        const cleaned = cleanUserIntentSnippet(textParts.join(' '));
        if (cleaned) candidates.push(cleaned);
      }
    }
  }

  if (Array.isArray(input.extraInputs)) {
    for (const text of input.extraInputs) {
      if (typeof text !== 'string') continue;
      const cleaned = cleanUserIntentSnippet(text);
      if (cleaned) candidates.push(cleaned);
    }
  }

  // Deduplicate preserving latest position, keep at most 3 recent snippets.
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (let i = candidates.length - 1; i >= 0; i--) {
    const item = candidates[i]!;
    if (seen.has(item)) continue;
    seen.add(item);
    deduped.unshift(item);
    if (deduped.length >= 3) break;
  }

  let budget = 540;
  const bounded: string[] = [];
  for (const snippet of deduped) {
    if (budget <= 40) break;
    const clipped = sliceCodePoints(snippet, budget);
    bounded.push(clipped);
    budget -= clipped.length;
  }
  return bounded;
}
