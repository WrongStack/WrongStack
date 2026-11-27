import { localUrl } from '../workflow-runtime/http.js';
import {
  described,
  integer,
  parseJsonReport,
  rows,
  run,
  str,
  stringField,
  strings,
  workflowPlugin,
} from '../workflow-runtime/index.js';
export default workflowPlugin({
  name: 'responsive-journey-tester',
  description:
    'Runs explicit Playwright browser journeys at selected viewport sizes and checks required controls for visibility, reachability and horizontal overflow',
  tools: [
    {
      name: 'responsive_journey_test',
      mutating: true,
      description:
        'Requires locally installed playwright and Chromium. Navigate a loopback URL, run steps [{action:click|fill|press,selector,value?}], then check selectors at every viewport [{width,height}].',
      properties: {
        url: described(stringField, 'Loopback URL (127.0.0.1 or [::1]) to open.'),
        viewports: {
          type: 'array',
          items: { type: 'object' },
          description: '1..10 sizes {width, height}, each 200..4000 px.',
        },
        steps: {
          type: 'array',
          items: { type: 'object' },
          description:
            'Up to 30 steps {action: click|fill|press, selector, value?}, run before the checks.',
        },
        selectors: {
          type: 'array',
          items: stringField,
          description:
            'CSS selectors checked at every viewport for visibility, reachability and horizontal overflow.',
        },
      },
      required: ['url', 'viewports', 'steps', 'selectors'],
      async run(input, context) {
        const url = localUrl(input.url).href;
        const viewports = rows(input.viewports).map((item) => ({
          width: integer(item.width, 390, 200, 4000),
          height: integer(item.height, 844, 200, 4000),
        }));
        if (!viewports.length || viewports.length > 10) throw new Error('Provide 1..10 viewports');
        const steps = rows(input.steps);
        if (steps.length > 30) throw new Error('At most 30 journey steps');
        for (const step of steps) {
          if (!['click', 'fill', 'press'].includes(str(step.action)))
            throw new Error('Unknown action');
          str(step.selector);
          if (step.action !== 'click') str(step.value);
        }
        const selectors = strings(input.selectors);
        if (!selectors.length) throw new Error('At least one required control selector is needed');
        const data = JSON.stringify({ url, viewports, steps, selectors });
        const script = `const {chromium}=(()=>{try{return require('playwright');}catch{return require('@playwright/test');}})();const input=${data}; (async()=>{const browser=await chromium.launch({headless:true}); const results=[];try{for(const viewport of input.viewports){const page=await browser.newPage({viewport});page.setDefaultTimeout(5000);await page.route('**/*',route=>{const u=new URL(route.request().url());return ['127.0.0.1','[::1]'].includes(u.hostname)?route.continue():route.abort();});try{await page.goto(input.url);for(const step of input.steps){const element=page.locator(step.selector);await element[step.action](...(step.action==='click'?[]:[step.value]));}const controls=[];for(const selector of input.selectors){const element=page.locator(selector);const count=await element.count();const visible=count===1&&await element.isVisible();let reachable=false;let bounds=null;if(visible){const initial=await element.boundingBox();const horizontal=!!initial&&initial.x>=0&&initial.x+initial.width<=viewport.width;await element.scrollIntoViewIfNeeded();bounds=await element.boundingBox();reachable=horizontal&&!!bounds&&bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=viewport.width&&bounds.y+bounds.height<=viewport.height;}controls.push({selector,visible,reachable,bounds});}const overflow=await page.evaluate(()=>Math.max(document.documentElement.scrollWidth,document.body?.scrollWidth||0)>window.innerWidth);results.push({viewport,controls,overflow,passed:!overflow&&controls.every(c=>c.visible&&c.reachable)});}catch(error){results.push({viewport,passed:false,error:String(error)});}finally{await page.close();}}}finally{await browser.close();}console.log(JSON.stringify({passed:results.every(r=>r.passed),results}));})().catch(error=>{console.error(String(error));process.exitCode=1;});`;
        const execution = await run(
          { program: process.execPath, args: ['-e', script], timeoutMs: 120000 },
          context,
        );
        return {
          execution,
          report: execution.passed ? parseJsonReport(execution.stdout) : null,
        };
      },
    },
  ],
});
