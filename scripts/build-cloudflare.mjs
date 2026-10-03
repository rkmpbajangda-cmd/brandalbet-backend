import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
if (config.main !== 'cloudflare-worker.js') {
  throw new Error(`Unexpected Cloudflare entrypoint: ${config.main ?? 'missing'}`);
}

for (const file of ['cloudflare-worker.js', 'deno-server.js']) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
    process.exit(result.status || 1);
  }
}

console.log('Cloudflare build validation passed: entrypoint and adapter syntax are valid.');
