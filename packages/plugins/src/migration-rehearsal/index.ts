import {
  described,
  parseJsonReport,
  read,
  run,
  stringField,
  workflowPlugin,
} from '../workflow-runtime/index.js';
export default workflowPlugin({
  name: 'migration-rehearsal',
  description:
    'Rehearses SQLite up/down migrations in a fresh in-memory database and compares schema and data snapshots before and after rollback',
  tools: [
    {
      name: 'migration_rehearse',
      mutating: true,
      description:
        'Execute seed, up and optional down SQL files against an in-memory SQLite database in a child process. Requires Node with node:sqlite. SQL ATTACH and extension loading are not permitted.',
      properties: {
        seed: described(
          stringField,
          'Project-relative SQL file that builds the starting schema and data.',
        ),
        up: described(stringField, 'Project-relative SQL file of the forward migration.'),
        down: described(
          stringField,
          'Project-relative SQL file of the rollback. When given, the result says whether it restores the seed state.',
        ),
      },
      required: ['seed', 'up'],
      async run(input, context) {
        const seed = await read(context.root, input.seed);
        const up = await read(context.root, input.up);
        const down = input.down === undefined ? null : await read(context.root, input.down);
        for (const sql of [seed, up, down ?? ''])
          if (/\b(?:attach|detach|load_extension|vacuum)\b/i.test(sql))
            throw new Error(
              'Only self-contained in-memory SQL is allowed (no ATTACH, DETACH, extensions or VACUUM)',
            );
        const script = `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(':memory:',{allowExtension:false});
const snapshot=()=>{const schema=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(); return {schema,rows:Object.fromEntries(schema.map(t=>[t.name,db.prepare('SELECT * FROM "'+t.name.replaceAll('"','""')+'"').all().map(r=>JSON.stringify(r)).sort()]))};};
try { db.exec(${JSON.stringify(seed)}); const before=snapshot(); db.exec(${JSON.stringify(up)}); const after=snapshot(); let rolledBack=null; ${down === null ? '' : `db.exec(${JSON.stringify(down)}); rolledBack=snapshot();`} console.log(JSON.stringify({before,after,rolledBack,rollbackMatches:rolledBack===null?null:JSON.stringify(before)===JSON.stringify(rolledBack)})); } finally {db.close();}`;
        const execution = await run({ program: process.execPath, args: ['-e', script] }, context);
        return {
          dialect: 'sqlite',
          isolation: 'in-memory-child-process',
          execution,
          report: execution.passed ? parseJsonReport(execution.stdout) : null,
          limitation:
            'SQLite only. This does not validate PostgreSQL/MySQL dialects or production-scale locking.',
        };
      },
    },
  ],
});
