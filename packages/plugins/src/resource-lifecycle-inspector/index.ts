import { pathToFileURL } from 'node:url';
import {
  integer,
  projectPath,
  run,
  stringField,
  workflowPlugin,
} from '../workflow-runtime/index.js';
import { timerTrackingScript } from './timer-tracking-script.js';
export default workflowPlugin({
  name: 'resource-lifecycle-inspector',
  description:
    'Runs a JavaScript lifecycle fixture repeatedly in a child process and compares observable active resource counts after each cleanup against its baseline',
  tools: [
    {
      name: 'resource_lifecycle_inspect',
      mutating: true,
      description:
        'Import a local .mjs fixture exporting async start() and stop(handle). Runs cycles and reports retained observable resources after settling; fixture code executes with your user permissions.',
      properties: {
        fixture: stringField,
        cycles: { type: 'integer', minimum: 1, maximum: 50 },
        settleMs: { type: 'integer', minimum: 1, maximum: 2000 },
      },
      required: ['fixture'],
      async run(input, context) {
        const fixture = pathToFileURL(projectPath(context.root, input.fixture)).href;
        const count = integer(input.cycles, 3, 1, 50);
        const settle = integer(input.settleMs, 50, 1, 2000);
        const script = `${timerTrackingScript}
const f=await import(${JSON.stringify(fixture)}); if(typeof f.start!=='function'||typeof f.stop!=='function')throw Error('Fixture must export start and stop');
const sleep=()=>new Promise(r=>rawTimeout(r,${settle})); const sample=()=>{const counts={};for(const k of process.getActiveResourcesInfo())counts[k]=(counts[k]||0)+1;const tracked=trackedTimers();if(tracked)counts.Timeout=Math.max(counts.Timeout||0,tracked);return counts;};
await sleep(); const baseline=sample();const cycles=[];for(let i=0;i<${count};i++){let handle;try{handle=await f.start();}finally{await f.stop(handle);}await sleep();cycles.push(sample());}
const retained=cycles.map(counts=>Object.fromEntries(Object.entries(counts).filter(([k,v])=>v>(baseline[k]||0)).map(([k,v])=>[k,v-(baseline[k]||0)])));const report=JSON.stringify({baseline,cycles,retained,passed:retained.every(r=>Object.keys(r).length===0)});process.stdout.write(report+'\\n',()=>process.exit(0));`;
        const execution = await run(
          {
            program: process.execPath,
            args: ['--input-type=module', '-e', script],
            timeoutMs: 30000,
          },
          context,
        );
        let report = null;
        if (execution.passed) report = JSON.parse(execution.stdout.trim().split(/\r?\n/).at(-1)!);
        return {
          execution,
          report,
          limitation: process.versions.bun
            ? 'Counts global timers and resources reported by Bun; does not cover arbitrary heap retention, timers imported from node:timers, or native resources invisible to Bun.'
            : 'Counts active Node resources; does not measure arbitrary heap retention or native resources invisible to Node.',
        };
      },
    },
  ],
});
