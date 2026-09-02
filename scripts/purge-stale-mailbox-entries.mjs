#!/usr/bin/env node
/**
 * One-shot purge of stale mailbox client and agent registry entries.
 *
 * The project mailbox server is the sole persistence owner. This maintenance
 * command therefore uses the public IPC-backed mailbox API instead of reading
 * or rewriting legacy registry files.
 *
 * Usage:
 *   node scripts/purge-stale-mailbox-entries.mjs [project-slug]
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { getSharedProjectMailbox, projectSlug } from '../packages/core/dist/index.js';

const AGENT_PURGE_MS = 3_600_000;
const slug = process.argv[2] || projectSlug(process.cwd());
const projectDir = join(homedir(), '.wrongstack', 'projects', slug);
const mailbox = getSharedProjectMailbox(projectDir);

console.log(`Project dir: ${projectDir}`);

try {
  await mailbox.initialize();
  const [clientsBefore, agentsBefore] = await Promise.all([
    mailbox.getClientStatuses(),
    mailbox.getAgentStatuses(),
  ]);
  const [clientsRemoved, agentsRemoved] = await Promise.all([
    mailbox.purgeClients(),
    mailbox.purgeAgents(AGENT_PURGE_MS),
  ]);
  console.log(`  Clients: ${clientsBefore.length} (${clientsRemoved} removed)`);
  console.log(`  Agents: ${agentsBefore.length} (${agentsRemoved} removed)`);
  console.log('Done.');
} finally {
  await mailbox.close();
}
