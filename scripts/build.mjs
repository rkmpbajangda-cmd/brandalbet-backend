import { mkdir, rm } from 'node:fs/promises';
import { zipFunctions } from '@netlify/zip-it-and-ship-it';
await rm('.netlify/validation-functions', { recursive: true, force: true });
await mkdir('.netlify/validation-functions', { recursive: true });
const functions = await zipFunctions('netlify/functions', '.netlify/validation-functions', {
  config: { '*': { nodeBundler: 'esbuild', nodeVersion: '22' } },
});
if (functions.length !== 1 || functions[0].name !== 'health') {
  throw new Error('Expected exactly one deployable function: health');
}
console.log('Netlify bundling passed: health (Node.js 22, esbuild).');
