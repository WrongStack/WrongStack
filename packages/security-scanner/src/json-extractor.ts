type JsonContainer = 'object' | 'array';

function extractBalanced(text: string, container: JsonContainer): string | null {
  const opening = container === 'object' ? '{' : '[';
  const closing = container === 'object' ? '}' : ']';

  // One string-aware pass marks every position inside a JSON-style string
  // (double-quoted, backslash escapes). The start scan below must ignore
  // brackets inside strings: an LLM preamble like `see "[1]" markers` makes
  // `[1]` the first bracket, and starting there yields a non-parseable slice
  // even when valid JSON follows — batch-scanner then drops the whole
  // batch's findings when JSON.parse rejects it.
  const insideString = new Array<boolean>(text.length).fill(false);
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      insideString[index] = true;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      insideString[index] = true;
      inString = true;
    }
  }

  for (let start = 0; start < text.length; start++) {
    if (insideString[start] || text[start] !== opening) continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === opening) {
        depth++;
      } else if (char === closing) {
        depth--;
        if (depth === 0) return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

export function extractJsonBlock(text: string, container: JsonContainer): string | null {
  const fencedBlocks = [...text.matchAll(/```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/gi)];
  for (const match of fencedBlocks) {
    const extracted = extractBalanced(match[1]!, container);
    if (extracted) return extracted;
  }
  return extractBalanced(text, container);
}
