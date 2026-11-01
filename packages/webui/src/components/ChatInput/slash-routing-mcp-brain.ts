import { safeId } from '@/lib/utils';
import { openMainView } from '@/lib/view-navigation';
import type { ChatAssistantMessage, SlashRoutingClient } from './slash-routing-types.js';

/** `/mcp [resources|prompts|read|get|tools|call] …` — MCP servers, content and tool use. */
export function runMcpSlashCommand(
  args: string,
  client: SlashRoutingClient | null | undefined,
  addMessage: (message: ChatAssistantMessage) => void,
): boolean {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const action = parts[0];
  const server = parts[1];
  if ((action === 'resources' || action === 'prompts') && server) {
    client?.send?.({
      type: action === 'resources' ? 'mcp.resources' : 'mcp.prompts',
      payload: { name: server, refresh: parts.includes('--refresh') },
    });
    addMessage({ role: 'assistant', content: `Fetching MCP ${action} from **${server}**…` });
    return true;
  }
  if (action === 'tools' && server) {
    client?.send?.({ type: 'mcp.tools', payload: { name: server } });
    addMessage({ role: 'assistant', content: `Listing MCP tools on **${server}**…` });
    return true;
  }
  if (action === 'call' && server && parts[2]) {
    // Everything after the tool name is its JSON input; none means `{}`.
    const rawInput = args.trim().replace(/^call\s+\S+\s+\S+\s*/, '');
    let input: unknown = {};
    try {
      if (rawInput) input = JSON.parse(rawInput);
    } catch {
      input = undefined;
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      addMessage({
        role: 'assistant',
        content: 'MCP tool input must be a JSON object, for example `{"query":"text"}`.',
      });
      return true;
    }
    const payload = {
      requestId: safeId(),
      name: server,
      tool: parts[2],
      input: input as Record<string, unknown>,
    };
    client?.send?.({ type: 'mcp.tool.call', payload: client.withSession?.(payload) ?? payload });
    addMessage({
      role: 'assistant',
      content: `Running MCP tool **${parts[2]}** on **${server}** in this conversation…`,
    });
    return true;
  }
  if (action === 'read' && server && parts[2]) {
    client?.send?.({ type: 'mcp.resource.read', payload: { name: server, uri: parts[2] } });
    addMessage({
      role: 'assistant',
      content: `Reading selected MCP resource from **${server}**…`,
    });
    return true;
  }
  if (action === 'get' && server && parts[2]) {
    const promptArgs: Record<string, string> = {};
    for (const token of parts.slice(3)) {
      const separator = token.indexOf('=');
      if (separator <= 0) {
        addMessage({
          role: 'assistant',
          content: `Invalid MCP prompt argument \`${token}\`; expected \`key=value\`.`,
        });
        return true;
      }
      promptArgs[token.slice(0, separator)] = token.slice(separator + 1);
    }
    client?.send?.({
      type: 'mcp.prompt.get',
      payload: { name: server, prompt: parts[2], arguments: promptArgs },
    });
    addMessage({
      role: 'assistant',
      content: `Getting selected MCP prompt from **${server}**…`,
    });
    return true;
  }
  if (action) {
    addMessage({
      role: 'assistant',
      content:
        'Usage: `/mcp resources <server>`, `/mcp prompts <server>`, `/mcp read <server> <uri>`, `/mcp get <server> <prompt> [key=value...]`, `/mcp tools <server>`, or `/mcp call <server> <tool> [JSON input]`.',
    });
    return true;
  }
  client?.send?.({ type: 'mcp.list' });
  openMainView('settings');
  addMessage({
    role: 'assistant',
    content:
      '🖥️ **MCP Servers** — settings opened to the MCP tab.\n\nConfigure, enable/disable, or restart servers from the MCP section.',
  });
  return true;
}

/** `/brain [risk <level>|ask <question>]` — mirrors the CLI's /brain (status by default). */
export function runBrainSlashCommand(
  args: string,
  client: SlashRoutingClient | null | undefined,
  addMessage: (message: ChatAssistantMessage) => void,
): boolean {
  // Mirrors the CLI's /brain: status (default), risk <level>, ask <question>.
  const [sub, ...rest] = args.split(/\s+/).filter(Boolean);
  const subcmd = (sub ?? '').toLowerCase();
  if (subcmd === 'risk') {
    const level = (rest[0] ?? '').toLowerCase();
    const valid = ['off', 'low', 'medium', 'high', 'all'];
    if (!level) {
      addMessage({
        role: 'assistant',
        content: `Usage: \`/brain risk <level>\` — one of: ${valid.map((m) => `\`${m}\``).join(', ')}.`,
      });
      return true;
    }
    if (!valid.includes(level)) {
      addMessage({
        role: 'assistant',
        content: `Unknown risk level \`${level}\`. Try: ${valid.join(', ')}.`,
      });
      return true;
    }
    // Name the tab: the Brain answers `/brain` about the asking session's
    // own decisions, and stamps its reply so the right lane receives it.
    client?.send?.({
      type: 'brain.risk',
      payload: client.withSession?.({ level }) ?? { level },
    });
    addMessage({ role: 'assistant', content: `🧠 Brain — risk → **${level}**.` });
  } else if (subcmd === 'ask') {
    const question = rest.join(' ').trim();
    if (!question) {
      addMessage({ role: 'assistant', content: 'Usage: `/brain ask <question>`' });
    } else {
      client?.send?.({
        type: 'brain.ask',
        payload: client.withSession?.({ question }) ?? { question },
      });
    }
  } else {
    client?.send?.({ type: 'brain.status', payload: client.withSession?.({}) ?? {} });
  }
  return true;
}
