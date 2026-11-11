export type DesktopDesignWorkflow = 'extract' | 'materialize-web' | 'materialize-rn';

function designSource(source: string) {
  const trimmed = source.trim();
  const isHttp = /^https?:\/\//i.test(trimmed);
  const isLocal =
    !isHttp &&
    (/\.html?$/i.test(trimmed) ||
      trimmed.startsWith('./') ||
      trimmed.startsWith('../') ||
      trimmed.startsWith('/') ||
      /^[a-zA-Z]:[\\/]/.test(trimmed));
  return { target: isLocal || isHttp ? trimmed : `https://${trimmed}`, isLocal };
}

export function buildDesktopDesignPrompt(options: {
  source: string;
  maxPages: number;
  workflow: DesktopDesignWorkflow;
}): string {
  const { target, isLocal } = designSource(options.source);
  const arg = isLocal
    ? `file: ${JSON.stringify(target)}`
    : `url: ${JSON.stringify(target)}, maxPages: ${options.maxPages}`;
  const lines = [
    `Extract the Design DNA and full 10-section DESIGN.md specification from ${target}:`,
    `1. Call \`design_reference\` with \`{ action: "extract", ${arg} }\`.`,
    '2. Summarize the measured palette, typography scale, elevation/gradients, and component tokens written to `.design/references/<slug>/DESIGN.md`.',
  ];
  if (options.workflow !== 'extract') {
    const stack = options.workflow === 'materialize-rn' ? 'react-native' : 'web';
    lines.push(
      `3. Use the actual DESIGN.md path reported by extraction in \`design { action: "capture", files: [".design/references/<slug>/DESIGN.md"] }\`, then \`design { action: "materialize", stack: "${stack}" }\` to generate the ${stack} theme. Report the generated file path.`,
      'A pinned kit takes precedence over captured tokens. If a kit is pinned, keep it intact and explain the conflict before materializing; never label kit output as extracted tokens.',
    );
  }
  return lines.join('\n');
}

export function buildDesktopDesignReviewPrompt(
  options:
    | { action: 'inspect'; target: string; surface: 'page' | 'app' }
    | { action: 'compare'; target: string; reference: string },
): string {
  const { target, isLocal } = designSource(options.target);
  const args = {
    action: options.action,
    ...(isLocal ? { file: target } : { url: target }),
    ...(options.action === 'inspect'
      ? { surface: options.surface }
      : { reference: options.reference.trim() }),
  };
  return [
    `Run \`design_reference\` with \`${JSON.stringify(args)}\`.`,
    'Report the measured results, viewport widths, and saved report path. Call out any limitations in the measurement.',
  ].join('\n');
}
