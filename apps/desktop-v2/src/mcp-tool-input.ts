/** A starting input for an MCP tool: its required properties with empty values of their type. */
export function skeletonInput(schema: unknown): Record<string, unknown> {
  const root = isRecord(schema) ? schema : {};
  const properties = isRecord(root['properties']) ? root['properties'] : {};
  const required = Array.isArray(root['required'])
    ? root['required'].filter((key): key is string => typeof key === 'string')
    : [];
  return Object.fromEntries(
    required.map((key) => {
      const property = isRecord(properties[key]) ? properties[key] : {};
      return [key, emptyValue(property['type'])];
    }),
  );
}

/** The tool input typed in the editor: a JSON object, or the reason it is not one. */
export function parseToolInput(
  text: string,
):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: 'json' | 'object'; error: string; detail?: string } {
  if (!text.trim()) return { ok: true, value: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = (error as Error).message;
    return { ok: false, reason: 'json', error: `The input is not valid JSON: ${detail}`, detail };
  }
  return isRecord(value)
    ? { ok: true, value }
    : { ok: false, reason: 'object', error: 'The input must be a JSON object.' };
}

/** Property names of a tool schema, required ones first and marked. */
export function schemaFields(
  schema: unknown,
): Array<{ name: string; required: boolean; type: string }> {
  const root = isRecord(schema) ? schema : {};
  const properties = isRecord(root['properties']) ? root['properties'] : {};
  const required = new Set(Array.isArray(root['required']) ? root['required'] : []);
  return Object.entries(properties)
    .map(([name, property]) => ({
      name,
      required: required.has(name),
      type: isRecord(property) && typeof property['type'] === 'string' ? property['type'] : 'any',
    }))
    .sort((a, b) => Number(b.required) - Number(a.required));
}

function emptyValue(type: unknown): unknown {
  switch (Array.isArray(type) ? type[0] : type) {
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
