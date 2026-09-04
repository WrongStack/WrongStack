import { hello } from './src/greet.js';

if (hello('world') !== 'hello world') {
  console.error('expected hello("world") === "hello world"');
  process.exit(1);
}
