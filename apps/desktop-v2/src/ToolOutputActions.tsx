import { Download } from 'lucide-react';
import { CopyButton } from './CopyButton';

/** The exit code a shell-style result ends with ("exit code: 1", "[exit 1]"), as the WebUI reads it. */
function toolExitCode(output: string): number | undefined {
  const match = output.match(/(?:^|\n)\s*(?:\[?exit(?:\s*code)?\]?\s*[:=]?\s*)(\d+)\s*\]?\s*$/i);
  return match ? Number(match[1]) : undefined;
}

/** A file name for a tool's saved output: the tool's name, safe for any file system. */
function outputFileName(tool: string): string {
  const base = tool.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'tool';
  return `${base}-output.txt`;
}

/**
 * Beside a tool call's output, as the WebUI's tool cards have them: its exit code when it ends
 * with one, Copy, and Save as a text file. Copy and Save take the output the engine reported,
 * which may be a preview of a longer result.
 */
export function ToolOutputActions({ tool, output }: { tool: string; output: string }) {
  const exit = toolExitCode(output);
  return (
    <span className="tool-output-actions">
      {exit !== undefined && (
        <small className={exit === 0 ? 'tool-exit ok' : 'tool-exit failed'}>exit code {exit}</small>
      )}
      <CopyButton text={output} label="Copy output" />
      <button
        type="button"
        className="copy-button"
        title="Save the output as a text file"
        onClick={() => {
          const url = URL.createObjectURL(new Blob([output], { type: 'text/plain;charset=utf-8' }));
          const link = document.createElement('a');
          link.href = url;
          link.download = outputFileName(tool);
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}
      >
        <Download size={12} /> <span>Save</span>
      </button>
    </span>
  );
}
