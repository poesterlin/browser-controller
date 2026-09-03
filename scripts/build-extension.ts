import { mkdir, cp, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'extension');
const output = path.join(root, 'dist', 'extension');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of [
  'manifest.json',
  'background.js',
  'command-cache.js',
  'control-tab.js',
  'async.js',
  'scrape-archive.js',
  'content.js',
  'options.html',
  'options.js',
  'popup.html',
  'popup.js',
]) {
  await cp(path.join(source, file), path.join(output, file));
}
await cp(path.join(source, 'vendor'), path.join(output, 'vendor'), { recursive: true });
console.log(`Built unpacked extension: ${output}`);
