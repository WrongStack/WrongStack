/**
 * Builds the structured prompt dispatched when a user starts a Reference Site →
 * DESIGN.md synthesis workflow from the WebUI Welcome Screen or Design Studio.
 */

export type DesignExtractWorkflow = 'extract' | 'materialize-web' | 'materialize-rn';

export const DESIGN_EXTRACT_PAGES = [1, 3, 6, 8] as const;
export type DesignExtractPageCount = (typeof DESIGN_EXTRACT_PAGES)[number];

export const DESIGN_PRESET_SITES = [
  { label: 'stripe.com', url: 'https://stripe.com' },
  { label: 'linear.app', url: 'https://linear.app' },
  { label: 'vercel.com', url: 'https://vercel.com' },
] as const;

export function normalizeDesignSourceInput(raw: string): {
  isUrl: boolean;
  target: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { isUrl: true, target: 'https://stripe.com' };
  if (/^https?:\/\//i.test(trimmed)) return { isUrl: true, target: trimmed };
  // Treat bare domains like "stripe.com" or "linear.app/pricing" as https:// URLs,
  // while keeping local paths like "index.html" or "public/landing.html" as files.
  if (!/\.html?$/i.test(trimmed) && /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(trimmed)) {
    return { isUrl: true, target: `https://${trimmed}` };
  }
  return { isUrl: false, target: trimmed };
}

export function buildDesignExtractPrompt(options: {
  source: string;
  maxPages: number;
  workflow: DesignExtractWorkflow;
}): string {
  const { isUrl, target } = normalizeDesignSourceInput(options.source);
  const pages = Math.min(8, Math.max(1, Math.trunc(options.maxPages || 1)));
  const extractCall = JSON.stringify({
    action: 'extract',
    ...(isUrl ? { url: target } : { file: target }),
    ...(pages > 1 ? { maxPages: pages } : {}),
  });

  const steps = [
    `Extract a complete \`DESIGN.md\` specification and Design DNA bundle from \`${target}\` across the 5-breakpoint responsive matrix (1440, 1280, 1024, 768, 375px)${pages > 1 ? ` and up to ${pages} same-origin pages` : ''}:`,
    '',
    `1. Run \`design_reference ${extractCall}\` to measure the live DOM/CSS tokens, palette roles, typography scale, 14 component archetypes, gradients, interaction states, and responsive breakpoints into \`.design/references/<slug>/DESIGN.md\`.`,
  ];

  if (options.workflow === 'materialize-web' || options.workflow === 'materialize-rn') {
    const stack = options.workflow === 'materialize-rn' ? 'react-native' : 'web';
    steps.push(
      `2. Capture the generated \`.design/references/<slug>/DESIGN.md\` tokens via \`design {"action":"capture","files":[".design/references/<slug>/DESIGN.md"]}\` and compile them into a native \`${stack}\` theme file via \`design {"action":"materialize","stack":"${stack}"}\`.`,
      '3. Summarize the extracted brand atmosphere, color roles, typography hierarchy, component catalog, and generated file paths.',
    );
  } else {
    steps.push(
      '2. Summarize the synthesized visual atmosphere, semantic color palette, typography hierarchy, key component archetypes, and the generated `.design/references/<slug>/DESIGN.md` path.',
    );
  }

  return steps.join('\n');
}
