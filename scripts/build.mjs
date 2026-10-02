import { mkdir, rm } from 'node:fs/promises';
import { zipFunctions } from '@netlify/zip-it-and-ship-it';

await rm('.netlify/validation-functions', { recursive: true, force: true });
await mkdir('.netlify/validation-functions', { recursive: true });

const functions = await zipFunctions('netlify/functions', '.netlify/validation-functions', {
  config: { '*': { nodeBundler: 'esbuild', nodeVersion: '22' } },
});

const actual = functions.map((item) => item.name).sort();
const expected = [
  'backoffice-health',
  'backoffice-payment-connections',
  'backoffice-promotions',
  'backoffice-readiness',
  'bootstrap-superadmin',
  'game-launch',
  'games',
  'health',
  'me',
  'member-bank-account',
  'member-onboarding',
  'member-profile',
  'member-session',
  'promotions',
  'transactions',
  'wallet',
];
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error('Unexpected deployable functions: ' + actual.join(', '));
}
console.log('Netlify bundling passed: ' + actual.join(', ') + ' (Node.js 22, esbuild).');

