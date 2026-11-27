import { pathToFileURL } from 'node:url';
import {
  described,
  parseJsonReport,
  projectPath,
  run,
  stringField,
  workflowPlugin,
} from '../workflow-runtime/index.js';
export default workflowPlugin({
  name: 'plugin-workbench',
  description:
    'Loads a built plugin in a bounded child-process harness and measures duplicate tool registration, hook cleanup and setup/teardown lifecycle behavior',
  tools: [
    {
      name: 'plugin_workbench_run',
      mutating: true,
      description:
        'Load a local built ESM plugin with a default export into a mocked host. Setup twice then teardown, report duplicate registrations and remaining hooks. Plugin code executes with user permissions; this is not an OS sandbox.',
      properties: {
        path: described(
          stringField,
          'Project-relative built ESM plugin file with a default export.',
        ),
      },
      required: ['path'],
      async run(input, context) {
        const url = pathToFileURL(projectPath(context.root, input.path)).href;
        const script = `const {default:plugin}=await import(${JSON.stringify(url)});const tools=new Map();const registrations=[];const duplicates=[];const track=()=>{const item={live:true};registrations.push(item);return()=>{item.live=false;};};const log={info(){},warn(){},error(){},debug(){}};const api={config:{extensions:{}},log,metrics:{counter(){},gauge(){},histogram(){}},tools:{register(t){if(tools.has(t.name))duplicates.push(t.name);tools.set(t.name,t);},unregister(n){tools.delete(n);},get(n){return tools.get(n);},list(){return [...tools.values()];}},registerHook:track,onEvent:track,onPattern:track,onConfigChange:track,registerSystemPromptContributor:track,emitCustom(){},events:{on:track,emit(){}},extensions:{register:track},session:{append:async()=>{}},slashCommands:{register(){},unregister(){}},providers:{list(){return[];}},mcp:{list(){return[];}},pipelines:{},container:{}};
try{await plugin.setup(api);const first=[...tools.keys()];tools.clear();await plugin.setup(api);const afterReload=registrations.filter(r=>r.live).length;await plugin.teardown?.(api);const leaked=registrations.filter(r=>r.live).length;console.log(JSON.stringify({name:plugin.name,firstTools:first,reloadTools:[...tools.keys()],duplicates,afterReload,leaked,passed:duplicates.length===0&&leaked===0}));}catch(error){console.error(String(error));process.exitCode=1;}`;
        const execution = await run(
          {
            program: process.execPath,
            args: ['--input-type=module', '-e', script],
            timeoutMs: 15000,
          },
          context,
        );
        return {
          execution,
          report: execution.passed ? parseJsonReport(execution.stdout) : null,
          limitation:
            'Mock host covers registration lifecycle, not full production tool execution or provider behavior.',
        };
      },
    },
  ],
});
