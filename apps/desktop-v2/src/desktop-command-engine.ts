import { brainAnswerText } from './BrainDecisions';
import { configDoctorReport } from './ConfigDoctor';
import {
  type DesktopCommandContext,
  type DesktopCommandOutcome,
  HANDLED,
  refused,
  request,
} from './desktop-command-context';
import { sessionTodos, todoProgress } from './SessionTodos';
import { downloadSkillFile } from './skill-model';
import { transcriptFileName, transcriptMarkdown, transcriptTitle } from './transcript-export';

const OPERATION = ['key.operation_result'];
const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** `/working-dir [path]`: where this conversation's tools run, or move them inside the project. */
export function runWorkingDir(argument: string, context: DesktopCommandContext) {
  if (argument)
    return request(context, 'working_dir.set', { path: argument }, OPERATION, (reply) =>
      text(reply['message']) ? `${text(reply['message'])}.` : `Working directory → ${argument}.`,
    );
  const { results } = context.state;
  const cwd =
    text(results['working_dir.changed']?.['cwd']) || text(results['session.start']?.['cwd']);
  context.notify(
    cwd
      ? `Working directory: ${cwd}. Use /working-dir <path> to change it.`
      : 'The working directory is not known yet. Use /working-dir <path> to set it.',
  );
  return HANDLED;
}

/** `/browser [args]`: the project's private-origin policy for browser and fetch tools. */
export function runBrowser(argument: string, context: DesktopCommandContext) {
  if (!argument) {
    context.navigate({ settings: 'tool-access' });
    return HANDLED;
  }
  return request(
    context,
    'browser.policy',
    { args: argument },
    ['browser.policy.result'],
    (reply) => text(reply['message']).trim() || 'Browser policy updated.',
  );
}

/** `/doctor [fix]`: open the configuration check, or repair the profile and say what changed. */
export function runDoctor(argument: string, context: DesktopCommandContext) {
  const wanted = argument.toLowerCase();
  if (!wanted) {
    context.navigate({ settings: 'health' });
    return HANDLED;
  }
  if (wanted !== 'fix') return refused('Use /doctor to check the configuration, or /doctor fix.');
  return request(context, 'config.doctor', { apply: true }, ['config.doctor.result'], (reply) => {
    const report = configDoctorReport(reply);
    if (!report.applied)
      return 'The profile configuration matches the defaults; nothing to repair.';
    const count = report.changes.length;
    const backup = report.backupPath ? ` The old file is at ${report.backupPath}.` : '';
    return `Repaired ${count} setting${count === 1 ? '' : 's'} in the profile configuration.${backup}`;
  });
}

const RISK_LEVELS = ['off', 'low', 'medium', 'high', 'all'];

/** `/brain [risk <level>|ask <question>]`: Brain settings, its risk ceiling, or a question. */
export function runBrain(argument: string, context: DesktopCommandContext) {
  const [sub = '', ...rest] = argument.split(/\s+/).filter(Boolean);
  const subcommand = sub.toLowerCase();
  if (!subcommand) {
    context.navigate({ settings: 'brain' });
    return HANDLED;
  }
  if (subcommand === 'risk') {
    const level = (rest[0] ?? '').toLowerCase();
    if (!RISK_LEVELS.includes(level))
      return refused(`Use /brain risk <level>, one of ${RISK_LEVELS.join(', ')}.`);
    return request(
      context,
      'brain.risk',
      { level },
      ['brain.status', ...OPERATION],
      () => `Brain risk ceiling → ${level}.`,
    );
  }
  if (subcommand === 'ask' && rest.length) {
    const question = rest.join(' ');
    return request(
      context,
      'brain.ask',
      { question },
      ['brain.answer', ...OPERATION],
      (reply) => `Brain · ${brainAnswerText(reply)}`,
    );
  }
  return refused('Use /brain, /brain risk <level> or /brain ask <question>.');
}

/** `/mcp [tools <server>]`: the connected tools settings, or one server's tool names. */
export function runMcp(argument: string, context: DesktopCommandContext) {
  const [sub = '', server, ...rest] = argument.split(/\s+/).filter(Boolean);
  if (!sub) {
    context.navigate({ settings: 'integrations' });
    return HANDLED;
  }
  if (sub.toLowerCase() !== 'tools' || !server || rest.length)
    return refused(
      'Use /mcp to manage servers, or /mcp tools <server>. Run a server’s tools, prompts and resources from the composer’s MCP menu.',
    );
  return request(
    context,
    'mcp.tools',
    { name: server },
    ['mcp.tools', 'mcp.content.error'],
    (reply) => {
      const tools = Array.isArray(reply['tools']) ? reply['tools'] : [];
      const names = tools
        .map((tool) => text((tool as Record<string, unknown>)['name']))
        .filter(Boolean);
      return names.length
        ? `${server} offers ${names.length} tool${names.length === 1 ? '' : 's'}: ${names.join(', ')}.`
        : `${server} offers no tools.`;
    },
  );
}

/** `/save`: conversations save as they go; the engine confirms this one is on disk. */
export function runSave(context: DesktopCommandContext) {
  return request(context, 'session.save', {}, OPERATION, (reply) =>
    text(reply['message']) ? `${text(reply['message'])}.` : 'This conversation is saved.',
  );
}

/** `/todos [clear]`: the agent's todo list for this conversation, or empty it. */
export function runTodos(argument: string, context: DesktopCommandContext) {
  const wanted = argument.toLowerCase();
  if (wanted === 'clear')
    return request(context, 'todos.clear', {}, OPERATION, () => 'Todo list cleared.');
  if (wanted) return refused('Use /todos to see the todo list, or /todos clear.');
  const todos = sessionTodos(context.state.results['todos.updated']);
  context.notify(
    todos.length ? `Todo list: ${todoProgress(todos)}.` : 'This conversation has no todo list.',
  );
  return HANDLED;
}

/** `/next [n …|clear]`: list the suggested next steps, or send the numbered ones. */
export function runNext(argument: string, context: DesktopCommandContext): DesktopCommandOutcome {
  const steps = context.state.nextSteps;
  const wanted = argument.toLowerCase();
  if (!steps.length) {
    context.notify('No suggested next steps. Use /suggest to ask for some.');
    return HANDLED;
  }
  if (!wanted || wanted === 'list' || wanted === 'ls' || wanted === 'show') {
    const list = steps.map((step, index) => `${index + 1}. ${step.text}`).join(' · ');
    context.notify(`Suggested next steps: ${list}. Use /next <n> to send one.`);
    return HANDLED;
  }
  const parts = wanted.split(/[\s,]+/).filter(Boolean);
  const numbers = parts.map((part) => (/^\d+$/.test(part) ? Number.parseInt(part, 10) : 0));
  if (numbers.some((number) => number < 1))
    return refused('Use /next to list the suggestions, or /next <n> [n …] to send them.');
  const outside = numbers.filter((number) => number > steps.length);
  if (outside.length)
    return refused(`No suggestion ${outside.join(', ')}; the list runs 1–${steps.length}.`);
  const chosen = [...new Set(numbers)].map((number) => steps[number - 1]?.text ?? '');
  return { kind: 'submit', text: chosen.join('\n') };
}

/** `/export`: download this conversation as Markdown. */
export function runExport(context: DesktopCommandContext) {
  const { messages } = context.state;
  if (!messages.length) {
    context.notify('There is nothing to export yet.');
    return HANDLED;
  }
  const exportedAt = new Date().toISOString();
  const start = context.state.results['session.start'];
  const folder = text(start?.['projectRoot']) || text(start?.['cwd']);
  const name = transcriptFileName(folder, exportedAt);
  const markdown = transcriptMarkdown(transcriptTitle(folder), messages, exportedAt);
  downloadSkillFile(markdown, name, 'text/markdown');
  context.notify(`Saved ${name} to your downloads folder.`);
  return HANDLED;
}
