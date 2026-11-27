import { open } from 'node:fs/promises';
import {
  described,
  integer,
  projectPath,
  stringField,
  workflowPlugin,
} from '../workflow-runtime/index.js';
import { decodePng } from '../workflow-runtime/png.js';

async function png(root: string, path: unknown) {
  const file = await open(projectPath(root, path), 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 20_000_000) throw new Error('Screenshot exceeds 20 MB');
    return decodePng(await file.readFile());
  } finally {
    await file.close();
  }
}
export default workflowPlugin({
  name: 'visual-regression-reviewer',
  description:
    'Compares decoded PNG screenshot pixels and reports changed-pixel ratios and a bounding rectangle with explicit tolerance',
  tools: [
    {
      name: 'visual_regression_compare',
      description:
        'Compare baseline and current 8-bit RGB/RGBA PNGs. tolerance is per-channel 0..255; maxChangedPixels is the allowed pixel count. Size changes always fail.',
      properties: {
        baseline: described(stringField, 'Project-relative baseline PNG.'),
        current: described(stringField, 'Project-relative PNG compared against the baseline.'),
        tolerance: {
          type: 'integer',
          minimum: 0,
          maximum: 255,
          description: 'Per-channel difference still counted as unchanged (default 0).',
        },
        maxChangedPixels: {
          type: 'integer',
          minimum: 0,
          description: 'Changed pixels allowed before the comparison fails (default 0).',
        },
      },
      required: ['baseline', 'current'],
      async run(input, context) {
        const baseline = await png(context.root, input.baseline);
        const current = await png(context.root, input.current);
        const tolerance = integer(input.tolerance, 0, 0, 255);
        const allowed = integer(input.maxChangedPixels, 0, 0, 16_000_000);
        if (baseline.width !== current.width || baseline.height !== current.height)
          return {
            passed: false,
            reason: 'dimensions-changed',
            baseline: { width: baseline.width, height: baseline.height },
            current: { width: current.width, height: current.height },
          };
        let changedPixels = 0;
        let left = baseline.width;
        let top = baseline.height;
        let right = -1;
        let bottom = -1;
        for (let y = 0; y < baseline.height; y++)
          for (let x = 0; x < baseline.width; x++) {
            const offset = (y * baseline.width + x) * 4;
            if (
              [0, 1, 2, 3].some(
                (channel) =>
                  Math.abs(baseline.pixels[offset + channel]! - current.pixels[offset + channel]!) >
                  tolerance,
              )
            ) {
              changedPixels++;
              left = Math.min(left, x);
              right = Math.max(right, x);
              top = Math.min(top, y);
              bottom = Math.max(bottom, y);
            }
          }
        return {
          passed: changedPixels <= allowed,
          changedPixels,
          ratio: changedPixels / (baseline.width * baseline.height),
          tolerance,
          bounds: changedPixels
            ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
            : null,
        };
      },
    },
  ],
});
