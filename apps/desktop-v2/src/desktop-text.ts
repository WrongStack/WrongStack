import english from './locales/en/desktop.json';

type TextValues = Record<string, string | number>;

const englishGroup = (group: string): Record<string, string> => {
  const node = (english as Record<string, unknown>)[group];
  return node && typeof node === 'object' ? (node as Record<string, string>) : {};
};
const fill = (template: string, values: TextValues) =>
  template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name] ?? ''));

/**
 * One line of a catalog group in English. Model code reports in English, before it knows the
 * display language; {@link localizedText} turns the line into the display language later.
 */
export function englishText(group: string, key: string, values: TextValues = {}): string {
  const template = englishGroup(group)[key];
  if (template === undefined) throw Error(`Missing English desktop text ${group}.${key}`);
  return fill(template, values);
}

const patterns = new Map<string, Array<{ key: string; names: string[]; pattern: RegExp }>>();
const groupPatterns = (group: string) => {
  let found = patterns.get(group);
  if (!found) {
    found = Object.entries(englishGroup(group)).map(([key, template]) => {
      const names = [...template.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1] ?? '');
      const source = template
        .split(/\{\{\w+\}\}/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('([\\s\\S]*?)');
      return { key, names, pattern: new RegExp(`^${source}$`) };
    });
    patterns.set(group, found);
  }
  return found;
};

/**
 * Shows text in the display language when it is a line of the given catalog group in English
 * (its values carried over); any other text, such as an engine's own message, as it came.
 */
export function localizedText(
  text: string,
  group: string,
  t: (key: string, values: TextValues) => string,
): string {
  for (const { key, names, pattern } of groupPatterns(group)) {
    const match = pattern.exec(text);
    if (!match) continue;
    const values: TextValues = {};
    names.forEach((name, index) => {
      values[name] = match[index + 1] ?? '';
    });
    return t(`${group}.${key}`, values);
  }
  return text;
}
