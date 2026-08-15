import type { AgentPipelines, UserInputPayload } from '@wrongstack/core/agent';
import type { Middleware } from '@wrongstack/core/kernel';
import type { Response, TextBlock } from '@wrongstack/core/types';
import { hasVibeTag } from '@wrongstack/requirement-intake';
import {
  auditVibeExecution,
  buildCoderContract,
  formatVibeReport,
  synthesizeVibeSpec,
  type VibeCoderContract,
  type VibeSpecSynthesizerResult,
  type VibeVerificationReport,
} from '@wrongstack/sdd';

export const VIBE_PROTOCOL_META_KEY = 'vibeProtocol';

interface ActiveVibeRun {
  rawPrompt: string;
  spec: VibeSpecSynthesizerResult;
  coder: VibeCoderContract;
  ctx: UserInputPayload['ctx'];
}

function formatCoderInput(spec: VibeSpecSynthesizerResult, coder: VibeCoderContract): string {
  return [
    '[vibe_protocol]',
    'The user explicitly requested the VIBE three-stage verification protocol.',
    'Implement the request using the synthesized specification and coder contract below.',
    'Do not merely describe the contract: perform the requested work, verify it, and report the result.',
    '',
    spec.formattedSpecMarkdown,
    '',
    '## Coder Contract',
    ...coder.instructions.map((instruction) => `- ${instruction}`),
    '[/vibe_protocol]',
  ].join('\n');
}

/**
 * Installs the VIBE protocol on the shared Agent pipelines used by CLI, TUI,
 * WebUI, and single-shot runs. A tagged user turn receives the synthesized spec
 * and coder contract before the model runs; the first final text response is
 * then audited and receives the durable three-stage report.
 */
export function installVibeProtocol(pipelines: AgentPipelines): void {
  let active: ActiveVibeRun | undefined;

  const userInput: Middleware<UserInputPayload> = {
    name: 'VibeProtocolInput',
    owner: 'cli',
    async handler(payload, next) {
      active = undefined;
      delete payload.ctx.meta[VIBE_PROTOCOL_META_KEY];
      if (!hasVibeTag(payload.text)) return next(payload);

      const rawPrompt = payload.text;
      const spec = synthesizeVibeSpec(rawPrompt);
      const coder = buildCoderContract(spec);
      const contractBlock: TextBlock = { type: 'text', text: formatCoderInput(spec, coder) };
      payload.content = [...payload.content, contractBlock];
      payload.text = `${payload.text}\n\n${contractBlock.text}`;
      active = { rawPrompt, spec, coder, ctx: payload.ctx };
      payload.ctx.meta[VIBE_PROTOCOL_META_KEY] = {
        isVibeMode: true,
        stage: 'coder',
        synthesizer: spec,
        coder,
      };
      return next(payload);
    },
  };

  const response: Middleware<Response> = {
    name: 'VibeProtocolAuditor',
    owner: 'cli',
    async handler(value, next) {
      const run = active;
      if (!run || value.content.some((block) => block.type === 'tool_use')) return next(value);

      const coderOutput = value.content
        .filter((block): block is TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
      if (!coderOutput) return next(value);

      const audit = auditVibeExecution({
        rawPrompt: run.rawPrompt,
        spec: run.spec,
        coderOutput,
      });
      const markdown = formatVibeReport(run.rawPrompt, run.spec, run.coder, audit);
      const report: VibeVerificationReport = {
        isVibeMode: true,
        stage: audit.verdict === 'PASS' ? 'passed' : 'auditor',
        synthesizer: run.spec,
        coder: run.coder,
        audit,
        markdown,
      };
      active = undefined;
      run.ctx.meta[VIBE_PROTOCOL_META_KEY] = report;

      return next({
        ...value,
        content: [...value.content, { type: 'text', text: `\n\n${markdown}` }],
      });
    },
  };

  pipelines.userInput.use(userInput);
  pipelines.response.use(response);
}
