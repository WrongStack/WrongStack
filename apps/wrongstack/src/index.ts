#!/usr/bin/env node
import { installBrokenPipeHandlers, main } from '@wrongstack/cli';

installBrokenPipeHandlers();
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 200).unref();
  },
  (err: unknown) => {
    const e = err as { stack?: string } | undefined;
    console.error(e?.stack ?? err);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 200).unref();
  },
);
