type JsonContainer = 'object' | 'array';

function extractBalanced(text: string, container: JsonContainer): string | null {
  const opening = container === 'object' ? '{' : '[';
  const closing = container === 'object' ? '}' : ']';

  for (let start = 0; start < text.length; start++) {
    if (text[start] !== opening) continue;

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
