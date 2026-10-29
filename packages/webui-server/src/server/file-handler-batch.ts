/**
 * Multi-item file moves and deletions that apply all or nothing.
 *
 *   files.move_many   { items: [{ from, to }] }          → files.moved_many
 *   files.delete_many { filePaths, recursive? }           → files.deleted_many
 *
 * Every item is checked before anything changes (inside the project, not the root, source
 * present, target absent with an existing parent folder, no two items overlapping). The renames
 * then run in order; if one fails, the ones already done are renamed back in reverse order.
 * Deletion first renames every item into one staging folder in the project root (same
 * filesystem, so each step is a rename) and removes that folder only after all of them moved.
 * Another process can still change the files while the batch runs; this is not a lock.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { WebSocket } from 'ws';
import { resolveFileInsideProject, withSessionEcho } from './file-handler-helpers.js';
import { isPathInside, isSamePath } from './path-containment.js';
import { errMessage, messageSessionId, send } from './ws-utils.js';

export const MAX_BATCH_ITEMS = 500;

interface Step {
  from: string;
  to: string;
}

/** Same item, or one inside the other. */
function overlaps(a: string, b: string): boolean {
  return isSamePath(a, b) || isPathInside(a, b) || isPathInside(b, a);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch {
    return false;
  }
}

/** Renames in order; on a failure, renames the completed ones back and rethrows. */
async function renameAll(steps: readonly Step[]): Promise<void> {
  const done: Step[] = [];
  try {
    for (const step of steps) {
      await fs.rename(step.from, step.to);
      done.push(step);
    }
  } catch (error) {
    const unrestored: string[] = [];
    for (const step of done.reverse()) {
      try {
        await fs.rename(step.to, step.from);
      } catch {
        unrestored.push(step.from);
      }
    }
    throw Error(
      unrestored.length
        ? `${errMessage(error)}. These items could not be put back: ${unrestored.join(', ')}.`
        : `${errMessage(error)}. Nothing was changed.`,
    );
  }
}

function payloadOf(msg: unknown): Record<string, unknown> {
  const payload = (msg as { payload?: unknown }).payload;
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

async function resolveSource(projectRoot: string, realRoot: string, file: string) {
  const real = await resolveFileInsideProject(projectRoot, file);
  if (isSamePath(real, realRoot)) throw Error('The project root cannot be moved or deleted.');
  if (!(await exists(real))) throw Error(`${file} does not exist.`);
  return real;
}

export async function handleFilesMoveMany(
  ws: WebSocket,
  msg: unknown,
  projectRoot: string,
): Promise<void> {
  const sessionId = messageSessionId(msg as { payload?: unknown });
  const raw = payloadOf(msg)['items'];
  const reply = (body: Record<string, unknown>) =>
    send(ws, { type: 'files.moved_many', payload: withSessionEcho(body, sessionId) });
  try {
    if (
      !Array.isArray(raw) ||
      raw.length === 0 ||
      raw.length > MAX_BATCH_ITEMS ||
      raw.some(
        (item) =>
          !item ||
          typeof item !== 'object' ||
          typeof (item as Step).from !== 'string' ||
          typeof (item as Step).to !== 'string' ||
          !(item as Step).from.trim() ||
          !(item as Step).to.trim(),
      )
    )
      throw Error(`Send 1 to ${MAX_BATCH_ITEMS} items, each with a source and a target path.`);
    const items = raw as Step[];
    const realRoot = await fs.realpath(projectRoot);
    const steps: Step[] = [];
    for (const item of items) {
      const from = await resolveSource(projectRoot, realRoot, item.from);
      const to = await resolveFileInsideProject(projectRoot, item.to);
      if (await exists(to)) throw Error(`${item.to} already exists.`);
      const parent = await fs.stat(path.dirname(to)).catch(() => undefined);
      if (!parent?.isDirectory()) throw Error(`The folder for ${item.to} does not exist.`);
      steps.push({ from, to });
    }
    for (const [index, step] of steps.entries()) {
      if (isPathInside(step.from, step.to) && !isSamePath(step.from, step.to))
        throw Error(`${items[index]!.from} cannot move into itself.`);
      for (const other of steps.slice(index + 1))
        if (overlaps(step.from, other.from) || overlaps(step.to, other.to))
          throw Error('Two items overlap or would reach the same place.');
      if (steps.some((other) => other !== step && overlaps(step.to, other.from)))
        throw Error('A target is another selected item; move them in separate steps.');
    }
    await renameAll(steps);
    reply({ success: true, items: items.map(({ from, to }) => ({ from, to })) });
  } catch (error) {
    reply({ success: false, error: errMessage(error) });
  }
}

export async function handleFilesDeleteMany(
  ws: WebSocket,
  msg: unknown,
  projectRoot: string,
): Promise<void> {
  const sessionId = messageSessionId(msg as { payload?: unknown });
  const payload = payloadOf(msg);
  const raw = payload['filePaths'];
  const recursive = payload['recursive'] === true;
  const reply = (body: Record<string, unknown>) =>
    send(ws, { type: 'files.deleted_many', payload: withSessionEcho(body, sessionId) });
  try {
    if (
      !Array.isArray(raw) ||
      raw.length === 0 ||
      raw.length > MAX_BATCH_ITEMS ||
      raw.some((item) => typeof item !== 'string' || !item.trim())
    )
      throw Error(`Send 1 to ${MAX_BATCH_ITEMS} file paths.`);
    const filePaths = raw as string[];
    const realRoot = await fs.realpath(projectRoot);
    const sources: string[] = [];
    for (const file of filePaths) {
      const real = await resolveSource(projectRoot, realRoot, file);
      const stat = await fs.lstat(real);
      if (stat.isDirectory() && !recursive && (await fs.readdir(real)).length > 0)
        throw Error(`${file} is a folder that is not empty.`);
      sources.push(real);
    }
    for (const [index, source] of sources.entries())
      if (sources.slice(index + 1).some((other) => overlaps(source, other)))
        throw Error('Two selected items overlap; select only the outer folder.');
    const staging = path.join(realRoot, `.wrongstack-delete-${randomBytes(6).toString('hex')}`);
    await fs.mkdir(staging);
    try {
      await renameAll(
        sources.map((from, index) => ({ from, to: path.join(staging, String(index)) })),
      );
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    let leftover: string | undefined;
    try {
      await fs.rm(staging, { recursive: true, force: false });
    } catch {
      leftover = path.relative(realRoot, staging);
    }
    reply({
      success: true,
      filePaths,
      ...(leftover
        ? {
            warning: `The items were removed from their places, but ${leftover} could not be emptied.`,
          }
        : {}),
    });
  } catch (error) {
    reply({ success: false, error: errMessage(error) });
  }
}
