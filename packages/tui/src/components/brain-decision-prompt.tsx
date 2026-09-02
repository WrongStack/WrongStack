import { Box, Text, useInput } from '../ink.js';
import type React from 'react';

export interface BrainDecisionPromptOption {
  id: string;
  label: string;
  risk?: 'low' | 'medium' | 'high' | 'critical' | string | undefined;
  consequence?: string | undefined;
  recommended?: boolean | undefined;
}

interface BrainDecisionPromptProps {
  requestId: string;
  source: string;
  risk: 'low' | 'medium' | 'high' | 'critical' | string;
  question: string;
  context?: string | undefined;
  options?: BrainDecisionPromptOption[] | undefined;
  onAnswer?: (answer: {
    id: string;
    optionId?: string | undefined;
    deny?: boolean | undefined;
    text?: string | undefined;
  }) => void;
}

function riskColor(risk: string): string {
  switch (risk) {
    case 'low':
      return 'green';
    case 'medium':
      return 'cyan';
    case 'high':
      return 'yellow';
    case 'critical':
      return 'red';
    default:
      return 'white';
  }
}

function optionKey(index: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + index);
}

function contextLines(context?: string): { kept: string[]; dropped: number } {
  if (!context?.trim()) return { kept: [], dropped: 0 };
  const all = context.trim().split('\n');
  return { kept: all.slice(0, 5), dropped: Math.max(0, all.length - 5) };
}

/**
 * Brain escalation panel. It renders the options and, when `onAnswer` is wired,
 * maps A/B/C (or 1/2/3) to the matching option and Esc/D to a safe denial.
 */
export function BrainDecisionPrompt({
  requestId,
  source,
  risk,
  question,
  context,
  options = [],
  onAnswer,
}: BrainDecisionPromptProps): React.ReactElement {
  const color = riskColor(risk);
  const { kept: ctx, dropped } = contextLines(context);

  useInput((input, key) => {
    if (!onAnswer) return;
    if (key.escape || input.toLowerCase() === 'd') {
      onAnswer({ id: requestId, deny: true, text: 'Denied by human from TUI.' });
      return;
    }
    const ch = input.toLowerCase();
    const index = ch >= 'a' && ch <= 'z' ? ch.charCodeAt(0) - 'a'.charCodeAt(0) : Number(ch) - 1;
    const option = Number.isInteger(index) && index >= 0 ? options[index] : undefined;
    if (option) onAnswer({ id: requestId, optionId: option.id, text: option.label });
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Box flexDirection="row">
        <Text bold color="magenta">
          🧠 BRAIN REQUIRES HUMAN DECISION
        </Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        <Text dimColor>Source:</Text>
        <Text>{source}</Text>
        <Text dimColor>Risk:</Text>
        <Text color={color}>{risk}</Text>
      </Box>
      <Text color="white">{question}</Text>
      {ctx.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Context:</Text>
          {ctx.map((line, index) => (
            <Text key={index} dimColor>
              {line}
            </Text>
          ))}
          {dropped > 0 ? <Text dimColor>… ({dropped} more)</Text> : null}
        </Box>
      ) : null}
      {options.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Options:</Text>
          {options.slice(0, 6).map((option, index) => {
            const key = optionKey(index);
            const optionColor = riskColor(String(option.risk ?? risk));
            return (
              <Box key={option.id} flexDirection="column">
                <Text>
                  <Text bold color="yellow">
                    [{key}]
                  </Text>{' '}
                  <Text color={optionColor}>{option.label}</Text>
                  {option.recommended ? <Text color="green"> recommended</Text> : null}
                </Text>
                {option.consequence ? <Text dimColor> {option.consequence}</Text> : null}
              </Box>
            );
          })}
        </Box>
      ) : null}
      <Text dimColor>─────────────────</Text>
      <Text dimColor>Press A/B/C or 1/2/3 to answer; Esc or D denies with the safe default.</Text>
    </Box>
  );
}
