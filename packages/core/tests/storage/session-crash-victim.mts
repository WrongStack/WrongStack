// Spawned as a real process, then SIGKILLed. Writes a realistic turn and
// deliberately never exits cleanly.
import { DefaultSessionStore } from '../../src/storage/session-store.js';

const dir = process.argv[2]!;
const store = new DefaultSessionStore({ dir });
const w = await store.create({ id: 'crashme', model: 'glm-5.3', provider: 'zai' });
await w.append({ type: 'user_input', ts: new Date().toISOString(), content: 'do the thing' });
await w.writeCheckpoint(0, 'do the thing');
await w.writeInFlightMarker('iteration 0 / tool: read / id: tu-1');
await w.append({
  type: 'llm_response',
  ts: new Date().toISOString(),
  content: [{ type: 'tool_use', id: 'tu-1', name: 'read', input: { path: 'a.ts' } }],
  stopReason: 'tool_use',
  usage: { input: 100, output: 10, cacheRead: 5000 },
  model: 'glm-5.3',
  provider: 'zai',
});
// A non-critical event that rides the batched buffer — the one at risk.
await w.append({
  type: 'tool_call_start',
  ts: new Date().toISOString(),
  name: 'read',
  id: 'tu-1',
  input: {},
});
console.log('READY');
// Never resolve. The parent SIGKILLs us here: no flush, no session_end, no close.
await new Promise(() => {});
