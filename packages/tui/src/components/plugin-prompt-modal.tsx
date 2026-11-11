import type { PluginPromptOptions } from '@wrongstack/contracts/types/plugin';
import type React from 'react';
import { useState } from 'react';
import { Box, Text, useInput } from '../ink.js';
import { sanitizeTerminalText } from '../terminal-width.js';

export interface PluginPromptModalProps {
  owner: string;
  opts: PluginPromptOptions<string>;
  onResolve: (value: string | boolean | null) => void;
}

export function PluginPromptModal({
  owner,
  opts,
  onResolve,
}: PluginPromptModalProps): React.ReactElement {
  const options = opts.options ?? [];
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [confirmChoice, setConfirmChoice] = useState(true);
  const [textValue, setTextValue] = useState('');

  useInput((input, key) => {
    if (key.escape) {
      onResolve(null);
      return;
    }

    if (opts.kind === 'confirm') {
      if (key.leftArrow || key.rightArrow || key.tab) {
        setConfirmChoice((prev) => !prev);
        return;
      }
      if (input === 'y' || input === 'Y') {
        onResolve(true);
        return;
      }
      if (input === 'n' || input === 'N') {
        onResolve(false);
        return;
      }
      if (key.return) {
        onResolve(confirmChoice);
      }
      return;
    }

    if (opts.kind === 'select') {
      if (options.length === 0) {
        if (key.return) onResolve(null);
        return;
      }
      if (key.upArrow) {
        setSelectedIndex((prev) => (prev - 1 + options.length) % options.length);
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((prev) => (prev + 1) % options.length);
        return;
      }
      if (key.return) {
        const picked = options[selectedIndex];
        onResolve(picked ? picked.value : null);
      }
      return;
    }

    // kind === 'input'
    if (key.return) {
      onResolve(textValue);
      return;
    }
    if (key.backspace || key.delete) {
      setTextValue((prev) => prev.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      const clean = sanitizeTerminalText(input).replace(/[\r\n]/gu, '');
      if (clean) {
        setTextValue((prev) => (prev + clean).slice(0, 512));
      }
    }
  });

  const safeOwner = sanitizeTerminalText(owner);
  const safeTitle = sanitizeTerminalText(opts.title);
  const safeMessage = opts.message ? sanitizeTerminalText(opts.message) : undefined;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          {`[${safeOwner}] ${safeTitle}`}
        </Text>
        <Text dimColor>{'Esc cancel'}</Text>
      </Box>
      {safeMessage ? <Text>{safeMessage}</Text> : null}

      {opts.kind === 'confirm' ? (
        <Box marginTop={1} gap={2}>
          <Text bold={confirmChoice} color={confirmChoice ? 'green' : undefined}>
            {confirmChoice ? '● [Yes] (y)' : '○  Yes  (y)'}
          </Text>
          <Text bold={!confirmChoice} color={!confirmChoice ? 'yellow' : undefined}>
            {!confirmChoice ? '● [No] (n)' : '○  No  (n)'}
          </Text>
        </Box>
      ) : opts.kind === 'select' ? (
        <Box flexDirection="column" marginTop={1}>
          {options.length === 0 ? (
            <Text dimColor>{'No options provided (Enter/Esc to close)'}</Text>
          ) : (
            options.slice(0, 12).map((opt, idx) => {
              const active = idx === selectedIndex;
              return (
                <Text key={`${opt.value}-${idx}`} color={active ? 'cyan' : undefined} bold={active}>
                  {`${active ? '❯ ' : '  '}${sanitizeTerminalText(opt.label)}`}
                  {opt.hint ? <Text dimColor>{` — ${sanitizeTerminalText(opt.hint)}`}</Text> : null}
                </Text>
              );
            })
          )}
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color="cyan">{'> '}</Text>
            <Text>{textValue}</Text>
            <Text inverse> </Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}
