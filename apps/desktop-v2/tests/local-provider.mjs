import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// An isolated loopback protocol fixture, never an external LLM or a real credential.
export const fixtureKey = 'desktop-fixture-key-not-a-real-secret-7654';
export const fixtureModel = 'desktop-fixture-model';
export function nativeComposerCalls(calls) {
  return calls.filter(
    (call) =>
      call.stream &&
      !call.refiner &&
      call.instructionMarkers?.some((marker) => marker.startsWith('[native-composer-')),
  );
}
export const fixtureText = 'Native provider connection verified.';
export const fixtureMarkdown = `${fixtureText}

## Native result

- **Desktop** owns the conversation.
- Read the [project README](README.md).
- Read a [project note](native-notes.md).

| Surface | Result |
| --- | --- |
| Native chat | Pass |

\`\`\`ts
const native = true;
\`\`\`

[Blocked script](javascript:alert(1))

![Diagram](https://example.invalid/diagram.png)

<script>window.nativeUnsafeScriptRan = true</script>`;
export const inputFixture = {
  title: 'Native project decisions',
  submitLabel: 'Apply decisions',
  tabs: [
    {
      id: 'build',
      label: 'Build',
      questions: [
        {
          id: 'stack',
          question: 'Choose a stack',
          type: 'single_select',
          options: [
            { id: 'native', label: 'Native' },
            { id: 'react', label: 'React' },
          ],
          recommendedOption: 'native',
          recommendationReason: 'Keep the project in desktop.',
        },
        {
          id: 'features',
          question: 'Choose features',
          type: 'multi_select',
          options: [
            { id: 'terminal', label: 'Terminal' },
            { id: 'chat', label: 'Chat' },
            { id: 'git', label: 'Git' },
          ],
          recommendedOptions: ['terminal'],
        },
      ],
    },
    {
      id: 'delivery',
      label: 'Delivery',
      questions: [
        {
          id: 'notes',
          question: 'Release notes',
          type: 'text',
          required: true,
          placeholder: 'Describe the native release.',
        },
      ],
    },
  ],
};
export async function startLocalProvider({ models = [fixtureModel] } = {}) {
  const acceptedModels = new Set(models);
  const calls = [];
  const toolResults = [];
  const holds = new Map();
  const canceledHolds = new Set();
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            object: 'list',
            data: [...acceptedModels].map((id) => ({
              id,
              object: 'model',
              owned_by: 'desktop-test',
            })),
          }),
        );
        return;
      }
      let raw = '';
      for await (const part of request) {
        raw += part;
        if (raw.length > 8 * 1024 * 1024) throw new Error('Fixture request too large');
      }
      const body = JSON.parse(raw || '{}');
      const userTexts = (body.messages ?? [])
        .filter((m) => m.role === 'user')
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
      const refiner = (body.messages ?? []).some(
        (m) => m.role === 'system' && String(m.content).includes('You are a request refiner'),
      );
      const topicAdvisor = (body.messages ?? []).some(
        (m) =>
          m.role === 'system' &&
          String(m.content).includes('You classify whether a new user prompt belongs'),
      );
      const topicPrompt = topicAdvisor ? (userTexts.at(-1)?.split('NEW PROMPT:').at(-1) ?? '') : '';
      const composerPrompt = topicAdvisor
        ? ''
        : (userTexts.findLast((text) => /\[native-composer-/.test(text)) ?? '');
      // Engine notes can quote earlier prompts inside a multimodal message.
      // Only a literal current instruction may activate this fixture's hold.
      const composerInstruction =
        (body.messages ?? [])
          .filter((message) => message.role === 'user')
          .flatMap((message) =>
            typeof message.content === 'string'
              ? [message.content]
              : (message.content ?? [])
                  .filter((part) => part.type === 'text')
                  .map((part) => part.text ?? ''),
          )
          .findLast(
            (text) =>
              /^\[native-composer-/.test(text.trim()) ||
              text.includes('[native-composer-nextstep-selected]'),
          ) ?? '';
      const answer = topicAdvisor
        ? JSON.stringify({
            decision: /new topic|yeni konu/i.test(topicPrompt) ? 'new_context' : 'same_context',
            confidence: 0.99,
            reason: 'The isolated fixture identified a different goal.',
            nextTopic: 'Native topic boundary proof',
          })
        : refiner
          ? 'Build the desktop composer and preserve the requested session boundaries.\n---\nImplement the desktop composer while keeping the requested session boundaries.'
          : composerInstruction.trim().startsWith('[native-composer-nextsteps]')
            ? `${fixtureMarkdown}\n\n<nextsteps>\n1. [native-composer-nextstep-selected] Inspect the result\n2. Run the checks\n</nextsteps>`
            : fixtureMarkdown;
      calls.push({
        path: request.url,
        authorized: request.headers.authorization === `Bearer ${fixtureKey}`,
        model: body.model,
        stream: body.stream,
        refiner,
        topicAdvisor,
        instructionMarkers: [...new Set(composerInstruction.match(/\[native-[^\]]+\]/g) ?? [])],
        kanbanContext: (body.messages ?? []).some(
          (message) =>
            message.role === 'system' && /kanban|task execution/i.test(String(message.content)),
        ),
        freshTopicContext: (body.messages ?? []).some((m) =>
          String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).includes(
            '[context_boundary:',
          ),
        ),
        topicSameMarker: userTexts.some((text) => text.includes('[native-composer-topic-same]')),
        composerPrompt,
        reasoningEffort: body.reasoning_effort,
        profilePolicyDraft: userTexts.some((text) =>
          text.includes('[native-profile-policy-draft]'),
        ),
      });
      assert.equal(request.url, '/v1/chat/completions');
      assert.ok(acceptedModels.has(body.model), 'The request must use a configured fixture model');
      assert.ok(calls.at(-1).authorized, 'The encrypted saved key must reach the local provider');
      const common = {
        id: `desktop-fixture-response-${calls.length}`,
        created: Math.floor(Date.now() / 1000),
        model: body.model,
      };
      const usagePrompt =
        !refiner && !topicAdvisor
          ? (userTexts.findLast((text) => /^\[native-usage-(cold|warm)\]/.test(text.trim())) ?? '')
          : '';
      const usageCase = usagePrompt.startsWith('[native-usage-warm]')
        ? 'warm'
        : usagePrompt.startsWith('[native-usage-cold]')
          ? 'cold'
          : undefined;
      calls.at(-1).usageCase = usageCase;
      const usage =
        usageCase === 'warm'
          ? {
              prompt_tokens: 600,
              completion_tokens: 20,
              total_tokens: 620,
              prompt_tokens_details: { cached_tokens: 480 },
            }
          : { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 };
      // The real engine may append a context note as a user-role message after
      // tool output. Find the actual test prompt rather than that generated note.
      const lastUser =
        body.messages?.findLastIndex(
          (message) =>
            message.role === 'user' &&
            typeof message.content === 'string' &&
            /\[native-clarify-(?:submit|cancel)\]/.test(message.content),
        ) ?? -1;
      const content = String(body.messages?.[lastUser]?.content ?? '');
      const challenge = content.includes('[native-clarify-submit]')
        ? 'submit'
        : content.includes('[native-clarify-cancel]')
          ? 'cancel'
          : null;
      const toolReply = challenge
        ? body.messages.slice(lastUser + 1).find((message) => message.role === 'tool')
        : undefined;
      if (toolReply) toolResults.push({ challenge, content: toolReply.content });
      const needsForm = challenge && !toolReply;
      if (needsForm)
        assert.ok(
          body.tools?.some((tool) => tool.function?.name === 'clarify'),
          'Real clarify tool must be offered by the engine',
        );
      const approvalUser =
        body.messages?.findLastIndex(
          (message) =>
            message.role === 'user' &&
            typeof message.content === 'string' &&
            /^\[native-composer-approval-(allow|deny|remember|again)\]/.test(
              message.content.trim(),
            ),
        ) ?? -1;
      const approvalChallenge =
        approvalUser < 0
          ? null
          : body.messages[approvalUser].content.match(
              /\[native-composer-approval-(allow|deny|remember|again)\]/,
            )?.[1];
      const approvalId = `desktop-approval-${approvalChallenge}`;
      const approvalReply =
        approvalChallenge &&
        body.messages
          .slice(approvalUser + 1)
          .find((message) => message.role === 'tool' && message.tool_call_id === approvalId);
      if (approvalReply)
        toolResults.push({
          challenge: `approval-${approvalChallenge}`,
          content: approvalReply.content,
        });
      const needsApproval = approvalChallenge && !approvalReply;
      const mcpTaskUser =
        body.messages?.findLastIndex(
          (message) =>
            message.role === 'user' &&
            (typeof message.content === 'string'
              ? [message.content]
              : (message.content ?? [])
                  .filter((part) => part.type === 'text')
                  .map((part) => part.text ?? '')
            ).some((text) => /^\[native-mcp-task-(start|recover|input)\]/.test(text.trim())),
        ) ?? -1;
      const mcpTaskCallId = `native-mcp-task-call-${mcpTaskUser}`;
      const mcpTaskReply =
        mcpTaskUser >= 0 &&
        body.messages
          .slice(mcpTaskUser + 1)
          .find((message) => message.role === 'tool' && message.tool_call_id === mcpTaskCallId);
      const needsMcpTask = !refiner && !topicAdvisor && mcpTaskUser >= 0 && !mcpTaskReply;
      if (needsMcpTask)
        assert.ok(
          body.tools?.some((tool) => tool.function?.name === 'mcp__native_tasks__build'),
          'The real MCP task tool must be offered by the engine',
        );
      if (mcpTaskReply) toolResults.push({ challenge: 'mcp-task', content: mcpTaskReply.content });
      const processUser =
        body.messages?.findLastIndex(
          (message) =>
            message.role === 'user' &&
            (typeof message.content === 'string'
              ? [message.content]
              : (message.content ?? [])
                  .filter((part) => part.type === 'text')
                  .map((part) => part.text ?? '')
            ).some((text) => text.trim().startsWith('[native-process-start]')),
        ) ?? -1;
      const processCallId = `native-process-call-${processUser}`;
      const processReply =
        processUser >= 0 &&
        body.messages
          .slice(processUser + 1)
          .find((message) => message.role === 'tool' && message.tool_call_id === processCallId);
      const needsProcess = !refiner && !topicAdvisor && processUser >= 0 && !processReply;
      if (needsProcess)
        assert.ok(
          body.tools?.some((tool) => tool.function?.name === 'bash'),
          'The real background shell tool must be offered',
        );
      // An editing Code Assist run writes one known file through the real write tool.
      const assistEditUser =
        body.messages?.findLastIndex(
          (message) =>
            message.role === 'user' &&
            (typeof message.content === 'string'
              ? [message.content]
              : (message.content ?? [])
                  .filter((part) => part.type === 'text')
                  .map((part) => part.text ?? '')
            ).some((text) => text.includes('[native-code-assist-edit]')),
        ) ?? -1;
      const assistEditCallId = `native-code-assist-edit-${assistEditUser}`;
      const assistEditReply =
        assistEditUser >= 0 &&
        body.messages
          .slice(assistEditUser + 1)
          .find((message) => message.role === 'tool' && message.tool_call_id === assistEditCallId);
      const needsAssistEdit = !refiner && !topicAdvisor && assistEditUser >= 0 && !assistEditReply;
      if (needsAssistEdit)
        assert.ok(
          body.tools?.some((tool) => tool.function?.name === 'write'),
          'The editing Code Assist run must be offered the real write tool',
        );
      if (assistEditReply)
        toolResults.push({ challenge: 'code-assist-edit', content: assistEditReply.content });
      if (needsApproval)
        assert.ok(
          body.tools?.some((tool) => tool.function?.name === 'exec'),
          'Real exec tool must be offered by the engine',
        );
      const toolCall = needsForm
        ? {
            index: 0,
            id: `desktop-clarify-${challenge}`,
            type: 'function',
            function: {
              name: 'clarify',
              arguments: JSON.stringify(
                challenge === 'submit'
                  ? inputFixture
                  : {
                      title: 'Native optional decision',
                      question: 'Should this request continue?',
                      options: ['Continue', 'Stop'],
                    },
              ),
            },
          }
        : needsApproval
          ? {
              index: 0,
              id: approvalId,
              type: 'function',
              function: {
                name: 'exec',
                arguments: JSON.stringify({
                  command: 'git',
                  args:
                    approvalChallenge === 'allow' || approvalChallenge === 'deny'
                      ? ['config', '--local', 'desktopfixture.first', 'yes']
                      : ['config', '--local', 'desktopfixture.second', 'yes'],
                  cwd: '.',
                }),
              },
            }
          : needsMcpTask
            ? {
                index: 0,
                id: mcpTaskCallId,
                type: 'function',
                function: { name: 'mcp__native_tasks__build', arguments: '{}' },
              }
            : needsProcess
              ? {
                  index: 0,
                  id: processCallId,
                  type: 'function',
                  function: {
                    name: 'bash',
                    arguments: JSON.stringify({
                      command: `"${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -Command "Write-Output 'native-process-output-ready'; Start-Sleep -Seconds 240"`,
                      background: true,
                      hermetic: true,
                    }),
                  },
                }
              : needsAssistEdit
                ? {
                    index: 0,
                    id: assistEditCallId,
                    type: 'function',
                    function: {
                      name: 'write',
                      arguments: JSON.stringify({
                        path: 'README.md',
                        content: '# Native Code Assist edit\n',
                      }),
                    },
                  }
                : undefined;
      if (!body.stream) {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            ...common,
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: toolCall
                  ? { role: 'assistant', content: null, tool_calls: [toolCall] }
                  : { role: 'assistant', content: answer },
                finish_reason: toolCall ? 'tool_calls' : 'stop',
              },
            ],
            usage,
          }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const chunk = (choices, extra = {}) =>
        response.write(
          `data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices, ...extra })}\n\n`,
        );
      if (toolCall) {
        chunk([
          { index: 0, delta: { role: 'assistant', tool_calls: [toolCall] }, finish_reason: null },
        ]);
        chunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }], { usage });
        response.end('data: [DONE]\n\n');
        return;
      }
      chunk([
        {
          index: 0,
          delta: { role: 'assistant', content: refiner || topicAdvisor ? '' : 'Native provider ' },
          finish_reason: null,
        },
      ]);
      const hold =
        !refiner && composerInstruction.trim().match(/^\[native-composer-hold-([a-z]+)\]/)?.[1];
      if (hold) {
        await new Promise((resolve) => {
          holds.set(hold, resolve);
          response.once('close', () => {
            if (!response.writableEnded) canceledHolds.add(hold);
            holds.delete(hold);
            resolve();
          });
        });
        holds.delete(hold);
        if (response.destroyed) return;
      }
      chunk([
        {
          index: 0,
          delta: { content: answer.slice(refiner || topicAdvisor ? 0 : 'Native provider '.length) },
          finish_reason: null,
        },
      ]);
      chunk([{ index: 0, delta: {}, finish_reason: 'stop' }], { usage });
      response.end('data: [DONE]\n\n');
    } catch (error) {
      response.statusCode = 400;
      response.end(
        JSON.stringify({ error: { message: error.message, type: 'desktop_fixture_error' } }),
      );
    }
  });
  server.requestTimeout = 15000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    calls,
    toolResults,
    holds,
    canceledHolds,
    releaseHold: (name) => holds.get(name)?.(),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
