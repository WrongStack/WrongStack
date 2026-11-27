import {
  described,
  json,
  object,
  str,
  stringField,
  workflowPlugin,
} from '../workflow-runtime/index.js';

function flatten(value: Record<string, unknown>, prefix = '', depth = 0): Record<string, string> {
  if (depth > 30) throw new Error('Locale nesting exceeds 30');
  const result: Record<string, string> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof item === 'string') result[path] = item;
    else if (item && typeof item === 'object' && !Array.isArray(item))
      Object.assign(result, flatten(object(item), path, depth + 1));
    else throw new Error(`Unsupported locale value at ${path}`);
  }
  return result;
}
function placeholders(text: string) {
  return [
    ...new Set([...text.matchAll(/\{\{?\s*([\w.]+)\s*(?:\}\}?|,)/g)].map((match) => match[1]!)),
  ].sort();
}
export default workflowPlugin({
  name: 'localization-completeness',
  description:
    'Compares nested JSON locale keys, empty translations and interpolation variables across languages, including explicitly keyed plural variants',
  tools: [
    {
      name: 'localization_compare',
      description:
        'Compare base JSON locale with locales mapping language names to project file paths. Checks missing/extra keys, empty strings and placeholder sets; does not parse full ICU grammar.',
      properties: {
        base: described(stringField, 'Project-relative JSON file of the base language.'),
        locales: {
          type: 'object',
          additionalProperties: stringField,
          description:
            'Language name to project-relative JSON file, e.g. {"de": "locales/de.json"}.',
        },
      },
      required: ['base', 'locales'],
      async run(input, context) {
        const base = flatten(await json(context.root, input.base));
        const locales = [];
        for (const [language, path] of Object.entries(object(input.locales))) {
          const translated = flatten(await json(context.root, str(path)));
          const missing = Object.keys(base).filter((key) => !Object.hasOwn(translated, key));
          const extra = Object.keys(translated).filter((key) => !Object.hasOwn(base, key));
          const mismatches = Object.entries(base).flatMap(([key, text]) =>
            Object.hasOwn(translated, key) &&
            JSON.stringify(placeholders(text)) !== JSON.stringify(placeholders(translated[key]!))
              ? [{ key, expected: placeholders(text), actual: placeholders(translated[key]!) }]
              : [],
          );
          const empty = Object.keys(translated).filter((key) => !translated[key]!.trim());
          locales.push({
            language,
            missing,
            extra,
            mismatches,
            empty,
            passed: !missing.length && !extra.length && !mismatches.length && !empty.length,
          });
        }
        return {
          passed: locales.length > 0 && locales.every((locale) => locale.passed),
          baseKeys: Object.keys(base).length,
          locales,
          limitation:
            'Explicit plural keys are compared as keys; CLDR plural categories and full ICU syntax need the project i18n compiler.',
        };
      },
    },
  ],
});
