import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
if (process.versions.node.split('.')[0] !== '22') {
  throw new Error('Node.js 22 is required.');
}
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await check(path);
    else if (/\.m?js$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  }
}
for (const directory of ['cloudflare/functions', 'src', 'tests', 'scripts']) await check(directory);
console.log('Syntax validation passed on Node.js 22.');
